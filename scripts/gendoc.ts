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
 * reference pages into the given output directory — one per source package (core
 * -> standard-rules.md, JS plugin -> js-rules.md). Compiled and launched by fabr
 * as a TypeScript js_script (the `gendoc` target); the pages are `.md`, not
 * `.mdx`, because the doc-comment prose contains `{ ... }` which MDX would parse
 * as JSX. The genrule collects them with an `output` glob (no `>` redirect).
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
  description?: string | null;
}

/** One target type, as reported by `list-targetdefs --json`. */
interface TargetDef {
  name: string;
  operations: string[];
  location?: string;
  description?: string | null;
  properties: PropertyDef[];
}

/** A global configuration property (`BUILD_TYPE`, `JS_TARGET`, …). */
interface ConfigProp {
  name: string;
  value: string;
  location?: string;
  description?: string | null;
}

/** A `flag` target (a source-mode switch like `ts/nostrict`). */
interface FlagDef {
  name: string;
  location?: string;
  description?: string | null;
}

/** `list-all --json`: the whole vocabulary in one document. */
interface Doc {
  targetdefs: TargetDef[];
  properties: ConfigProp[];
  flags: FlagDef[];
}

/** A rendered page: its output filename, which contributions it covers (by source
 * location), and its front-matter. A targetdef/property/flag belongs to `core`
 * iff its location is in core's `STD.fabr`; everything else is the JS plugin. */
interface Group {
  file: string;
  title: string;
  description: string;
  intro: string[];
  isMember: (location: string | undefined) => boolean;
}

const inCore = (location: string | undefined): boolean => (location ?? "").includes("STD.fabr");

const GROUPS: Group[] = [
  {
    file: "standard-rules.md",
    title: "Core reference",
    description: "The target types, configuration, and flags that fabr's core provides, independent of any plugin.",
    intro: [
      "The target types, configuration properties, and flags that ship in fabr's core (`STD.fabr`) and are",
      "always available, independent of any language plugin. Ecosystem-specific definitions (like",
      "`js_package`) come from plugins — see the [JavaScript reference](/reference/js-rules/).",
      "",
      "This page is generated from `fabr list-all`, so it never drifts from the code.",
    ],
    isMember: inCore,
  },
  {
    file: "js-rules.md",
    title: "JavaScript reference",
    description: "The JavaScript/TypeScript target types, configuration, and flags from the @fabr-build/js plugin.",
    intro: [
      "The target types, configuration properties, and flags contributed by the `@fabr-build/js` plugin",
      "(`plugin @fabr-build/js;`). They cover building, bundling, testing, and styling JavaScript and",
      "TypeScript. Core definitions (like `script` and `generate`) are in the [Core reference](/reference/standard-rules/).",
      "",
      "This page is generated from `fabr list-all`, so it never drifts from the code.",
    ],
    isMember: location => !inCore(location),
  },
];

/** Make a doc-comment safe for one Markdown table cell: one line, pipes escaped. */
function cell(text: string | undefined | null): string {
  return (text ?? "").replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
}

/** The property's declared type as written in a targetdef (`REQUIRED FILES`). */
function propType(prop: PropertyDef): string {
  return (prop.required ? "REQUIRED " : "") + prop.type;
}

/** Reconstruct the targetdef's schema block from its properties, so the prose
 * comment need not restate it (and it can never drift). */
function schemaBlock(def: TargetDef): string {
  const width = Math.max(0, ...def.properties.map(prop => prop.name.length));
  const lines = [`targetdef ${def.name} {`];
  for (const prop of def.properties) {
    lines.push(`  ${prop.name.padEnd(width)} = ${propType(prop)};`);
  }
  lines.push("}");
  return "```\n" + lines.join("\n") + "\n```";
}

function render(group: Group, doc: Doc): string {
  const out: string[] = ["---", `title: ${group.title}`, `description: ${group.description}`, "---", "", ...group.intro, ""];

  const props = doc.properties.filter(prop => group.isMember(prop.location));
  if (props.length > 0) {
    out.push("## Configuration", "");
    for (const prop of props) {
      out.push(`### \`${prop.name}\``, "");
      out.push(`Default: \`${prop.value || "(unset)"}\``, "");
      if (prop.description) {
        out.push(prop.description, "");
      }
    }
  }

  const flags = doc.flags.filter(flag => group.isMember(flag.location));
  if (flags.length > 0) {
    out.push("## Flags", "", "List a flag in a target's `deps` to switch its behaviour for that target.", "");
    for (const flag of flags) {
      out.push(`### \`${flag.name}\``, "");
      if (flag.description) {
        out.push(flag.description, "");
      }
    }
  }

  const defs = doc.targetdefs.filter(def => group.isMember(def.location));
  if (defs.length > 0) {
    out.push("## Targets", "");
    for (const def of defs) {
      out.push(`### \`${def.name}\``, "");
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
        out.push("| Property | Type | Required | Description |", "| --- | --- | --- | --- |");
        for (const prop of def.properties) {
          out.push(`| \`${prop.name}\` | ${propType(prop)} | ${prop.required ? "yes" : ""} | ${cell(prop.description)} |`);
        }
        out.push("");
      }
    }
  }

  return out.join("\n");
}

/* Write the pages by their bare filename (into the given dir, default the cwd);
 * the genrule collects them with an `output` glob and the consumer places them
 * with a rename projection. */
const outDir = process.argv[2] ?? ".";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => (input += chunk));
process.stdin.on("end", () => {
  const doc = JSON.parse(input) as Doc;
  fs.mkdirSync(outDir, { recursive: true });
  for (const group of GROUPS) {
    fs.writeFileSync(path.join(outDir, group.file), render(group, doc));
  }
});
