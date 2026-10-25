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
import { SILENT_REPORT } from "../support/Execute";
import { Computable } from "./Computable";
import { FileSet, IFile } from "./FileSet";
import { FileSetRef } from "./FileSetRef";
import { MemoryFile } from "./MemoryFS";
import { Name } from "./Name";
import { PackageFileSet, PackageGraphBuilder } from "./PackageFileSet";
import { NamespaceRef } from "./NamespaceRef";
import type { Reference } from "./Reference";
import { RequirementResolutionError } from "./Errors";
import { dependenciesOn, renamedAs, Repository, RepositoryLookup, RepositoryPublishRef, RepositoryRef, RepositoryWriter } from "./Repository";
import { ResolutionContext } from "../resolver/Types";
import { bindProvided, collectLists } from "../context/CollectionPoint";
import { parseName } from "../model/Parser";

/** applyTo reads only the reference itself, never its source. */
const SOURCE = {} as unknown as RepositoryLookup;

function ref(written: string): RepositoryRef {
  return RepositoryRef.written(SOURCE, parseName(written));
}

function pkg(name: string, version = "1.0.0", dependencies: PackageFileSet[] = []): PackageFileSet {
  return new PackageFileSet(new Map([["index.js", MemoryFile.from("")]]), name, version, dependenciesOn(...dependencies));
}

describe("RepositoryRef.applyTo", () => {
  it("delivers a package unchanged when the reference carries no rename", () => {
    const delivered = ref("stream-browserify:3.0.0").applyTo(pkg("stream-browserify", "3.0.0"));
    expect((delivered as PackageFileSet).packageName).to.equal("stream-browserify");
  });

  it("restamps the delivered package when the identity half carries a rename", () => {
    /* `-> ` renames what the reference delivers; at the identity half that is a
     * package, so the rename is its mount identity — the npm dependency alias
     * ("stream": "npm:stream-browserify@^3") written the other way round. */
    const inner = pkg("readable-stream", "2.0.0");
    const delivered = ref("stream-browserify:3.0.0 -> stream").applyTo(pkg("stream-browserify", "3.0.0", [inner]));
    const renamed = delivered as PackageFileSet;
    expect(renamed.packageName).to.equal("stream");
    expect(renamed.packageId).to.equal("stream@3.0.0");
    /* Only the identity changes: content, version and the closure — which still
     * resolves among itself under the real names — are the delivery's own. */
    expect([...renamed].map(([name]) => name)).to.deep.equal(["index.js"]);
    expect(renamed.packages).to.deep.equal([inner]);
  });

  it("leaves the package alone when the rename rides a projection", () => {
    /* The facet reaches exactly one half: a repository splits its reference at
     * the projection boundary, so a projected rename renames the files it
     * selects and the delivered package keeps its own name. */
    const projected = ref("stream-browserify:3.0.0").find(parseName("lib/*.js -> *.mjs"));
    const delivered = projected.applyTo(pkg("stream-browserify", "3.0.0"));
    expect(delivered).to.be.instanceOf(FileSetRef);
    expect((delivered as FileSetRef).source).to.be.instanceOf(PackageFileSet);
    expect(((delivered as FileSetRef).source as PackageFileSet).packageName).to.equal("stream-browserify");
  });

  it("rejects a rename of a delivery that is not a package", () => {
    /* Only a package has an identity to rename; a plain fileset has no name a
     * rename could be about, so this is an error rather than a silent no-op. */
    const files = new FileSet(new Map([["a.txt", MemoryFile.from("")]]));
    expect(() => ref("something:1.0.0 -> other").applyTo(files)).to.throw(/does not deliver a package/);
  });
});

describe("renamedAs", () => {
  /* The rule itself, shared by both delivery sites — an external package's (via
   * applyTo, above) and a target's (BuildContextImpl.lookupFileSource). */

  it("carries the rename onward when the delivery is still deferred", () => {
    /* A reference that has not been delivered yet cannot be restamped, so the
     * facet rides it — reaching this same rule again at its collection point. */
    const deferred = renamedAs(ref("stream-browserify:3.0.0"), "stream", "written");
    expect(deferred).to.be.instanceOf(RepositoryRef);
    expect((deferred as RepositoryRef).renameTo).to.equal("stream");
    /* And it means the same thing when it lands. */
    const delivered = (deferred as RepositoryRef).applyTo(pkg("stream-browserify", "3.0.0"));
    expect((delivered as PackageFileSet).packageName).to.equal("stream");
  });

  it("refuses a reference whose own projection already renames files", () => {
    /* Its delivery is files, not a package — the two readings of `-> ` must not
     * both apply to one reference. */
    const projected = ref("pkg:1.0.0").find(parseName("lib/*.js -> *.mjs"));
    expect(() => renamedAs(projected, "other", "written")).to.throw(/does not deliver a package/);
  });
});

