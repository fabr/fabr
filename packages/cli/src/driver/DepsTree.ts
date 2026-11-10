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
  Advisory,
  compareText,
  edgesOf,
  requiredSources,
  AuditReport,
  fixedVersions,
  pathText,
  severityRank,
  vexText,
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

/** One name's tree: its sections, each the edges to the packages a
 * requirement holds, and the versions conflicting among them. */
export interface DependencyTree {
  readonly title: string;
  readonly parts: ReadonlyMap<string, ReadonlyArray<Dependency>>;
  /** The versions that conflict in what the name requires. */
  readonly conflicts?: Conflicts;
}

/**
 * Split what `target` requires into sections by where each source was written:
 * the target's own property it was read from (`deps`), or the rule, for what
 * the rule requires itself (`required by <type> rule`). What the target's rule
 * builds under the target's own name (a rule block's result, the target under
 * another operation) is part of the target, not something it requires: it is
 * shown by what it requires in turn, and what conflicts there is the target's
 * too. Each source is shown once.
 */
function requiredAsWritten(target: ResolvedTarget): { parts: Map<string, Dependency[]>; conflicts: Conflicts } {
  const { parts, required } = requiredSources(target);
  const sections = new Map<string, { sources: Resolved[]; references: Array<Reference | undefined> }>();
  for (const { part, source, reference } of required) {
    const decl = declOf(part.origin);
    const property = decl === undefined ? undefined : propertyOf(reference ?? source, decl);
    const section = property === undefined ? `required by ${decl?.type ?? "its"} rule` : declName(property);
    const held = sections.get(section) ?? { sources: [], references: [] };
    held.sources.push(source);
    held.references.push(reference);
    sections.set(section, held);
  }
  return {
    parts: new Map([...sections].map(([section, { sources, references }]) => [section, edgesOf(sources, references)])),
    conflicts: Conflicts.union(parts.map(part => part.resolved.conflicts)),
  };
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
  const inTarget = (step: IProvenanceStep): step is IModelStep =>
    step.kind === MODEL_PROVENANCE && (step as IModelStep).target === decl;
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
    return { title, ...requiredAsWritten(only) };
  }
  return { title, parts: new Map([["", edgesOf(denoted, resolved.references.get("") ?? [])]]), conflicts: resolved.conflicts };
}

/** List `conflicts` as notes: each package and its conflicting versions, a
 * build as the reference to it. */
function conflictNotes(conflicts: Conflicts): string[] {
  return [...conflicts.versions]
    .sort(([a], [b]) => compareText(a, b))
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
    const sections = [...parts]
      .map(([name, roots]): [string, ReadonlyArray<Dependency>] => [name, roots])
      .filter(([, roots]) => roots.length > 0);
    const nodeOf = nodeNaming(
      sections.flatMap(([, roots]) => roots.flatMap(root => (root.package === undefined ? [] : [root.package])))
    );
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

/** @return `n` with the form of a word for that many. */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Paint a severity for a terminal: the worst two red, the rest yellow. */
function severityStyle(advisory: Advisory, style: Style): string {
  const severity = advisory.severity ?? "";
  return style(severityRank(advisory) < 2 ? RED : YELLOW, severity);
}

/**
 * Render an audit report: a block per advisory — its id and aliases, the
 * database's rating and its summary, then each affected package with the
 * versions that fix it and a path the tree reaches it by, then each a patched
 * target fixes — and the count.
 * `style` paints the output for a terminal.
 */
export function renderAudit(report: AuditReport, style: Style = (_code, text) => text): string[] {
  const lines: string[] = [];
  for (const { advisory, packages, fixed, suppressed } of report.findings) {
    const title = [advisory.id, ...(advisory.aliases.length > 0 ? [style(DIM, `(${advisory.aliases.join(", ")})`)] : [])].join(" ");
    lines.push(
      [style(BOLD, title), ...(advisory.severity === undefined ? [] : [severityStyle(advisory, style)]), advisory.summary]
        .filter(part => part !== "")
        .join("  ")
    );
    for (const pkg of packages) {
      const versions = fixedVersions(advisory, pkg);
      const patched = pkg.patchedBy === undefined ? "" : ` as patched by '${pkg.patchedBy.target}'`;
      lines.push(`  ${pkg.packageName}@${pkg.version}${patched}${versions.length === 0 ? "" : style(DIM, `, fixed in ${versions.join(", ")}`)}`);
      pkg.paths.forEach(path => lines.push(style(DIM, `    ${pathText(path)}`)));
    }
    for (const pkg of fixed) {
      lines.push(`  ${pkg.packageName}@${pkg.version}${style(DIM, `, fixed by '${pkg.patchedBy!.target}'`)}`);
      pkg.paths.forEach(path => lines.push(style(DIM, `    ${pathText(path)}`)));
    }
    for (const { pkg, statement } of suppressed) {
      lines.push(`  ${pkg.packageName}@${pkg.version}${style(DIM, `, ${vexText(statement)}`)}`);
      pkg.paths.forEach(path => lines.push(style(DIM, `    ${pathText(path)}`)));
    }
    if (advisory.url !== undefined) {
      lines.push(`  ${style(DIM, advisory.url)}`);
    }
    lines.push("");
  }
  const packages = plural(report.packages.length, "package", "packages");
  const affecting = report.findings.filter(finding => finding.packages.length > 0);
  const unaffecting = report.findings.filter(finding => finding.packages.length === 0);
  const fixed = unaffecting.filter(finding => finding.suppressed.length === 0).length;
  const suppressed = unaffecting.length - fixed;
  const patches = [
    ...(fixed === 0 ? [] : [`; ${plural(fixed, "advisory is", "advisories are")} fixed by patched packages`]),
    ...(suppressed === 0 ? [] : [`; ${plural(suppressed, "advisory is", "advisories are")} suppressed by VEX statements`]),
  ].join("");
  if (affecting.length === 0) {
    lines.push(report.packages.length === 0 ? "No packages to audit" : `No known advisories affect the ${packages} checked${patches}`);
  } else {
    const affected = new Set(affecting.flatMap(finding => finding.packages.map(pkg => pkg.purl))).size;
    lines.push(`${plural(affecting.length, "advisory affects", "advisories affect")} ${affected} of ${packages} checked${patches}`);
  }
  return lines;
}
