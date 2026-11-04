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

/*
 * Docs generator: reads `fabr list-all --json` on stdin (the whole build
 * vocabulary — target types, config properties, flags) and writes the Markdown
 * reference pages into the given output directory, each at its place in the site
 * under `content/` — one per source package (core, the JS plugin, the Java
 * plugin, the AWS plugin), and beside a plugin's page one for its optional libs — with
 * `reference-pages.json`, the sidebar entry of each. Compiled and launched by fabr
 * as a TypeScript js_script (the `gendoc` target); the pages are `.md`, not
 * `.mdx`, because the doc-comment prose contains `{ ... }` which MDX would parse
 * as JSX. The `generate` target collects them with an `output` glob (no `>` redirect).
 *
 *   Usage: fabr list-all --json | gendoc <output-dir>
 */

import * as fs from "fs";
import * as path from "path";

/** One property of a target type, as reported by `list-targetdefs --json`. */
interface PropertyDef {
  name: string;
  type: string;
  required: boolean;
  /** The value written after `default` in the targetdef — what a target of this
   * type gets by omission — or null/absent when the property has none. */
  default?: string | null;
  description?: string | null;
}

/** One target type, as reported by `list-targetdefs --json`. */
interface TargetDef {
  name: string;
  operations: string[];
  location?: string;
  /** The plugin whose files declare it; absent for core's. */
  plugin?: string;
  /** For one in a plugin's optional lib, the include that reads the lib. */
  include?: string;
  description?: string | null;
  properties: PropertyDef[];
}

/** A global configuration property (`BUILD_TYPE`, `JS_TARGET`, …). */
interface ConfigProp {
  name: string;
  value: string;
  location?: string;
  /** The plugin whose files declare it; absent for core's. */
  plugin?: string;
  /** For one in a plugin's optional lib, the include that reads the lib. */
  include?: string;
  description?: string | null;
}

/** A `flag` target (a source-mode switch like `ts/no_strict`). */
interface FlagDef {
  name: string;
  location?: string;
  /** The plugin whose files declare it; absent for core's. */
  plugin?: string;
  /** For one in a plugin's optional lib, the include that reads the lib. */
  include?: string;
  description?: string | null;
}

/** A ready-made declared target a library provides (a repository like `@npm`,
 * a driver tool), with its written properties for reconstructing the decl. */
interface ProvidedTarget {
  name: string;
  type: string;
  properties: { name: string; value: string }[];
  location?: string;
  /** The plugin whose files declare it; absent for core's. */
  plugin?: string;
  /** For one in a plugin's optional lib, the include that reads the lib. */
  include?: string;
  description?: string | null;
}

/** `list-all --json`: the whole vocabulary in one document. */
interface Doc {
  targetdefs: TargetDef[];
  properties: ConfigProp[];
  flags: FlagDef[];
  targets: ProvidedTarget[];
}

/** A generated page: where the site places it, its entry in the site's
 * sidebar (the section and the label it is listed under), and its
 * front-matter. */
interface Page {
  link: string;
  section: string;
  label: string;
  title: string;
  description: string;
  intro: string[];
}

/** A plugin's page (core's, where `plugin` is undefined): what every project
 * using the plugin has. `optional` is the page beside it covering the plugin's
 * optional libs, one section each. */
interface Group extends Page {
  plugin: string | undefined;
  optional?: Page;
}

/** Anything `list-all` lists: where it comes from is what places it on a page. */
interface Entry {
  plugin?: string;
  include?: string;
}

