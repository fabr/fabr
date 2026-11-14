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
import { createRequire, Module } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { makeResolveHook, MockRegistry, NOT_MOCKED } from "./Registry";
import { installRootOf, isRegistryModule } from "./Tools";

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
    /* Real, as node keys its module cache by real path (macOS's tmpdir is under a symlink). */
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-registry-")));
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
  /* Only node's loader can evict a module: under the devchain's jest the
   * registry loads through jest's, whose require.cache is a view. */
  const nodeLoads = createRequire(__filename).cache === (Module as unknown as { _cache: unknown })._cache;
  /* A reset evicts every module but the runner's own, the host process's among
   * them: put back what it evicted from outside the fixture, so the process
   * running these tests keeps its modules. */
  const keepingHostModules = (fn: () => void): void => {
    const cache = createRequire(__filename).cache;
    const held = Object.entries(cache).filter(([filename]) => !filename.startsWith(dir + path.sep));
    try {
      fn();
    } finally {
      for (const [filename, module] of held) {
        cache[filename] ??= module;
      }
    }
  };

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

    /* As jest does: a module the real one imports, which imports it back, would
     * otherwise stay cached bound to the real module, and the code under test
     * would get that copy rather than one bound to the mock. */
    (nodeLoads ? it : it.skip)("loads the real module in isolation, so a module that imports it back is loaded again", () => {
      fs.writeFileSync(path.join(dir, "build", "cycle.js"), `require("./back"); module.exports = { real: true };`);
      fs.writeFileSync(
        path.join(dir, "build", "back.js"),
        `globalThis.backLoads = (globalThis.backLoads ?? 0) + 1; module.exports = { cycle: require("./cycle") };`
      );
      const loads = globalThis as { backLoads?: number };
      delete loads.backLoads;
      const mocks = registry();
      mocks.setMock("./cycle", caller);

      expect(mocks.serve("./cycle", caller)).to.equal(AUTOMOCK);
      createRequire(caller.filename)("./back");
      expect(loads.backLoads).to.equal(2);
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
      expect(() => registry().setMock("no-such-module-xyz", caller, () => ({}))).to.throw(/Cannot find module 'no-such-module-xyz'/);
    });

    it("registers by text under {virtual: true}", () => {
      const mocks = registry();
      mocks.setMock("no-such-module-xyz", caller, () => ({ virtual: true }), true);
      expect(mocks.serve("no-such-module-xyz", caller)).to.deep.equal({ virtual: true });
    });

    it("keys a virtual mock of a path by the file it names, so a require of that file by its absolute path finds it", () => {
      const mocks = registry();
      mocks.setMock("../config/test.json", caller, () => ({ token: "fixture" }), true);
      const elsewhere = { filename: path.join(dir, "build", "lib", "stack.js") };
      expect(mocks.serve(path.join(dir, "config", "test.json"), elsewhere)).to.deep.equal({ token: "fixture" });
    });

    it("registers an ASSET request by text — an unstaged stylesheet is still mockable", () => {
      const mocks = registry();
      mocks.setMock("./missing.css", caller, () => ({ stub: true }));
      expect(mocks.serve("./missing.css", caller)).to.deep.equal({ stub: true });
    });
  });

  describe("a core module", () => {
    it("is mocked for its node: name too, as jest does", () => {
      const mocks = registry();
      mocks.setMock("fs", caller, () => ({ mocked: true }));
      expect(mocks.serve("node:fs", caller)).to.deep.equal({ mocked: true });
    });
  });

  describe("isolateModules", () => {
    it("serves a mock made before it as the same instance inside it", () => {
      const mocks = registry();
      mocks.setMock("./nomock", caller, () => ({ instance: {} }));
      const outside = mocks.serve("./nomock", caller);

      expect(mocks.isolateModules(() => mocks.serve("./nomock", caller))).to.equal(outside);
    });

    it("drops a mock made inside it when it ends", () => {
      const mocks = registry();
      mocks.setMock("./nomock", caller, () => ({ instance: {} }));
      const inside = mocks.isolateModules(() => mocks.serve("./nomock", caller));

      expect(mocks.serve("./nomock", caller) === inside).to.equal(false);
    });

    (nodeLoads ? it : it.skip)("loads the code under test afresh inside it, and restores it after", () => {
      const load = createRequire(caller.filename);
      const before = load("./nomock");
      const mocks = registry();
      const inside = mocks.isolateModules(() => load("./nomock"));

      expect(inside === before).to.equal(false);
      expect(load("./nomock") === before).to.equal(true);
    });

    (nodeLoads ? it : it.skip)("loads an installed package afresh inside it too, as jest does", () => {
      write("node_modules/pkg/index.js", "{ instance: {} }");
      const load = createRequire(caller.filename);
      const before = load("pkg");
      const mocks = registry();
      const inside = mocks.isolateModules(() => load("pkg"));

      expect(inside === before).to.equal(false);
      expect(load("pkg") === before).to.equal(true);
    });
  });

  describe("resetModules", () => {
    (nodeLoads ? it : it.skip)("loads the code under test and installed packages afresh", () => {
      write("node_modules/pkg/index.js", "{ instance: {} }");
      const load = createRequire(caller.filename);
      const before = { own: load("./nomock"), installed: load("pkg") };
      keepingHostModules(() => registry().resetModules());

      expect(load("./nomock") === before.own).to.equal(false);
      expect(load("pkg") === before.installed).to.equal(false);
    });

    it("refuses to be nested, as jest does", () => {
      const mocks = registry();
      expect(() => mocks.isolateModules(() => mocks.isolateModules(() => undefined))).to.throw(/cannot be nested/);
    });

    it("ends an async isolation once its promise settles", async () => {
      const mocks = registry();
      mocks.setMock("./nomock", caller, () => ({ instance: {} }));
      const outside = mocks.serve("./nomock", caller);
      let inside: unknown;
      await mocks.isolateModulesAsync(async () => {
        await Promise.resolve();
        inside = mocks.serve("./nomock", caller);
      });

      expect(inside).to.equal(outside);
      expect(() => mocks.isolateModules(() => undefined)).to.not.throw();
    });
  });

  describe("the registry's modules", () => {
    /** Spell a POSIX path as the host does, as node names a module's file. */
    const at = (posix: string): string => path.normalize(posix);
    const RUNNER = "/cache/trees/runner";
    const runner = at(RUNNER);

    it("takes the runner's install to be the directory above the first node_modules on its path", () => {
      expect(installRootOf(at(`${RUNNER}/node_modules/.fabr/js-tools/node_modules/@fabr-build/js-tools/build`))).to.equal(runner);
      expect(installRootOf(at("/src/js-tools/build"))).to.equal(at("/src/js-tools/build"));
    });

    it("leaves out the runner's own machinery, jest's libraries among it", () => {
      expect(
        isRegistryModule(
          at(`${RUNNER}/node_modules/.fabr/js-tools/node_modules/@fabr-build/js-tools/build/jestRunner/child.js`),
          runner
        )
      ).to.equal(false);
      expect(
        isRegistryModule(at(`${RUNNER}/node_modules/.fabr/jest-mock@30.0.0/node_modules/jest-mock/build/index.js`), runner)
      ).to.equal(false);
    });

    it("holds a package in a node_modules tree beside the tests", () => {
      expect(isRegistryModule(at("/work/node_modules/.fabr/pkg@1.0.0/node_modules/pkg/index.js"), runner)).to.equal(true);
      expect(isRegistryModule(at("/work/build/thing.js"), runner)).to.equal(true);
    });

    it("holds a package in the tree pool, outside the tests' install, as a PnP layout places it", () => {
      expect(isRegistryModule(at("/cache/trees/1a2b3c/index.js"), runner)).to.equal(true);
      expect(isRegistryModule(at("/cache/trees/__virtual__/9f/0/1a2b3c/index.js"), runner)).to.equal(true);
    });

    it("leaves out a native addon", () => {
      expect(isRegistryModule(at("/cache/trees/1a2b3c/build/addon.node"), runner)).to.equal(false);
    });

    (nodeLoads ? it : it.skip)("loads a pool package afresh on resetModules", () => {
      write("pool/1a2b3c/index.js", "{ instance: {} }");
      const load = createRequire(caller.filename);
      const pooled = path.join(dir, "pool", "1a2b3c", "index.js");
      const before = load(pooled);
      keepingHostModules(() => registry().resetModules());

      expect(load(pooled) === before).to.equal(false);
    });
  });

  describe("enableAutomock", () => {
    it("automocks a module of the code under test", () => {
      const mocks = registry();
      mocks.setAutomockAll(true);
      expect(mocks.serve("./nomock", caller)).to.equal(AUTOMOCK);
    });

    it("never automocks a core module, by either name", () => {
      const mocks = registry();
      mocks.setAutomockAll(true);
      expect(mocks.serve("fs", caller)).to.equal(NOT_MOCKED);
      expect(mocks.serve("node:fs", caller)).to.equal(NOT_MOCKED);
    });
  });

  describe("the ES-module resolve hook", () => {
    it("serves a virtual mock of a path an import names relatively", () => {
      const mocks = registry();
      mocks.setMock("./x", caller, () => ({ virtual: true }), true);
      const missing = (): never => {
        throw new Error("Cannot find module './x'");
      };
      const resolved = makeResolveHook(mocks)("./x", { parentURL: pathToFileURL(caller.filename).href }, missing) as { url: string };
      expect(resolved.url.startsWith("fabr-mock:")).to.equal(true);
      expect(decodeURIComponent(resolved.url)).to.contain(path.join(dir, "build", "x"));
    });

    it("rethrows node's error for a missing module nothing mocks", () => {
      const missing = (): never => {
        throw new Error("Cannot find module './y'");
      };
      expect(() => makeResolveHook(registry())("./y", { parentURL: pathToFileURL(caller.filename).href }, missing)).to.throw(
        /Cannot find module/
      );
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
