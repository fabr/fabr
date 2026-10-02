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

/* The curated npm package-extension list (Yarn's `@yarnpkg/extensions`, which
 * pnpm also applies) as the JSON document @fabr-build/js ships in its lib/ and
 * reads at resolution time. Run as a program it writes the document to stdout
 * (the fabr build's generate step); `copylibs.js` requires it for the devchain
 * build. The module builds its list in code and has no runtime dependencies,
 * so the fabr build stages that one file beside this script; the devchain
 * loads it from the installed package. */

function extensionsModule() {
  try {
    return require("./yarnpkg-extensions.js");
  } catch (err) {
    if (err.code !== "MODULE_NOT_FOUND") {
      throw err;
    }
    return require("@yarnpkg/extensions");
  }
}

function packageExtensionsJson() {
  const { packageExtensions } = extensionsModule();
  return `${JSON.stringify(packageExtensions, undefined, 1)}\n`;
}

module.exports = { packageExtensionsJson };

if (require.main === module) {
  process.stdout.write(packageExtensionsJson());
}
