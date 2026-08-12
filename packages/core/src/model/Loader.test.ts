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
import { BuildCache } from "../core/BuildCache";
import { FSFileSource } from "../core/FSFileSource";
import { Computable, ComputableSource, ComputableState } from "../core/Computable";
import { EMPTY_FILESET, FileSet, FileSource, IFile } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
import { Name } from "../core/Name";
import { LogFormatter, LogLevel } from "../support/Log";
import { DeclKind, isNameValue } from "./AST";
import { BuildModel } from "./BuildModel";
import { BuildFilesInvalidError } from "./Errors";
import { ExecutionContext } from "./ExecutionContext";
import { loadProject } from "./Loader";

/** A minimal ExecutionContext for the loader: the project tree as the source, an
 *  empty absolute source (these tests use NO_BASE, so no lib files are read). */
function exec(project: FileSource, log: LogFormatter): ExecutionContext {
  return new ExecutionContext(new BuildCache(".", log), log, project, EMPTY_FILESET);
}

/* Includes are now: core's STD.fabr (always, no explicit include — exercised by
 * the bootstrap/e2e against the real built lib/, not here), a `plugin` decl's
 * auto-included files (bootstrap/e2e against real @fabr-build/js), and explicit
 * path-relative `include ./p;`. There is no system include path. These unit tests
 * cover the include mechanics with a STUB base contribution whose `includes` are
 * empty, so they touch no real on-disk lib/ (unavailable under ts-jest). */

const NO_BASE = { includes: [] };

function files(entries: Record<string, string>): FileSet {
  return new FileSet(new Map(Object.entries(entries).map(([name, content]) => [name, MemoryFile.from(content)])));
}

async function load(project: FileSource, startFile: string): Promise<BuildModel> {
  const errors: string[] = [];
  const logger = new LogFormatter(LogLevel.Info, msg => errors.push(msg));
  const model = await loadProject(exec(project, logger), startFile, NO_BASE);
  expect(errors).to.deep.equal([]);
  return model;
}

function propertyValue(model: BuildModel, name: string): string | undefined {
  const entry = model.getDecl(name);
  if (entry?.kind !== DeclKind.Property) {
    return undefined;
  }
  /* Unguarded fixtures, so the sole declaration (or the `default` one, where
   * that is all there is) is the value. */
  const decl = entry.decls[0] ?? entry.defaults[0];
  return decl?.values.map(value => (isNameValue(value) ? value.value.toString() : "")).join(" ");
}