/** A repository that answers every reference with a one-file package. */
class StubRepository implements Repository {
  public getRepositoryRef(name: Name): RepositoryRef {
    return RepositoryRef.written(this, name);
  }

  public getRepositoryPublishRef(name: Name): never {
    throw new Error(`not a publish destination ('${name.toString()}')`);
  }

  public resolve(reference: RepositoryRef): Computable<FileSet> {
    const name = reference.name.toString();
    return Computable.resolve(new PackageFileSet(new Map<string, IFile>([["index.js", MemoryFile.from(`// ${name}`)]]), name, "1.0.0"));
  }
}

describe("NamespaceRef", () => {
  /** A repository vending every reference and publish ref it is asked for, as
   *  asked. */
  class VendingRepository implements Repository, RepositoryLookup {
    public getRepositoryRef(name: Name): RepositoryRef {
      return RepositoryRef.written(this, name);
    }

    public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
      const [coordinate, version] = name.toString().split(":");
      return new RepositoryPublishRef({} as RepositoryWriter, { name: coordinate, version });
    }

    public resolve(): Computable<FileSet> {
      throw new Error("not resolved");
    }
  }
  const vending = new VendingRepository();

  it("vends a reference within its namespace, stamped with the repository's written name", () => {
    const scope = new NamespaceRef(vending, "@acme", undefined, "@registry");
    const ref = scope.getRepositoryRef(Name.fromLiteral("widget"), "/") as RepositoryRef;
    expect(ref.name).to.equal("@acme/widget");
    expect(ref.repositoryName).to.equal("@registry");
    expect((new NamespaceRef(vending).getRepositoryRef(Name.fromLiteral("widget"), ":") as RepositoryRef).name).to.equal("widget");
  });

  it("is completed by the rest of the name, after the separator it was written with", () => {
    const pkg = new NamespaceRef(vending, "widget");
    expect((pkg.getRepositoryRef(Name.fromLiteral("1.0.0"), ":") as RepositoryRef).name).to.equal("widget:1.0.0");
    expect((pkg.getRepositoryRef(Name.fromLiteral("core"), "/") as RepositoryRef).name).to.equal("widget/core");
    expect(pkg.refused().message).to.equal("'widget' is not a complete reference, so it names no package or files");
  });

  it("lists its children as the repository lists them, handed the reference", async () => {
    const asked: NamespaceRef[] = [];
    class ListingRepository extends VendingRepository {
      public children(ref: NamespaceRef): Computable<Map<string, Reference>> {
        asked.push(ref);
        return Computable.resolve(
          new Map<string, Reference>([
            ["widget", new RepositoryRef(this, { name: `${ref.name}/widget`, versionConstraint: undefined })],
            ["@inner", new NamespaceRef(this, `${ref.name}/@inner`)],
          ])
        );
      }
    }
    const scope = new NamespaceRef(new ListingRepository(), "@acme", undefined, "@registry");
    const children = await toPromise(scope.children());
    expect(asked).to.deep.equal([scope]);
    expect([...children.keys()]).to.deep.equal(["widget", "@inner"]);
    expect((children.get("widget") as RepositoryRef).name).to.equal("@acme/widget");
  });

  it("refuses to list a repository that lists nothing, attributed to itself", async () => {
    const scope = new NamespaceRef(vending, "@acme", undefined, "@registry");
    const err = await toPromise(scope.children()).then(
      () => undefined,
      (rejected: Error) => rejected
    );
    expect(err).to.be.instanceOf(RequirementResolutionError);
    expect((err as RequirementResolutionError).refs).to.deep.equal([scope]);
    expect(err?.message).to.equal("'@registry:@acme' cannot be listed");
  });

  it("vends a publish ref within its namespace, as it does a reference", () => {
    const scope = new NamespaceRef(vending, "@acme", undefined, "@registry");
    expect(scope.getRepositoryPublishRef(Name.fromLiteral("widget:1.0.0"), "/", "@acme").toString()).to.equal("@acme:@acme/widget:1.0.0");
    expect(scope.getRepositoryPublishRef(Name.fromLiteral("widget:1.0.0"), "/").toString()).to.equal("@registry:@acme/widget:1.0.0");
  });
});

