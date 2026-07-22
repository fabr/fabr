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

import { expect } from "chai";
import { runFabr } from "./harness";

/* A `./x` reference written in a *subdir* build file (docs/BUILD.fabr's astro
 * srcs) must be found relative to that file but NAMED relative to it too — the
 * written name — so it stages at the sandbox root, not under the subdir. The
 * `lister` tool walks the staged sandbox and prints each file's path. */
describe("e2e: file reference naming from a subdir build file", () => {
  const files = {
    "PROJECT.fabr": "plugin @fabr-build/js;\njs_script lister { entry = src:lister.js; }\ninclude sub/BUILD.fabr;\n",
    "src/lister.js":
      "const fs=require('fs'),p=require('path');" +
      "(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){" +
      "if(e.name==='node_modules'||e.name==='package.json')continue;" +
      "const f=p.join(d,e.name);if(e.isDirectory())w(f);else console.log(p.relative('.',f));}})('.');",
    "sub/BUILD.fabr": "generate g {\n  srcs = ./assets/** ./app.config.mjs;\n  run = lister > listing.txt;\n}\n",
    "sub/app.config.mjs": "export default {};\n",
    "sub/assets/page.txt": "hello\n",
    "sub/assets/nested/deep.txt": "deep\n",
  };

  it("stages ./glob and ./file at the sandbox root, keeping their written names", () => {
    const result = runFabr(files, ["cat", "g:listing.txt"]);
    expect(result.status).to.equal(0);
    const listed = result.stdout;
    /* The config file and the whole assets subtree land at the root, named as
     * written (no `sub/` prefix from the build file's own location). */
    expect(listed).to.contain("app.config.mjs");
    expect(listed).to.contain("assets/page.txt");
    expect(listed).to.contain("assets/nested/deep.txt");
    expect(listed).to.not.match(/\bsub\//);
  });

  it("flattens a ../ climb by stripping the leading ../ — not by its tree position", () => {
    /* From a build file two levels deep (`a/b/BUILD.fabr`), `../shared/x` names as
     * `shared/x` (leading `../` stripped) — NOT `a/shared/x` (its actual location
     * relative to the source root). The rule is position-independent: just drop the
     * leading `../`. */
    const deep = {
      "PROJECT.fabr": "plugin @fabr-build/js;\njs_script lister { entry = src:lister.js; }\ninclude a/b/BUILD.fabr;\n",
      "src/lister.js": files["src/lister.js"],
      "a/b/BUILD.fabr": "generate g {\n  srcs = ./local.txt ../shared/x.txt;\n  run = lister > listing.txt;\n}\n",
      "a/b/local.txt": "local\n",
      "a/shared/x.txt": "shared\n",
    };
    const result = runFabr(deep, ["cat", "g:listing.txt"]);
    expect(result.status).to.equal(0);
    expect(result.stdout).to.contain("local.txt");
    expect(result.stdout).to.contain("shared/x.txt");
    expect(result.stdout).to.not.contain("a/shared"); /* not named by tree position */
  });
});
