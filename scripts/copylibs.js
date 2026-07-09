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

/* Make each package's devchain (tsc) build content-identical to the package
 * fabr itself produces, so `yarn build` is a faithful stand-in and not just a
 * bootstrap. Two source assets tsc leaves behind that the fabr build carries:
 *   - lib/ .fabr libraries: the system include path resolves lib/ next to the
 *     package entry point (see packageLibDir), never from the source tree;
 *   - hand-authored .d.ts under src/: the fabr build's `srcs = **\/*.ts` glob
 *     passes them through, but tsc never copies .d.ts *inputs* to outDir. */

const fs = require("fs");
const path = require("path");

for (const pkg of ["core", "js"]) {
  const pkgDir = path.join(__dirname, "..", "packages", pkg);
  const lib = path.join(pkgDir, "lib");
  const libDest = path.join(pkgDir, "build", "lib");
  if (fs.existsSync(lib)) {
    fs.rmSync(libDest, { recursive: true, force: true });
    fs.cpSync(lib, libDest, { recursive: true });
  }

  const srcRoot = path.join(pkgDir, "src");
  const buildRoot = path.join(pkgDir, "build");
  if (fs.existsSync(srcRoot)) {
    (function copyDecls(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const from = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          copyDecls(from);
        } else if (entry.name.endsWith(".d.ts")) {
          const to = path.join(buildRoot, path.relative(srcRoot, from));
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(from, to);
        }
      }
    })(srcRoot);
  }
}