/** The consuming-side surface the resolution layer wants — enough for tests
 * whose repositories deliver per reference (nothing joint to memoize). */
const RESOLUTION_CONTEXT: ResolutionContext = {
  name: "test",
  getGlobalString: () => Computable.resolve("build"),
  launchedBy: (_runnable, name) => Computable.reject(new Error(`no global '${name}' in this test`)),
  memoize: (_tag, _key, create) => create("unused"),
  runTask: (_task, run) => run(SILENT_REPORT),
};

function toPromise<T>(computable: Computable<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

function graphFiles(tag: string): Map<string, IFile> {
  return new Map([["index.js", MemoryFile.from(`// ${tag}`)]]);
}

describe("collecting over cyclic package graphs", () => {
  it("passes a ref-free cyclic delivered graph through untouched", async () => {
    const builder = new PackageGraphBuilder();
    const a = builder.node(graphFiles("a"), "a", "1.0.0");
    const b = builder.node(graphFiles("b"), "b", "1.0.0");
    builder.wire(a, dependenciesOn(b));
    builder.wire(b, dependenciesOn(a));
    builder.seal();

    const [[delivered]] = await toPromise(collectLists(RESOLUTION_CONTEXT, [[a]]));
    /* Nothing to resolve beneath it, so the very same value comes back — no
     * copy, no infinite walk. */
    expect(delivered).to.equal(a);
  });

  it("rebuilds a ref-carrying cycle, resolving the ref and preserving the cycle", async () => {
    /* app ↔ buddy, with app also carrying an unresolved external requirement:
     * the shape the collection point must rebuild honestly — buddy must not
     * come back with the raw ref still inside it. */
    const repo = new StubRepository();
    const external = repo.getRepositoryRef(Name.fromLiteral("dep"));
    const builder = new PackageGraphBuilder();
    const app = builder.node(graphFiles("app"), "app", "1.0.0");
    const buddy = builder.node(graphFiles("buddy"), "buddy", "1.0.0");
    builder.wire(app, [...dependenciesOn(buddy), { reference: external }]);
    builder.wire(buddy, dependenciesOn(app));
    builder.seal();

    const [[delivered]] = await toPromise(collectLists(RESOLUTION_CONTEXT, [[app]]));
    const rebuiltApp = delivered as PackageFileSet;
    expect(rebuiltApp).to.be.instanceOf(PackageFileSet);
    expect(rebuiltApp).to.not.equal(app);
    const names = rebuiltApp.packages.map(dep => dep.packageName);
    expect(names).to.deep.equal(["buddy", "dep"]);
    /* The cycle survives the rebuild, closed over the REBUILT instances. */
    const rebuiltBuddy = rebuiltApp.packages[0];
    expect(rebuiltBuddy.packages).to.deep.equal([rebuiltApp]);

    /* Entering at the other node of the cycle judges the same way: buddy
     * reaches the ref through the cycle, so it too must rebuild. */
    const [[second]] = await toPromise(collectLists(RESOLUTION_CONTEXT, [[buddy]]));
    const secondBuddy = second as PackageFileSet;
    expect(secondBuddy).to.not.equal(buddy);
    const secondApp = secondBuddy.packages[0];
    expect(secondApp.packages.map(dep => dep.packageName)).to.deep.equal(["buddy", "dep"]);
    expect(secondApp.packages[0]).to.equal(secondBuddy);
  });
});

describe("bindProvided over cyclic package graphs", () => {
  const dependency = (of: PackageFileSet, name: string): PackageFileSet => of.packages.find(dep => dep.packageName === name)!;

  it("closes a cycle through a package something below it wants provided", () => {
    /* a ↔ b, and a's own dependency c wants `a` provided: the a beneath b is
     * supplied by itself, as the a at the top is. */
    const builder = new PackageGraphBuilder();
    const top = builder.node(graphFiles("top"), "top", "1.0.0");
    const a = builder.node(graphFiles("a"), "a", "1.0.0");
    const b = builder.node(graphFiles("b"), "b", "1.0.0");
    const c = builder.node(graphFiles("c"), "c", "1.0.0");
    builder.wire(top, dependenciesOn(a));
    builder.wire(a, dependenciesOn(b, c));
    builder.wire(b, dependenciesOn(a));
    builder.wire(c, dependenciesOn(a), new Map([["a", "expected"]]));
    builder.seal();

    const [bound] = bindProvided([top]) as PackageFileSet[];
    const boundA = dependency(bound, "a");
    expect(dependency(dependency(boundA, "b"), "a")).to.equal(boundA);
    expect(dependency(dependency(boundA, "c"), "a")).to.equal(boundA);
  });

  it("closes a cycle of two packages each wanted provided beneath the other", () => {
    /* sts ↔ oidc, both reaching `node`, whose dependencies want one each
     * provided (@aws-sdk/client-s3@3.600.0's shape). */
    const builder = new PackageGraphBuilder();
    const top = builder.node(graphFiles("top"), "top", "1.0.0");
    const sts = builder.node(graphFiles("sts"), "sts", "1.0.0");
    const oidc = builder.node(graphFiles("oidc"), "oidc", "1.0.0");
    const node = builder.node(graphFiles("node"), "node", "1.0.0");
    const ini = builder.node(graphFiles("ini"), "ini", "1.0.0");
    const tokens = builder.node(graphFiles("tokens"), "tokens", "1.0.0");
    builder.wire(top, dependenciesOn(sts, oidc));
    builder.wire(sts, dependenciesOn(oidc, node));
    builder.wire(oidc, dependenciesOn(sts, node));
    builder.wire(node, dependenciesOn(ini, tokens));
    builder.wire(ini, dependenciesOn(sts), new Map([["sts", "expected"]]));
    builder.wire(tokens, dependenciesOn(oidc), new Map([["oidc", "expected"]]));
    builder.seal();

    const [bound] = bindProvided([top]) as PackageFileSet[];
    const boundSts = dependency(bound, "sts");
    const boundOidc = dependency(bound, "oidc");
    expect(dependency(boundSts, "oidc")).to.equal(boundOidc);
    expect(dependency(boundOidc, "sts")).to.equal(boundSts);
    const boundNode = dependency(boundSts, "node");
    expect(dependency(boundOidc, "node")).to.equal(boundNode);
    expect(dependency(dependency(boundNode, "ini"), "sts")).to.equal(boundSts);
    expect(dependency(dependency(boundNode, "tokens"), "oidc")).to.equal(boundOidc);
  });

  it("keeps a package on a cycle apart where its dependents supply different packages", () => {
    /* q ↔ loop, q wanting `r` provided; p1 and p2 each depend on q and on an
     * r of their own. */
    const builder = new PackageGraphBuilder();
    const top = builder.node(graphFiles("top"), "top", "1.0.0");
    const p1 = builder.node(graphFiles("p1"), "p1", "1.0.0");
    const p2 = builder.node(graphFiles("p2"), "p2", "1.0.0");
    const q = builder.node(graphFiles("q"), "q", "1.0.0");
    const loop = builder.node(graphFiles("loop"), "loop", "1.0.0");
    const r1 = builder.node(graphFiles("r1"), "r", "1.0.0");
    const r2 = builder.node(graphFiles("r2"), "r", "2.0.0");
    builder.wire(top, dependenciesOn(p1, p2));
    builder.wire(p1, dependenciesOn(q, r1));
    builder.wire(p2, dependenciesOn(q, r2));
    builder.wire(q, dependenciesOn(loop, r1), new Map([["r", "expected"]]));
    builder.wire(loop, dependenciesOn(q));
    builder.wire(r1, []);
    builder.wire(r2, []);
    builder.seal();

    const [bound] = bindProvided([top]) as PackageFileSet[];
    const under = (parent: string): PackageFileSet => dependency(dependency(bound, parent), "q");
    expect(dependency(under("p1"), "r").version).to.equal("1.0.0");
    expect(dependency(under("p2"), "r").version).to.equal("2.0.0");
    expect(under("p1")).to.not.equal(under("p2"));
    expect(dependency(dependency(under("p2"), "loop"), "q")).to.equal(under("p2"));
  });
});
