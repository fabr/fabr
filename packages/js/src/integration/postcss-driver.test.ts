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

/* The driver is @fabr-build/js-tools'; the PnP table it locates a dependency's
 * stylesheets through is built by this package's `pnpManifestOf`, as
 * `css_postcss` writes it: an integration test of the two packages, so it lives
 * with the plugin. Composes within a step's own inputs are covered by the
 * driver's own tests. */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileSet, IFile, MemoryFile, PackageFileSet } from "@fabr-build/core";
import { DEPS_REPORT_FILE, DEPS_REPORT_FLAG, type IPostcssOptions, PNP_DATA_FILE, PostcssDriver, toRunReport } from "@fabr-build/js-tools";
import { TREE_MOUNT } from "@fabr-build/core";
import { pnpManifestOf, treeMountOf } from "../PnPManifest";

const { main } = PostcssDriver;

describe("the postcss driver, composing from a dependency through fabr's table", () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-postcssdriver-")));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const ds = (entries: Record<string, string>): PackageFileSet =>
    new PackageFileSet(
      new Map<string, IFile>(
        Object.entries({ "package.json": JSON.stringify({ name: "ds", version: "1.0.0" }), ...entries }).map(([name, text]) => [
          name,
          MemoryFile.from(text),
        ])
      ),
      "ds",
      "1.0.0",
      []
    );

  /**
   * Stage a workspace as the step does — the pool mounted as one link, each
   * package's tree once, the manifest beside the sources — then scope `source`
   * as a css-module with `dep`'s stylesheets composable, and answer a reader of
   * the outputs.
   */
  async function scope(dep: PackageFileSet, source: string, extra: string[] = []): Promise<(name: string) => string> {
    const manifest = pnpManifestOf([dep]);
    const store = path.join(root, "store");
    fs.mkdirSync(store);
    fs.symlinkSync(store, path.join(root, TREE_MOUNT));
    for (const each of manifest.packages) {
      for (const [name, file] of each as FileSet) {
        const target = path.join(store, path.basename(treeMountOf(each)), name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, (file as MemoryFile).getBuffer().value as Buffer);
      }
    }
    fs.writeFileSync(path.join(root, PNP_DATA_FILE), manifest.toFile().getBuffer().value as Buffer);
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "a.module.css"), source);
    const options: IPostcssOptions = {
      sources: [{ path: "a.module.css", css: "a.css", scope: "sA", module: true, shim: "a.css.ts" }],
      composable: [...dep]
        .map(([name]) => name)
        .filter(name => name.endsWith(".css"))
        .map(name => ({ package: "ds", path: name, scope: "sDep" })),
      srcRoot: "src",
      outdir: "out",
    };
    fs.writeFileSync(path.join(root, "options.json"), JSON.stringify(options));
    const cwd = process.cwd();
    try {
      process.chdir(root);
      await main(["--manifest=options.json", ...extra]);
    } finally {
      process.chdir(cwd);
    }
    return name => fs.readFileSync(path.join(root, name), "utf8");
  }

  it("composes from a dependency's stylesheet", async () => {
    const out = await scope(ds({ "base.css": ".base { padding: 8px; }\n" }), ".fancy { composes: base from 'ds/base.css'; color: red; }\n");
    /* The dep ships its classes as written; what a compose takes is a scoped
     * PRIVATE copy, inlined into the importer, so the token names that copy. */
    assert.match(out("out/a.css.ts"), /"fancy": "fancy_sA base_sDep"/);
    assert.match(out("out/a.css"), /\.base_sDep \{ padding: 8px; \}[\s\S]*\.fancy_sA \{/);
    /* The dependency is an input, never an output: nothing of it is published
     * under its own name. */
    assert.equal(fs.existsSync(path.join(root, "out", "ds")), false);
  });

  it("reports reading only the dependency stylesheets a compose reached", async () => {
    const out = await scope(
      ds({ "base.css": ".base { padding: 8px; }\n", "other.css": ".other { margin: 0; }\n" }),
      ".fancy { composes: base from 'ds/base.css'; }\n",
      [DEPS_REPORT_FLAG, DEPS_REPORT_FILE]
    );
    const { reads } = toRunReport(JSON.parse(out(DEPS_REPORT_FILE)));
    assert.ok(reads.includes("ds base.css"), reads.join(", "));
    assert.ok(!reads.includes("ds other.css"));
  });
});
