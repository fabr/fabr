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

import { gunzipSync } from "zlib";
import { createHash } from "crypto";
import { expect } from "chai";
import { FileSet, IFile, MemoryFile, packToTarball, SymlinkFile } from "@fabr-build/core";
import { ImageFileSet, imageOfRecords, libcOf } from "./ImageFileSet";
import { indexLayer, ILayerIndex } from "./LayerIndex";
import { imageLayout } from "./OciLayout";
import { toImageConfig } from "./OciProtocol";

/** Make an image of one layer holding `files`. */
async function imageOf(files: Record<string, string | SymlinkFile>): Promise<ImageFileSet> {
  const set = new FileSet(new Map<string, IFile>(Object.entries(files).map(([name, content]) => [name, typeof content === "string" ? MemoryFile.from(content) : content])));
  const tar = gunzipSync(await Promise.resolve(packToTarball(set)));
  const { sink, result } = indexLayer();
  await new Promise<void>((resolve, reject) => sink.on("finish", resolve).on("error", reject).end(tar));
  const index: ILayerIndex = result();
  const config = toImageConfig({ architecture: "amd64", os: "linux", rootfs: { type: "layers", diff_ids: [index.diffId] } });
  return ImageFileSet.of(config, [{ tar: new MemoryFile(tar), index, indexFile: MemoryFile.from(JSON.stringify(index)) }], "img");
}

describe("ImageFileSet", () => {
  it("reads an image back from its records", async () => {
    const image = await imageOf({ "etc/hostname": "box", "bin/sh": new SymlinkFile("busybox") });
    const back = await Promise.resolve(imageOfRecords(image.toRecords(), "img"));
    expect([...back].map(([name]) => name).sort()).to.deep.equal(["bin/sh", "etc/hostname"]);
    expect(await back.readFile("etc/hostname")).to.equal("box");
    expect(back.config.diffIds).to.deep.equal(image.config.diffIds);
  });

  it("keeps its class, config and layers when given a provenance step or another name", async () => {
    const image = await imageOf({ "a.txt": "a" });
    const stamped = image.withOrigin({ kind: "test" });
    expect(stamped).to.be.instanceOf(ImageFileSet);
    expect((stamped as ImageFileSet).layers).to.equal(image.layers);
    expect(image.withPackageName("other")).to.be.instanceOf(ImageFileSet);
  });

  it("finds the C library an image has from its dynamic loader", async () => {
    expect(libcOf(await imageOf({ "lib/ld-musl-aarch64.so.1": "", "lib/ld-linux-aarch64.so.1": "" }))).to.equal("musl");
    expect(libcOf(await imageOf({ "usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1": "", "lib": new SymlinkFile("usr/lib") }))).to.equal("gnu");
    expect(libcOf(await imageOf({ "lib64/ld-linux-x86-64.so.2": "" }))).to.equal("gnu");
    expect(libcOf(await imageOf({ "app/server": "static" }))).to.equal(undefined);
  });
});

describe("imageLayout", () => {
  it("writes an OCI layout with Docker's manifest beside it, its layers uncompressed", async () => {
    const image = await imageOf({ "etc/hostname": "box" });
    const layout = await Promise.resolve(imageLayout(image, "myorg/app:1.4"));
    const index = JSON.parse(await layout.readFile("index.json")) as { manifests: Array<{ digest: string; annotations: Record<string, string> }> };
    const manifestPath = `blobs/sha256/${index.manifests[0].digest.substring(7)}`;
    const manifestText = await layout.readFile(manifestPath);
    expect(`sha256:${createHash("sha256").update(manifestText).digest("hex")}`).to.equal(index.manifests[0].digest);
    expect(index.manifests[0].annotations["org.opencontainers.image.ref.name"]).to.equal("1.4");
    const manifest = JSON.parse(manifestText) as { layers: Array<{ mediaType: string; digest: string }> };
    expect(manifest.layers).to.have.lengthOf(1);
    expect(manifest.layers[0]).to.include({ mediaType: "application/vnd.oci.image.layer.v1.tar", digest: image.config.diffIds[0] });
    expect(layout.getFile(`blobs/sha256/${image.config.diffIds[0].substring(7)}`)).to.equal(image.layers[0].tar);
    const docker = JSON.parse(await layout.readFile("manifest.json")) as Array<{ RepoTags: string[]; Layers: string[] }>;
    expect(docker[0].RepoTags).to.deep.equal(["myorg/app:1.4"]);
    expect(await layout.readFile("oci-layout")).to.equal('{"imageLayoutVersion":"1.0.0"}');
  });
});
