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
import { IIndexEntry, indexPlatforms, nextPage, selectManifest } from "./OciProtocol";

const entry = (os: string, architecture: string, variant?: string): IIndexEntry => ({
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  digest: `sha256:${(os + architecture + (variant ?? "")).padEnd(64, "0").substring(0, 64)}`,
  size: 1,
  platform: { os, architecture, ...(variant === undefined ? {} : { variant }) },
});

describe("OCI protocol", () => {
  it("chooses the index entry for the platform, an arm64 entry stating no variant or v8", () => {
    const index = [entry("unknown", "unknown"), entry("linux", "amd64"), entry("linux", "arm64", "v8"), entry("linux", "arm", "v7")];
    expect(selectManifest(index, { os: "linux", architecture: "arm64" })?.platform?.variant).to.equal("v8");
    expect(selectManifest(index, { os: "linux", architecture: "arm", variant: "v7" })?.platform?.architecture).to.equal("arm");
    expect(selectManifest(index, { os: "linux", architecture: "s390x" })).to.equal(undefined);
    expect(indexPlatforms(index)).to.deep.equal(["linux/amd64", "linux/arm64/v8", "linux/arm/v7"]);
  });

  it("reads the next page a Link header names", () => {
    expect(nextPage('</v2/library/node/tags/list?last=22&n=100>; rel="next"')).to.equal("/v2/library/node/tags/list?last=22&n=100");
    expect(nextPage(undefined)).to.equal(undefined);
    expect(nextPage('<https://x/a>; rel="prev"')).to.equal(undefined);
  });
});