const GROUPS: Group[] = [
  {
    link: "/reference/standard-rules/",
    section: "Reference",
    label: "Core targets & configuration",
    title: "Core targets and configuration",
    description: "The target types, configuration, and flags that fabr's core provides, independent of any plugin.",
    intro: [
      "The target types, configuration properties, and flags that ship in fabr's core (`STD.fabr`) and are",
      "always available, independent of any language plugin. Ecosystem-specific definitions (like",
      "`js_package`) come from plugins — see [JavaScript targets and configuration](/reference/js/targets/),",
      "[Java targets and configuration](/reference/java/targets/) and [AWS targets and",
      "configuration](/reference/aws/targets/).",
      "",
      "This page is generated from `fabr list-all`, so it never drifts from the code.",
    ],
    plugin: undefined,
  },
  {
    link: "/reference/js/targets/",
    section: "JavaScript reference",
    label: "Targets & configuration",
    title: "JavaScript targets and configuration",
    description: "The JavaScript/TypeScript target types, configuration, and flags from the @fabr-build/js plugin.",
    intro: [
      "The target types, configuration properties, and flags contributed by the `@fabr-build/js` plugin",
      "(`plugin @fabr-build/js;`). They cover building, bundling, testing, and styling JavaScript and",
      "TypeScript. Core definitions (like `script` and `generate`) are in",
      "[Core targets and configuration](/reference/standard-rules/).",
      "",
      "This page is generated from `fabr list-all`, so it never drifts from the code.",
    ],
    plugin: "@fabr-build/js",
  },
  {
    link: "/reference/java/targets/",
    section: "Java reference",
    label: "Targets & configuration",
    title: "Java targets and configuration",
    description: "The Java target types, configuration, and flags from the @fabr-build/java plugin.",
    intro: [
      "The target types, configuration properties, and flags contributed by the `@fabr-build/java` plugin",
      "(`plugin @fabr-build/java;`). They cover compiling, testing, running and packaging Java.",
      "Core definitions (like `script` and `generate`) are in",
      "[Core targets and configuration](/reference/standard-rules/).",
      "",
      "This page is generated from `fabr list-all`, so it never drifts from the code.",
    ],
    plugin: "@fabr-build/java",
    optional: {
      link: "/reference/java/optional-libs/",
      section: "Java reference",
      label: "Optional libraries",
      title: "Java optional libraries",
      description: "The target types in the @fabr-build/java plugin's optional libraries, which a project includes to use.",
      intro: [
        "The `@fabr-build/java` plugin keeps some target types in optional libraries: `.fabr` files a",
        "project reads only where it includes them, after `plugin @fabr-build/java;`. Each section below",
        "is one library, with the line that includes it. Everything else the plugin provides is in",
        "[Java targets and configuration](/reference/java/targets/).",
        "",
        "This page is generated from `fabr list-all`, so it never drifts from the code.",
      ],
    },
  },
  {
    link: "/reference/aws/targets/",
    section: "AWS reference",
    label: "Targets & configuration",
    title: "AWS targets and configuration",
    description: "The target types and configuration from the @fabr-build/aws plugin.",
    intro: [
      "The target types and configuration properties contributed by the `@fabr-build/aws` plugin",
      "(`plugin @fabr-build/aws;`), which reads from and publishes to AWS services. Core definitions",
      "(like `sync`) are in [Core targets and configuration](/reference/standard-rules/).",
      "",
      "This page is generated from `fabr list-all`, so it never drifts from the code.",
    ],
    plugin: "@fabr-build/aws",
  },
];

/** Make a doc-comment safe for one Markdown table cell: one line, pipes escaped. */
function cell(text: string | undefined | null): string {
  return (text ?? "").replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
}

/** Render a Markdown table: a header row, the rule beneath it, and one row per entry. */
function table(head: string[], rows: string[][]): string[] {
  const row = (cells: string[]): string => `| ${cells.join(" | ")} |`;
  return [row(head), row(head.map(() => "---")), ...rows.map(row)];
}

/** Render the property's declared type as written in a targetdef (`REQUIRED FILES`). */
function propType(prop: PropertyDef): string {
  return (prop.required ? "REQUIRED " : "") + prop.type;
}

/** Render the property's `default …` clause as written, or "" when it has none. */
function propDefault(prop: PropertyDef): string {
  return prop.default ? ` default ${prop.default}` : "";
}

/** Reconstruct the targetdef's schema block from its properties, so the prose
 * comment need not restate it (and it can never drift). */
function schemaBlock(def: TargetDef): string {
  const width = Math.max(0, ...def.properties.map(prop => prop.name.length));
  const lines = [`targetdef ${def.name} {`];
  for (const prop of def.properties) {
    lines.push(`  ${prop.name.padEnd(width)} = ${propType(prop)}${propDefault(prop)};`);
  }
  lines.push("}");
  return "```\n" + lines.join("\n") + "\n```";
}

/** Render the per-property reference table for a target type: the schema restated with
 * each property's own description. The Default column appears only for a type
 * that declares one, so the common case isn't a column of blanks. */
function propertyTable(def: TargetDef): string[] {
  const defaults = def.properties.some(prop => prop.default);
  return table(
    ["Property", "Type", "Required", ...(defaults ? ["Default"] : []), "Description"],
    def.properties.map(prop => [
      `\`${prop.name}\``,
      propType(prop),
      prop.required ? "yes" : "",
      ...(defaults ? [prop.default ? `\`${cell(prop.default)}\`` : ""] : []),
      cell(prop.description),
    ])
  );
}

/** Reconstruct a provided target's declaration from its written properties,
 * for the same never-drifts reason as {@link schemaBlock}. */
function declBlock(target: ProvidedTarget): string {
  const width = Math.max(0, ...target.properties.map(prop => prop.name.length));
  const lines = [`${target.type} ${target.name} {`];
  for (const prop of target.properties) {
    lines.push(`  ${prop.name.padEnd(width)} = ${prop.value};`);
  }
  lines.push("}");
  return "```\n" + lines.join("\n") + "\n```";
}

/** The entries of one page, or of one section of a page. */
interface Entries {
  properties: ConfigProp[];
  flags: FlagDef[];
  targetdefs: TargetDef[];
  targets: ProvidedTarget[];
}

