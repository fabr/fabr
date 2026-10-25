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
  DEPENDENCIES_KEY,
  OPTIONAL_PROVIDED_KEY,
  PROVIDED_KEY,
  Conflicts,
  NO_CONFLICTS,
  versionText,
  ResolvedNode,
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
const HEADINGS: ReadonlyMap<string, string> = new Map([
  [DEPENDENCIES_KEY, "deps"],
  [PROVIDED_KEY, "provided_deps"],
  [OPTIONAL_PROVIDED_KEY, "optional_provided_deps"],
]);

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
    return {
      title,
      parts: new Map(
        [...only.resolved.sources].map(([name, sources]): [string, Dependency[]] => [
          HEADINGS.get(name) ?? name,
          edgesOf(sources, only.resolved.references.get(name) ?? []),
        ])
      ),
      conflicts: only.resolved.conflicts,
    };
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
