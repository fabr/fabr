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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MockRegistry, NOT_MOCKED } from "./Registry";

/* The registry over a real (temporary) staged-install layout: resolution and
 * the manual-mock probes are filesystem questions, so the fixture is a
 * miniature of what the pipeline stages — compiled modules under `build/`, with
 * `__mocks__` directories in the places jest's conventions look. The seams are
 * NOT installed (that would wrap this very jest process's loader); serve() is
 * exercised directly. */
describe("MockRegistry", () => {
  /** What automockOf yields, distinguishable from any manual mock. */
  const AUTOMOCK = { automocked: true };
  const mocker = { getMetadata: (component: unknown) => component, generateFromMetadata: () => AUTOMOCK };

  let dir = "";
  let caller: { filename: string };

  const write = (name: string, exported: string): void => {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `module.exports = ${exported};`);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-registry-"));
    write("build/real.js", "{ real: true }");
    write("build/nomock.js", "{ real: true }");
    write("build/__mocks__/real.js", "{ manual: true }");
    write("build/__mocks__/fakepkg.js", "{ rootManual: true }");
    write("__mocks__/barepkg.js", "{ bareRoot: true }");
    /* Whom the mocks are registered by: a compiled test in the staged tree. */
    caller = { filename: path.join(dir, "build", "test.js") };
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const registry = (): MockRegistry => new MockRegistry(dir, mocker);

  describe("a factory-less jest.mock", () => {
    it("serves the adjacent __mocks__ file rather than automocking", () => {
      const mocks = registry();
      mocks.setMock("./real", caller);
      expect(mocks.serve("./real", caller)).to.deep.equal({ manual: true });
    });

    it("automocks where no manual mock exists", () => {
      const mocks = registry();
      mocks.setMock("./nomock", caller);
      expect(mocks.serve("./nomock", caller)).to.equal(AUTOMOCK);
    });

    it("prefers an explicit factory over the adjacent manual mock", () => {
      const mocks = registry();
      mocks.setMock("./real", caller, () => ({ factory: true }));
      expect(mocks.serve("./real", caller)).to.deep.equal({ factory: true });
    });

    it("serves the root __mocks__ entry for a package, even one that is not installed", () => {
      const mocks = registry();
      mocks.setMock("fakepkg", caller);
      expect(mocks.serve("fakepkg", caller)).to.deep.equal({ rootManual: true });
    });
  });

  describe("the root __mocks__ listing", () => {
    it("lists the compiled tree's __mocks__ (build/), where the pipeline stages a source-tree root mock", () => {
      /* No jest.mock call at all: the convention is automatic. */
      expect(registry().serve("fakepkg", caller)).to.deep.equal({ rootManual: true });
    });

    it("still honours a __mocks__ at the bare install root", () => {
      expect(registry().serve("barepkg", caller)).to.deep.equal({ bareRoot: true });
    });

    it("lets the compiled entry win over a same-named bare-root one", () => {
      write("__mocks__/fakepkg.js", "{ shadowed: true }");
      expect(registry().serve("fakepkg", caller)).to.deep.equal({ rootManual: true });
    });
  });

  describe("an unresolvable specifier", () => {
    it("is rejected by a non-virtual jest.mock, as jest rejects a typo'd module name", () => {
      expect(() => registry().setMock("no-such-module-xyz", caller, () => ({}))).to.throw(
        /Cannot find module 'no-such-module-xyz'/
      );
    });

    it("registers by text under {virtual: true}", () => {
      const mocks = registry();
      mocks.setMock("no-such-module-xyz", caller, () => ({ virtual: true }), true);
      expect(mocks.serve("no-such-module-xyz", caller)).to.deep.equal({ virtual: true });
    });

    it("registers an ASSET request by text — an unstaged stylesheet is still mockable", () => {
      const mocks = registry();
      mocks.setMock("./missing.css", caller, () => ({ stub: true }));
      expect(mocks.serve("./missing.css", caller)).to.deep.equal({ stub: true });
    });
  });

  describe("hasMockFor", () => {
    it("reports an asset request as mocked by default (the stub)", () => {
      expect(registry().hasMockFor("./styles.css")).to.equal(true);
    });

    it("lets jest.unmock of an asset win over the stub, mirroring serve", () => {
      /* The seam asks in KEY terms (it is handed a resolution, never the raw
       * specifier), so the assertion derives the key the way the registration
       * did — which also keeps the test honest under `fabr test`, where the
       * HOST runner's resolve hooks are live and can resolve an asset
       * specifier this instance's own withoutHooks cannot suspend. */
      const mocks = registry();
      mocks.unmock("./styles.css", caller);
      expect(mocks.hasMockFor(mocks["keyFor"]("./styles.css", caller, true))).to.equal(false);
      expect(mocks.serve("./styles.css", caller)).to.equal(NOT_MOCKED);
    });

    it("reports an explicit mock of an asset as mocked", () => {
      const mocks = registry();
      mocks.setMock("./styles.css", caller, () => ({ card: "card" }));
      expect(mocks.hasMockFor(mocks["keyFor"]("./styles.css", caller, true))).to.equal(true);
    });
  });
});
