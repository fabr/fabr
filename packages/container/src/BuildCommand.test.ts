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
import { changedPaths } from "./BuildCommand";

describe("changedPaths", () => {
  it("copies each added tree by its top and each changed file, and whites out each deleted tree by its top", () => {
    const diff = [
      "C /usr",
      "C /usr/bin",
      "A /usr/bin/curl",
      "A /usr/share/curl",
      "A /usr/share/curl/a",
      "A /usr/share/curl/b/c",
      "C /etc",
      "C /etc/apk/world",
      "D /etc/motd",
      "D /var/cache/old",
      "D /var/cache/old/x",
      "",
    ].join("\n");
    expect(changedPaths(diff)).to.deep.equal({
      copies: ["/etc/apk/world", "/usr/bin/curl", "/usr/share/curl"],
      deletions: ["/etc/motd", "/var/cache/old"],
    });
  });

  it("reads nothing from output that is not a change", () => {
    expect(changedPaths("warning: something\n\n")).to.deep.equal({ copies: [], deletions: [] });
  });
});
