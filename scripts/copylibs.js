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

/* Copy each package's .fabr library alongside its compiled output, so the
 * built package content is self-contained: the system include path resolves
 * lib/ next to the package entry point (see packageLibDir), never from the
 * source tree. */

const fs = require("fs");
const path = require("path");

for (const pkg of ["core", "js"]) {
  const src = path.join(__dirname, "..", "packages", pkg, "lib");
  const dest = path.join(__dirname, "..", "packages", pkg, "build", "lib");
  if (fs.existsSync(src)) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true });
  }
}