describe("Loader", () => {
  it("resolves explicit includes relative to the including file", async () => {
    const project = files({
      "PROJECT.fabr": "include sub/LIB.fabr;\nown = here;",
      "sub/LIB.fabr": "which = relative;",
    });
    const model = await load(project, "PROJECT.fabr");
    expect(propertyValue(model, "which")).to.equal("relative");
    expect(propertyValue(model, "own")).to.equal("here");
  });

  it("resolves a nested include relative to its own including file", async () => {
    const project = files({
      "PROJECT.fabr": "include sub/OUTER.fabr;",
      "sub/OUTER.fabr": "include INNER.fabr;\nouter = yes;",
      "sub/INNER.fabr": "inner = yes;",
    });
    const model = await load(project, "PROJECT.fabr");
    expect(propertyValue(model, "outer")).to.equal("yes");
    expect(propertyValue(model, "inner")).to.equal("yes");
  });

  it("allows an include climbing within the project tree", async () => {
    const project = files({
      "PROJECT.fabr": "include sub/OUTER.fabr;",
      "sub/OUTER.fabr": "include ../TOP.fabr;",
      "TOP.fabr": "top = yes;",
    });
    const model = await load(project, "PROJECT.fabr");
    expect(propertyValue(model, "top")).to.equal("yes");
  });

  it("includes every file a glob include matches", async () => {
    const project = files({
      "PROJECT.fabr": "include lib/*.fabr;\nown = here;",
      "lib/one.fabr": "one = yes;",
      "lib/two.fabr": "two = yes;",
      "lib/README.md": "not a build file",
    });
    const model = await load(project, "PROJECT.fabr");
    expect(propertyValue(model, "one")).to.equal("yes");
    expect(propertyValue(model, "two")).to.equal("yes");
    expect(propertyValue(model, "own")).to.equal("here");
  });

  it("matches a glob include at every depth, in canonical order", async () => {
    /* Written deepest-first so the tree's own order is not the sorted one: the
     * matches are sorted, making the model a function of which files exist and
     * not of the order a directory walk happened to hand them back. */
    const project = files({
      "PROJECT.fabr": "include lib/**/*.fabr;",
      "lib/sub/second.fabr": "second = 2;",
      "lib/first.fabr": "first = 1;",
    });
    const model = await load(project, "PROJECT.fabr");
    expect(model.getProperties().map(property => property.name)).to.deep.equal(["first", "second"]);
  });

  it("reports a glob include that matches nothing", async () => {
    /* One rule for both forms: an include must name at least one file. A pattern
     * that matches none is the same mistake as a path that isn't there — most
     * often a moved or renamed directory, which would otherwise go silent until
     * the declarations it should have contributed turned up missing. */
    const { error, logged } = await loadErr(files({ "PROJECT.fabr": "include lib/*.fabr;\nown = here;" }));
    expect(error).to.be.an.instanceOf(BuildFilesInvalidError);
    expect(logged.join("\n")).to.match(/lib\/\*\.fabr matched nothing/);
    expect(logged.join("\n")).to.match(/PROJECT\.fabr:1:9/);
  });

  it("reports an include naming a directory rather than including its contents", async () => {
    /* A projection would expand a bare directory to everything beneath it; an
     * include must not, since it parses whatever it names. */
    const { error, logged } = await loadErr(
      files({ "PROJECT.fabr": "include lib;", "lib/one.fabr": "one = yes;", "lib/README.md": "prose" })
    );
    expect(error).to.be.an.instanceOf(BuildFilesInvalidError);
    expect(logged.join("\n")).to.match(/Included file not found: lib/);
  });

  it("resolves a glob include, and its matches' own includes, file-relative", async () => {
    const project = files({
      "PROJECT.fabr": "include sub/OUTER.fabr;",
      "sub/OUTER.fabr": "include rules/*.fabr;",
      "sub/rules/one.fabr": "include ../SHARED.fabr;\none = yes;",
      "sub/SHARED.fabr": "shared = yes;",
    });
    const model = await load(project, "PROJECT.fabr");
    expect(propertyValue(model, "one")).to.equal("yes");
    expect(propertyValue(model, "shared")).to.equal("yes");
  });

  it("ignores a glob include matching the file that wrote it", async () => {
    const project = files({ "PROJECT.fabr": "include *.fabr;\nown = here;", "other.fabr": "other = yes;" });
    const model = await load(project, "PROJECT.fabr");
    expect(propertyValue(model, "own")).to.equal("here");
    expect(propertyValue(model, "other")).to.equal("yes");
  });

  it("expands a glob include written in an absolute (plugin lib) file", async () => {
    /* A lib file's includes resolve within its installed package, read through the
     * absolute source — whose keys keep the leading separator its root sheds. Real
     * files, since no in-memory FileSet can hold an absolute name. */
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-loader-lib-"));
    try {
      fs.mkdirSync(path.join(root, "rules"));
      fs.writeFileSync(path.join(root, "LIB.fabr"), "include rules/*.fabr;\nlib = yes;\n");
      fs.writeFileSync(path.join(root, "rules", "one.fabr"), "one = yes;\n");
      const logged: string[] = [];
      const logger = new LogFormatter(LogLevel.Info, message => logged.push(message));
      const project = files({ "PROJECT.fabr": "own = here;" });
      const execution = new ExecutionContext(new BuildCache(".", logger), logger, project, new FSFileSource("/"));
      const model = await loadProject(execution, "PROJECT.fabr", { includes: [path.join(root, "LIB.fabr")] });
      expect(logged).to.deep.equal([]);
      expect(propertyValue(model, "lib")).to.equal("yes");
      expect(propertyValue(model, "one")).to.equal("yes");
      expect(propertyValue(model, "own")).to.equal("here");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("tolerates a glob-matched file that has vanished before it is read", async () => {
    /* The enumeration named the file and the read found it gone — deleted in
     * between, by an editor or a watch cycle dropping it. For a pattern that is
     * no error (nothing named it but the pattern, which no longer does): it
     * simply contributes nothing, silently. */
    const project = files({ "PROJECT.fabr": "include lib/*.fabr;\nown = here;", "lib/gone.fabr": "gone = yes;" });
    const vanishing: FileSource = {
      find: (name, prefix) => project.find(name, prefix),
      get: name => Computable.resolve(name === "lib/gone.fabr" ? undefined : project.getFile(name)),
    };
    const model = await load(vanishing, "PROJECT.fabr");
    expect(propertyValue(model, "own")).to.equal("here");
    expect(propertyValue(model, "gone")).to.equal(undefined);
  });

  it("blocks a glob include whose base climbs out of the project tree", async () => {
    const { error, logged } = await loadErr(files({ "PROJECT.fabr": "include ../*.fabr;" }));
    expect(error).to.be.an.instanceOf(BuildFilesInvalidError);
    expect(logged.join("\n")).to.match(/outside the project tree/);
    expect(logged.join("\n")).to.match(/PROJECT\.fabr:1:9/);
  });

  it("blocks an include outside the project tree, positioned at the include", async () => {
    const { error, logged } = await loadErr(files({ "PROJECT.fabr": "include ../outside.fabr;" }));
    /* A build-file error like any other — halting the load with a positioned
     * diagnostic, not a bare unattributed Error escaping the loader. */
    expect(error).to.be.an.instanceOf(BuildFilesInvalidError);
    expect(logged.join("\n")).to.match(/outside the project tree/);
    expect(logged.join("\n")).to.match(/PROJECT\.fabr:1:9/);
  });

  it("reports a missing include positioned at the include, then stops", async () => {
    const { error, logged } = await loadErr(files({ "PROJECT.fabr": "include missing.fabr;" }));
    /* Halts like any build-file error, and the diagnostic is a block naming the
     * missing file and pointing back at the `include` that wrote it. */
    expect(error).to.be.an.instanceOf(BuildFilesInvalidError);
    expect(logged.join("\n")).to.match(/Included file not found: missing\.fabr/);
    expect(logged.join("\n")).to.match(/PROJECT\.fabr:1:9/);
  });

  it("traces a missing include back through the whole include chain", async () => {
    const { error, logged } = await loadErr(
      files({
        "PROJECT.fabr": "include mid.fabr;",
        "mid.fabr": "include gone.fabr;",
      })
    );
    expect(error).to.be.an.instanceOf(BuildFilesInvalidError);
    const out = logged.join("\n");
    /* Primary at the include that named the missing file, then a note per hop
     * back to the project file. */
    expect(out).to.match(/Included file not found: gone\.fabr[\s\S]*mid\.fabr:1:9/);
    expect(out).to.match(/included from here[\s\S]*PROJECT\.fabr:1:9/);
  });

  /* Parse and sema/validation recover to report every error rather than throwing;
   * the load as a whole must still reject so no operation builds against an
   * unsound model. Each error is reported to the log; the rejection just stops. */
  async function loadErr(project: FileSet): Promise<{ error?: Error; logged: string[] }> {
    const logged: string[] = [];
    const logger = new LogFormatter(LogLevel.Info, msg => logged.push(msg));
    let error: Error | undefined;
    try {
      await loadProject(exec(project, logger), "PROJECT.fabr", NO_BASE);
    } catch (err) {
      error = err as Error;
    }
    return { error, logged };
  }

  it("reports a plugin activation failure positioned at the declaration, then stops", async () => {
    const { error, logged } = await loadErr(files({ "PROJECT.fabr": "plugin @fabr/definitely-not-installed;" }));
    expect(error).to.be.an.instanceOf(BuildFilesInvalidError);
    const out = logged.join("\n");
    expect(out).to.match(/not installed/);
    expect(out).to.match(/PROJECT\.fabr:1:8/);
  });

  it("rejects the load when a build file has a syntax error (reported, then stops)", async () => {
    const { error, logged } = await loadErr(files({ "PROJECT.fabr": "good = value;\n@@@ not valid\n" }));
    expect(error).to.be.an.instanceOf(BuildFilesInvalidError);
    expect(logged.some(msg => /error/i.test(msg))).to.equal(true);
  });

  it("rejects the load when an included file has a syntax error", async () => {
    const { error } = await loadErr(
      files({ "PROJECT.fabr": "include bad.fabr;\ngood = value;", "bad.fabr": "@@@ not valid\n" })
    );
    expect(error).to.be.an.instanceOf(BuildFilesInvalidError);
  });

  it("counts every reported error", async () => {
    const { error } = await loadErr(files({ "PROJECT.fabr": "targetdef good { x = STRING; }\ngood a { y = 1; z = 2; }" }));
    /* Two unrecognized properties in one target -> two errors. */
    expect(error).to.be.an.instanceOf(BuildFilesInvalidError);
    expect((error as BuildFilesInvalidError).errorCount).to.equal(2);
  });
});

/* -- Watch mode ------------------------------------------------------------
 *
 * A glob include is the one include whose *file set* changes without any build
 * file being edited, so the loader must react to a matching file appearing or
 * disappearing exactly as it reacts to an edit. These drive that without a real
 * filesystem watcher: {@link LiveTree} hands out live queries and applies a
 * change in the two waves the real WatchController does — invalidate every live
 * query, then settle every live query — so the load never observes a
 * half-applied tree, as it never does in production. */

/** Let the (entirely in-memory) reactive graph run to a standstill. */
async function drain(): Promise<void> {
  for (let turn = 0; turn < 3; turn++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

/** A query the {@link LiveTree} keeps up to date. */
interface LiveSource {
  stale(): void;
  refresh(): void;
}

/** One live query over a {@link LiveTree}: settles from the tree's current
 * contents, re-reads them on reattach, and is re-settled by the tree on change —
 * the FSFileSource/TreeQuery contract, minus the filesystem. */
class LiveQuery<T> extends ComputableSource<T> implements LiveSource {
  /** Which refresh is authoritative, so a superseded one cannot settle over a newer. */
  private generation = 0;

  constructor(private readonly tree: LiveTree, private readonly derive: (files: FileSet) => Computable<T>) {
    super();
  }

  public stale(): void {
    if (this.state !== ComputableState.Detached) {
      this.invalidate();
    }
  }

  public refresh(): void {
    if (this.state === ComputableState.Detached) {
      return;
    }
    const generation = ++this.generation;
    this.derive(this.tree.contents()).then(value => {
      if (generation === this.generation && this.state !== ComputableState.Detached) {
        this.settle(ComputableState.Valid, value);
      }
    });
  }

  protected override attach(): void {
    super.attach();
    this.tree.register(this);
    this.refresh();
  }

  protected override detach(): void {
    this.tree.unregister(this);
    super.detach();
  }
}

/** A project tree that can change under a load in flight. */
class LiveTree implements FileSource {
  private current: FileSet;
  private readonly queries = new Set<LiveSource>();

  constructor(entries: Record<string, string>) {
    this.current = files(entries);
  }

  public contents(): FileSet {
    return this.current;
  }

  public register(query: LiveSource): void {
    this.queries.add(query);
  }

  public unregister(query: LiveSource): void {
    this.queries.delete(query);
  }

  public find(name: Name, prefix = ""): ComputableSource<FileSet> {
    return new LiveQuery<FileSet>(this, contents => contents.find(name, prefix));
  }

  public get(name: string): ComputableSource<IFile | undefined> {
    return new LiveQuery<IFile | undefined>(this, contents => Computable.resolve(contents.getFile(name)));
  }

  public write(name: string, content: string): Promise<void> {
    return this.change(entries => entries.set(name, MemoryFile.from(content)));
  }

  public remove(name: string): Promise<void> {
    return this.change(entries => entries.delete(name));
  }

  private async change(mutate: (entries: Map<string, IFile>) => void): Promise<void> {
    const entries = new Map<string, IFile>(this.current);
    mutate(entries);
    this.current = new FileSet(entries);
    const live = [...this.queries];
    live.forEach(query => query.stale());
    live.forEach(query => query.refresh());
    await drain();
  }
}

/** Every model (and failure) a load settles to, in order — the driver's own
 * observer, which re-fires on each revalidation. */
interface WatchedLoad {
  models: BuildModel[];
  failures: Error[];
  logged: string[];
}

function watchLoad(tree: LiveTree): WatchedLoad {
  const logged: string[] = [];
  const logger = new LogFormatter(LogLevel.Info, message => logged.push(message));
  const models: BuildModel[] = [];
  const failures: Error[] = [];
  loadProject(exec(tree, logger), "PROJECT.fabr", NO_BASE).then(
    model => models.push(model),
    err => failures.push(err as Error)
  );
  return { models, failures, logged };
}

function latest(load: WatchedLoad): BuildModel {
  expect(load.models.length).to.be.greaterThan(0);
  return load.models[load.models.length - 1];
}

describe("Loader (watch mode)", () => {
  it("picks up a build file added under a glob include", async () => {
    const tree = new LiveTree({ "PROJECT.fabr": "include lib/*.fabr;", "lib/one.fabr": "one = 1;" });
    const load = watchLoad(tree);
    await drain();
    expect(propertyValue(latest(load), "one")).to.equal("1");

    await tree.write("lib/two.fabr", "two = 2;");
    expect(load.models.length).to.equal(2);
    expect(propertyValue(latest(load), "two")).to.equal("2");
    expect(propertyValue(latest(load), "one")).to.equal("1");
    expect(load.failures).to.deep.equal([]);
  });

  it("recovers when the first file to match a glob include appears", async () => {
    const tree = new LiveTree({ "PROJECT.fabr": "include lib/*.fabr;\nown = here;" });
    const load = watchLoad(tree);
    await drain();
    /* Naming nothing is an error, so there is no model yet — and no intervention
     * needed either: the load re-settles green the moment a file matches. */
    expect(load.failures.length).to.equal(1);
    expect(load.models).to.deep.equal([]);

    await tree.write("lib/one.fabr", "one = 1;");
    expect(propertyValue(latest(load), "one")).to.equal("1");
    expect(propertyValue(latest(load), "own")).to.equal("here");
  });

  it("drops a build file removed from under a glob include, silently", async () => {
    const tree = new LiveTree({
      "PROJECT.fabr": "include lib/*.fabr;",
      "lib/one.fabr": "one = 1;",
      "lib/two.fabr": "two = 2;",
    });
    const load = watchLoad(tree);
    await drain();
    expect(propertyValue(latest(load), "two")).to.equal("2");

    await tree.remove("lib/two.fabr");
    /* Gone from the model — and its disappearance is not an error: the read of a
     * file the enumeration is in the middle of dropping must neither report a
     * missing include nor fail the load. */
    expect(propertyValue(latest(load), "two")).to.equal(undefined);
    expect(propertyValue(latest(load), "one")).to.equal("1");
    expect(load.failures).to.deep.equal([]);
    expect(load.logged).to.deep.equal([]);
  });

  it("fails when a glob include's last match goes, and re-includes it when it returns", async () => {
    const tree = new LiveTree({ "PROJECT.fabr": "include lib/*.fabr;", "lib/one.fabr": "one = 1;" });
    const load = watchLoad(tree);
    await drain();
    expect(propertyValue(latest(load), "one")).to.equal("1");

    await tree.remove("lib/one.fabr");
    expect(load.failures.length).to.equal(1);

    /* The dropped file's step detached; rediscovering it must re-read the file
     * rather than serve what it last saw. */
    await tree.write("lib/one.fabr", "one = 2;");
    expect(propertyValue(latest(load), "one")).to.equal("2");
    expect(load.failures.length).to.equal(1);
  });

  it("still fails when a plainly included file is removed", async () => {
    const tree = new LiveTree({ "PROJECT.fabr": "include lib/one.fabr;", "lib/one.fabr": "one = 1;" });
    const load = watchLoad(tree);
    await drain();
    expect(propertyValue(latest(load), "one")).to.equal("1");

    await tree.remove("lib/one.fabr");
    expect(load.failures.length).to.equal(1);
    expect(load.failures[0]).to.be.an.instanceOf(BuildFilesInvalidError);
    expect(load.logged.join("\n")).to.match(/Included file not found: lib\/one\.fabr/);
  });
});