/** @return the entries of `doc` that `keep` admits. */
function entriesOf(doc: Doc, keep: (entry: Entry) => boolean): Entries {
  return {
    properties: doc.properties.filter(keep),
    flags: doc.flags.filter(keep),
    targetdefs: doc.targetdefs.filter(keep),
    targets: (doc.targets ?? []).filter(keep),
  };
}

/** Render `entries` as sections headed at `level` (`##` on a plugin's page,
 * `###` within an optional lib's section), each item a level below. */
function renderEntries(entries: Entries, level: number): string[] {
  const section = "#".repeat(level);
  const item = "#".repeat(level + 1);
  const out: string[] = [];
  if (entries.properties.length > 0) {
    out.push(`${section} Global properties`, "");
    out.push(
      ...table(
        ["Property", "Default", "Description"],
        entries.properties.map(prop => [`\`${prop.name}\``, `\`${cell(prop.value) || "(unset)"}\``, cell(prop.description)])
      ),
      ""
    );
  }
  if (entries.flags.length > 0) {
    out.push(`${section} Flags`, "", "List a flag in a target's `deps` to switch its behaviour for that target.", "");
    out.push(...table(["Flag", "Description"], entries.flags.map(flag => [`\`${flag.name}\``, cell(flag.description)])), "");
  }
  if (entries.targetdefs.length > 0) {
    out.push(`${section} Targets`, "");
    for (const def of entries.targetdefs) {
      out.push(`${item} \`${def.name}\``, "");
      if (def.operations.length > 0) {
        out.push(`**Operations:** ${def.operations.map(op => "`" + op + "`").join(", ")}`, "");
      }
      out.push(schemaBlock(def), "");
      if (def.description) {
        out.push(def.description, "");
      }
      /* A property table only earns its place when a property carries its own
       * description; otherwise it just restates the schema block above. */
      if (def.properties.some(prop => prop.description)) {
        out.push(...propertyTable(def), "");
      }
    }
  }
  if (entries.targets.length > 0) {
    out.push(`${section} Provided targets`, "", "Ready-made targets declared by these libraries, usable by name in any project.", "");
    for (const target of entries.targets) {
      out.push(`${item} \`${target.name}\``, "");
      out.push(declBlock(target), "");
      if (target.description) {
        out.push(target.description, "");
      }
    }
  }
  return out;
}

/** Render a page's front-matter and introduction. */
function header(page: Page): string[] {
  return ["---", `title: ${page.title}`, `description: ${page.description}`, "---", "", ...page.intro, ""];
}

/** Render `group`'s page: what every project using its plugin has. */
function render(group: Group, doc: Doc): string {
  const out = header(group);
  if (group.optional !== undefined) {
    out.push(`More target types are in the plugin's optional libraries; see [${group.optional.title}](${group.optional.link}).`, "");
  }
  out.push(...renderEntries(entriesOf(doc, entry => entry.plugin === group.plugin && entry.include === undefined), 2));
  return out.join("\n");
}

/** Render `group`'s optional libs page: a section per lib, by the include
 * that reads it, in name order. */
function renderOptional(group: Group, page: Page, doc: Doc): string {
  const out = header(page);
  const all = [...doc.properties, ...doc.flags, ...doc.targetdefs, ...(doc.targets ?? [])];
  const includes = [...new Set(all.filter(entry => entry.plugin === group.plugin && entry.include !== undefined).map(entry => entry.include!))].sort();
  for (const include of includes) {
    out.push(`## \`${include.slice(include.indexOf(":") + 1)}\``, "");
    out.push("```", `include ${include};`, "```", "");
    out.push(...renderEntries(entriesOf(doc, entry => entry.plugin === group.plugin && entry.include === include), 3));
  }
  return out.join("\n");
}

/** The manifest of the pages written, which the site's sidebar lists. */
const MANIFEST = "reference-pages.json";

/** @return where a page is written: its link, as a Markdown file under `content/`. */
function fileOf(page: Page): string {
  return path.join("content", `${page.link.replace(/^\/|\/$/g, "")}.md`);
}

/* Write each page at its place in the site, under `content/` in the given dir
 * (default the cwd), and the manifest of them beside it; the `generate`
 * target collects them all, and the site takes `content/` as its pages. */
const outDir = process.argv[2] ?? ".";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => (input += chunk));
process.stdin.on("end", () => {
  const doc = JSON.parse(input) as Doc;
  const written: Page[] = [];
  const write = (page: Page, text: string): void => {
    const file = path.join(outDir, fileOf(page));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    written.push(page);
  };
  for (const group of GROUPS) {
    write(group, render(group, doc));
    if (group.optional !== undefined) {
      write(group.optional, renderOptional(group, group.optional, doc));
    }
  }
  const manifest = written.map(({ section, label, link }) => ({ section, label, link }));
  fs.writeFileSync(path.join(outDir, MANIFEST), JSON.stringify(manifest, undefined, 2) + "\n");
});
