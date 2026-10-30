/*
 * Copyright (c) 2026 Nathan Keynes <nkeynes@deadcoderemoval.net>
 *
 * This file is part of Fabr.
 *
 * Fabr is free software: you can redistribute it and/or modify it under the
 * terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * Fabr is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more
 * details.
 *
 * You should have received a copy of the GNU General Public License along with
 * Fabr. If not, see <https://www.gnu.org/licenses/>.
 */

import {
  Reference,
  Resolved,
  ResolvedRequirements,
  ResolvedTarget,
  isPackage,
  Package,
  nodeNaming,
  builtInProject,
  Dependency,
  dependencyName,
  requestedConstraint,
  Conflicts,
  NO_CONFLICTS,
  versionText,
  ResolvedNode,
  declName,
  FileSet,
  IModelStep,
  IPropertyDecl,
  IProvenanceStep,
  ITargetDecl,
  ITargetOrigin,
  MODEL_PROVENANCE,
  TARGET_PROVENANCE,
  TargetRef,
} from "@fabr-build/core";

/** What a line of the tree may be marked with, and what each mark means. */
const MARKERS = new Map([
  ["*", "subtree shown above"],
  ["p", "provided requirement, bound by the consumer"],
  ["n", "not installed"],
  ["!", "conflicting versions: refused where the target is built"],
]);

/** A painter that wraps `text` in an SGR code, or leaves it alone. */
export type Style = (code: string, text: string) => string;

const BOLD = "1";
const DIM = "2";
const RED = "31";
const YELLOW = "33";
/** The colour of a package built in this project. */
const LOCAL = "36";

/** Name one dependency for its line: a target's node as the reference to its
 * build, with the configuration that tells it from the target's other builds
 * (`lib<BUILD_TYPE=release>`), spelled as a conflict note spells one. */
function nameOf(dep: Dependency): string {
  const pkg = dep.package;
  if (pkg instanceof ResolvedNode && pkg.content.builds !== undefined && pkg.content.configuration) {
    return `${pkg.packageName}<${pkg.content.configuration}>`;
  }
  return pkg?.packageName ?? dep.reference.localName;
}

/** Label one dependency for its line: `name:requested -> selected`, the arrow
 *  only where the two differ, and the name alone where there is no version. */
function label(dep: Dependency, style: Style): string {
  const plain = nameOf(dep);
  const name = dep.package !== undefined && builtInProject(dep.package.origin) ? style(LOCAL, plain) : plain;
  const requested = requestedConstraint(dep.reference);
  const selected = dep.package?.version;
  if (selected === undefined || requested === selected) {
    return requested === undefined ? name : `${name}${style(DIM, ":")}${requested}`;
  }
  return requested === undefined ? `${name}${style(DIM, ":")}${selected}` : `${name}${style(DIM, `:${requested} ->`)} ${selected}`;
}

/** The heading each of a package's own requirements is printed under: the name
 * of the property that conventionally holds it. */

/** One name's tree: its sections, each the edges to the packages a
 * requirement holds, and the versions conflicting among them. */
export interface DependencyTree {
  readonly title: string;
  readonly parts: ReadonlyMap<string, ReadonlyArray<Dependency>>;
  /** The versions that conflict in what the name requires. */
  readonly conflicts?: Conflicts;
}

/** List the edges to the packages among `sources`, each with the reference it was
 * resolved for. */
function edgesOf(sources: ReadonlyArray<Resolved>, references: ReadonlyArray<Reference | undefined>): Dependency[] {
  return sources.flatMap((source, at): Dependency[] => {
    const reference = references[at];
    return isPackage(source) && reference !== undefined ? [{ reference, package: source }] : [];
  });
}

/**
 * Split what `target` requires into sections by where each source was written:
 * the target's own property it was read from (`deps`), or the rule, for what
 * the rule requires itself (`required by <type> rule`). What the target's rule
 * builds under the target's own name is part of the target, not something it
 * requires, and is left out. Each source is shown once.
 */
function requiredAsWritten(target: ResolvedTarget): Map<string, Dependency[]> {
  const decl = declOf(target.origin);
  const ruleSection = `required by ${decl?.type ?? "its"} rule`;
  const sections = new Map<string, { sources: Resolved[]; references: Array<Reference | undefined> }>();
  const seen = new Set<unknown>();
  const seenText = new Set<string>();
  const first = (source: Resolved): boolean => {
    if (source instanceof TargetRef) {
      const text = [source.toString(), ...source.projections.map(({ pattern, prefix }) => `${prefix} ${pattern.toString()}`)].join(":");
      if (seenText.has(text)) {
        return false;
      }
      seenText.add(text);
      return true;
    }
    if (seen.has(source)) {
      return false;
    }
    seen.add(source);
    return true;
  };
  for (const [name, sources] of target.resolved.sources) {
    const references = target.resolved.references.get(name) ?? [];
    sources.forEach((source, at) => {
      const partOfTarget = source instanceof ResolvedNode && source !== target && source.content.builds === target.content.builds;
      if (partOfTarget || !first(source)) {
        return;
      }
      const property = decl === undefined ? undefined : propertyOf(references[at] ?? source, decl);
      const section = property === undefined ? ruleSection : declName(property);
      const held = sections.get(section) ?? { sources: [], references: [] };
      held.sources.push(source);
      held.references.push(references[at]);
      sections.set(section, held);
    });
  }
  return new Map([...sections].map(([section, { sources, references }]) => [section, edgesOf(sources, references)]));
}

