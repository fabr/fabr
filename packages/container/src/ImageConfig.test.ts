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
import { FIXED_CREATED, IImageSettings, imageConfig } from "./ImageConfig";

const NONE: IImageSettings = { args: [], env: [], ports: [], metadata: [] };
const AMD64 = { os: "linux", architecture: "amd64" };
const DIFF_ID = `sha256:${"b".repeat(64)}`;

describe("imageConfig", () => {
  const base = {
    architecture: "amd64",
    os: "linux",
    created: "2026-01-01T00:00:00Z",
    config: { Env: ["PATH=/bin", "LANG=C"], Entrypoint: ["docker-entrypoint.sh"], Cmd: ["node"], ExposedPorts: { "22/tcp": {} } },
    rootfs: { type: "layers", diff_ids: [`sha256:${"a".repeat(64)}`] },
    history: [{ created_by: "base" }],
  };

  it("applies the settings over the base's config and adds the layer", () => {
    const config = imageConfig(base, AMD64, { ...NONE, entry: "/app/server", args: ["--port", "8080"], env: [["LANG", "C.UTF-8"], ["MODE", "prod"]], ports: ["8080", "53/udp"] }, DIFF_ID, "made");
    expect(config.created).to.equal(FIXED_CREATED);
    expect(config.config).to.deep.equal({
      Env: ["PATH=/bin", "LANG=C.UTF-8", "MODE=prod"],
      Entrypoint: ["/app/server", "--port", "8080"],
      ExposedPorts: { "22/tcp": {}, "8080/tcp": {}, "53/udp": {} },
    });
    expect((config.rootfs as { diff_ids: string[] }).diff_ids).to.deep.equal([`sha256:${"a".repeat(64)}`, DIFF_ID]);
    expect(config.history).to.deep.equal([{ created_by: "base" }, { created: FIXED_CREATED, created_by: "made" }]);
  });

  it("keeps the base's entrypoint and command where no entry is set, and records a settings-only change as an empty layer", () => {
    const config = imageConfig(base, AMD64, { ...NONE, workdir: "/srv", user: "node" }, undefined, "made");
    expect(config.config).to.deep.include({ Entrypoint: ["docker-entrypoint.sh"], Cmd: ["node"], WorkingDir: "/srv", User: "node" });
    expect((config.history as unknown[])[1]).to.deep.equal({ created: FIXED_CREATED, created_by: "made", empty_layer: true });
  });

  it("starts an image with no base from its platform", () => {
    const config = imageConfig(undefined, { os: "linux", architecture: "arm", variant: "v7" }, NONE, DIFF_ID, "made");
    expect(config).to.deep.include({ architecture: "arm", os: "linux", variant: "v7", config: {}, rootfs: { type: "layers", diff_ids: [DIFF_ID] } });
  });

  it("writes metadata as labels over the base's, OCI's keys under its prefix", () => {
    const labelled = { ...base, config: { ...base.config, Labels: { "org.opencontainers.image.description": "base", keep: "yes" } } };
    const config = imageConfig(labelled, AMD64, { ...NONE, metadata: [["description", "server"], ["licenses", "MIT"], ["traefik.enable", "true"]] }, undefined, "made");
    expect((config.config as Record<string, unknown>).Labels).to.deep.equal({
      "org.opencontainers.image.description": "server",
      keep: "yes",
      "org.opencontainers.image.licenses": "MIT",
      "traefik.enable": "true",
    });
  });

  it("refuses args with no entry, and a port that is none", () => {
    expect(() => imageConfig(base, AMD64, { ...NONE, args: ["x"] }, undefined, "made")).to.throw(/'args' is set without 'entry'/);
    expect(() => imageConfig(base, AMD64, { ...NONE, ports: ["http"] }, undefined, "made")).to.throw(/'http' is not a port/);
  });
});
