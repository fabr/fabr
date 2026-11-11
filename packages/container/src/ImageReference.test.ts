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
import { splitImageReference } from "./ImageReference";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("splitImageReference", () => {
  it("splits an image's name from its tag and what follows", () => {
    expect(splitImageReference("node", "node")).to.deep.equal({ name: "node" });
    expect(splitImageReference("node:22-bookworm-slim", "x")).to.deep.equal({ name: "node", version: "22-bookworm-slim" });
    expect(splitImageReference("node:22:etc/os-release", "x")).to.deep.equal({
      name: "node",
      version: "22",
      rest: { at: 8, separator: ":" },
    });
    expect(splitImageReference("node:22/etc/os-release", "x")).to.deep.equal({
      name: "node",
      version: "22",
      rest: { at: 8, separator: "/" },
    });
    expect(splitImageReference("myorg/app:1.4", "x")).to.deep.equal({ name: "myorg/app", version: "1.4" });
  });

  it("reads a version as a digest only where it is sha256 and 64 hex digits", () => {
    expect(splitImageReference(`node:${DIGEST}`, "x")).to.deep.equal({ name: "node", version: DIGEST });
    expect(splitImageReference(`node:${DIGEST}:bin/sh`, "x").rest?.separator).to.equal(":");
    /* `sha256` is itself a tag, followed here by what it selects. */
    expect(splitImageReference("node:sha256:abc", "x")).to.deep.equal({
      name: "node",
      version: "sha256",
      rest: { at: 12, separator: ":" },
    });
  });

  it("refuses a name or tag the distribution spec does not allow", () => {
    expect(() => splitImageReference("Node:22", "Node:22")).to.throw(/does not name an image/);
    expect(() => splitImageReference("node:-x", "node:-x")).to.throw(/does not name a tag/);
  });
});
