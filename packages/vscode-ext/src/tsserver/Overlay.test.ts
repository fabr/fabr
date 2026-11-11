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
 */

import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installOverlay, type Links, linkedChildren, linkedTarget, notifyRelinked } from "./Overlay";

describe("overlay links", () => {
  const links: Links = new Map([
    ["/p/app/tsconfig.json", "/cache/app.json"],
    ["/p/lib", "/cache/lib"],
  ]);

  it("answers a link and what lies beneath it from the target", () => {
    expect(linkedTarget(links, "/p/app/tsconfig.json")).to.equal("/cache/app.json");
    expect(linkedTarget(links, "/p/lib/a/b.ts")).to.equal("/cache/lib/a/b.ts");
    expect(linkedTarget(links, "/p/app/src/a.ts")).to.equal(undefined);
  });

  it("adds the next component of each link beneath a directory", () => {
    expect(linkedChildren(links, "/p")).to.deep.equal(["app", "lib"]);
    expect(linkedChildren(links, "/p/app")).to.deep.equal(["tsconfig.json"]);
    expect(linkedChildren(links, "/p/app/src")).to.deep.equal([]);
  });
});

describe("overlay over fs", () => {
  let root: string;
  let view: typeof fs;
  let current: Links;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fabr-overlay-"));
    fs.mkdirSync(path.join(root, "real/src"), { recursive: true });
    fs.writeFileSync(path.join(root, "real/tsconfig.json"), "decoy");
    fs.writeFileSync(path.join(root, "real/src/a.ts"), "a");
    fs.writeFileSync(path.join(root, "served.json"), "served");
    fs.writeFileSync(path.join(root, "other.json"), "other");
    current = new Map([
      [path.join(root, "real/tsconfig.json"), path.join(root, "served.json")],
      [path.join(root, "virtual/pkg/package.json"), path.join(root, "other.json")],
    ]);
    view = {
      ...fs,
      realpathSync: Object.assign((p: fs.PathLike) => fs.realpathSync(p), { native: fs.realpathSync.native }),
    } as typeof fs;
    installOverlay(view, () => current);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("shows a masked file as missing, and leaves its siblings as they are", () => {
    const nested = path.join(root, "real/src/tsconfig.json");
    fs.writeFileSync(nested, "nested");
    const masking = {
      ...fs,
      realpathSync: Object.assign((p: fs.PathLike) => fs.realpathSync(p), { native: fs.realpathSync.native }),
    } as typeof fs;
    installOverlay(
      masking,
      () => current,
      file => file === nested
    );
    expect(masking.existsSync(nested)).to.equal(false);
    expect(() => masking.readFileSync(nested, "utf8")).to.throw(/ENOENT/);
    expect(() => masking.statSync(nested)).to.throw(/ENOENT/);
    expect(masking.readdirSync(path.join(root, "real/src"))).to.deep.equal(["a.ts"]);
    expect(masking.readFileSync(path.join(root, "real/src/a.ts"), "utf8")).to.equal("a");
  });

  it("serves a link in place of the real file, under its own name", () => {
    const config = path.join(root, "real/tsconfig.json");
    expect(view.readFileSync(config, "utf8")).to.equal("served");
    expect(view.realpathSync(config)).to.equal(config);
    expect(view.readFileSync(path.join(root, "real/src/a.ts"), "utf8")).to.equal("a");
  });

  it("makes the directories above a link exist and list it", () => {
    expect(view.existsSync(path.join(root, "virtual/pkg"))).to.equal(true);
    expect(view.statSync(path.join(root, "virtual")).isDirectory()).to.equal(true);
    expect(view.readdirSync(path.join(root, "virtual"))).to.deep.equal(["pkg"]);
    expect(view.readdirSync(root).sort()).to.deep.equal(["other.json", "real", "served.json", "virtual"]);
    expect(view.readFileSync(path.join(root, "virtual/pkg/package.json"), "utf8")).to.equal("other");
  });

  it("tells a watch of a link that the link was repointed", () => {
    const config = path.join(root, "real/tsconfig.json");
    const seen: string[] = [];
    const watcher = view.watch(config, { persistent: false }, (event: string) => seen.push(event));
    const before = current;
    current = new Map([...current, [config, path.join(root, "other.json")]]);
    notifyRelinked(view, before, current);
    watcher.close();
    expect(seen).to.deep.equal(["change"]);
  });

  it("forgets a watch of a link once it is closed or unwatched", () => {
    const config = path.join(root, "real/tsconfig.json");
    const seen: string[] = [];
    view.watch(config, { persistent: false }, (event: string) => seen.push(`watch ${event}`)).close();
    const listener = (): void => void seen.push("watchFile");
    view.watchFile(config, { persistent: false, interval: 60_000 }, listener);
    view.unwatchFile(config, listener);
    const before = current;
    current = new Map([...current, [config, path.join(root, "other.json")]]);
    notifyRelinked(view, before, current);
    expect(seen).to.deep.equal([]);
  });
});