/** Get the declaration of the target whose node `origin` is the provenance of, if it is a target's. */
function declOf(origin: IProvenanceStep | undefined): ITargetDecl | undefined {
  for (let step = origin; step !== undefined; step = step.parent) {
    if (step.kind === TARGET_PROVENANCE) {
      return (step as ITargetOrigin).decl;
    }
  }
  return undefined;
}

/** Get the property of `decl` that `source` was read from, if it was read from one: the declaration on its first model step written in `decl`. */
function propertyOf(source: unknown, decl: ITargetDecl): IPropertyDecl | undefined {
  const inTarget = (step: IProvenanceStep): step is IModelStep => step.kind === MODEL_PROVENANCE && (step as IModelStep).target === decl;
  if (source instanceof Reference) {
    return source.steps.find(inTarget)?.property;
  }
  for (let step = source instanceof FileSet ? source.origin : undefined; step !== undefined; step = step.parent) {
    if (inTarget(step)) {
      return step.property;
    }
  }
  return undefined;
}

/**
 * Split what a name resolved to into the tree's sections. One target is shown
 * by what it requires, a section per requirement, with what conflicts there.
 * Anything else (an external requirement, a catalog member, a global naming
 * several things) is shown as what it names, in one unnamed section, with each
 * target among it as its node.
 */
export function sectionsOf(title: string, resolved: ResolvedRequirements): DependencyTree {
  const denoted = resolved.denoted;
  const [only] = denoted;
  if (denoted.length === 1 && only instanceof ResolvedTarget) {
    return { title, parts: requiredAsWritten(only), conflicts: only.resolved.conflicts };
  }
  return { title, parts: new Map([["", edgesOf(denoted, resolved.references.get("") ?? [])]]), conflicts: resolved.conflicts };
}

/** List `conflicts` as notes: each package and its conflicting versions, a
 * build as the reference to it. */
function conflictNotes(conflicts: Conflicts): string[] {
  return [...conflicts.versions]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([pkg, versions]) => `${pkg}: ${[...versions].map(version => versionText(version, pkg)).join(", ")}`);
}

/**
 * Render the dependency trees of what each `title` names: a block per title, a
 * section per requirement that holds a package, each package's
 * subtree expanded the first time it appears in the block and marked `(*)`
 * after. Requirements holding only files are left out, as are the files a projected
 * reference selects. A version conflicting in what the name requires is
 * marked `(!)`, and the conflicts are listed under the block. Ends with a legend for the marks used. `style`
 * paints the output for a terminal: packages built in the project stand out,
 * conflicts too, and the scaffolding recedes.
 */
export function renderDependencyTrees(blocks: ReadonlyArray<DependencyTree>, style: Style = (_code, text) => text): string[] {
  const lines: string[] = [];
  const used = new Set<string>();
  let locals = false;
  const marked = (text: string, ...marks: Array<string | false>): string => {
    const present = marks.filter((mark): mark is string => mark !== false);
    present.forEach(mark => used.add(mark));
    return [text, ...present.map(mark => style(mark === "n" ? YELLOW : mark === "!" ? RED : DIM, `(${mark})`))].join(" ");
  };
  blocks.forEach(({ title, parts, conflicts = NO_CONFLICTS }, index) => {
    const sections = [...parts].map(([name, roots]): [string, ReadonlyArray<Dependency>] => [name, roots]).filter(([, roots]) => roots.length > 0);
    const nodeOf = nodeNaming(sections.flatMap(([, roots]) => roots.flatMap(root => (root.package === undefined ? [] : [root.package]))));
    const shown = new Set<string>();
    const walk = (requirer: Package | undefined, deps: ReadonlyArray<Dependency>, indent: string): void => {
      deps.forEach((dep, at) => {
        const last = at === deps.length - 1;
        const pkg = dep.package;
        const provided = requirer !== undefined && requirer.provided.has(dependencyName(dep));
        const text = `${style(DIM, `${indent}${last ? "└── " : "├── "}`)}${label(dep, style)}`;
        if (pkg === undefined) {
          lines.push(marked(text, provided && "p", "n"));
          return;
        }
        locals ||= builtInProject(pkg.origin);
        const node = nodeOf(pkg);
        const repeated = shown.has(node);
        shown.add(node);
        lines.push(marked(text, provided && "p", conflicts.includes(pkg) && "!", repeated && pkg.dependencies.length > 0 && "*"));
        if (!repeated) {
          walk(pkg, pkg.dependencies, `${indent}${last ? "    " : "│   "}`);
        }
      });
    };
    lines.push(...(index > 0 ? [""] : []), style(BOLD, title));
    if (sections.length === 0) {
      lines.push(style(DIM, "No dependencies"));
    }
    for (const [name, roots] of sections) {
      lines.push(...(name === "" ? [] : [style(BOLD, name)]));
      walk(undefined, roots, "");
    }
    const notes = conflicts.size > 0 ? [`(!) conflicting in ${title}:`, ...conflictNotes(conflicts).map(note => `  ${note}`)] : [];
    if (notes.length > 0) {
      lines.push("", ...notes.map(note => style(RED, note)));
    }
  });
  const legend = [
    /* Only where the colour is there to explain. */
    ...(locals && style(LOCAL, "") !== "" ? [`${style(LOCAL, "name")} - built in this project`] : []),
    ...[...MARKERS].filter(([mark]) => used.has(mark)).map(([mark, meaning]) => `(${mark}) - ${meaning}`),
  ];
  if (legend.length > 0) {
    lines.push("", ...legend.map(line => style(DIM, line)));
  }
  return lines;
}
