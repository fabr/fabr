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
import { ResolvedRequirements, ResolvedTarget } from "./context/index";
import { Computable } from "./core/Computable";
import { FabrError } from "./core/Errors";
import { EMPTY_FILESET, FileSource } from "./core/FileSet";
import { Dependency, PackageFileSet, ResolvedNode } from "./core/PackageFileSet";
import { RefSource, RepositoryRef } from "./core/Repository";
import { TargetRef, TargetSource } from "./core/TargetRef";
import { IPropertyDecl } from "./model/AST";
import { Constraints } from "./model/Constraints";
import { IModelStep, MODEL_PROVENANCE } from "./model/ModelProvenance";
import { PackageFormat } from "./resolver/PackageFormat";
import { IResolutionOrigin, PACKAGE_RESOLUTION_PROVENANCE } from "./resolver/ResolutionProvenance";
import { NO_CONFLICTS } from "./resolver/StrictCollection";
import { Selected } from "./resolver/Types";
import { sarifLocation } from "./support/Sarif";
import { StringReader } from "./support/StringReader";

import {
  Advisory,
  AdvisoryServer,
  affectsAny,
  audit,
  auditedPackages,
  AuditedPackage,
  auditSarif,
  fixedVersions,
  ResolvedName,
  toAdvisory,
  toQueryResults,
} from "./Audit";

/** A format whose purls are `pkg:test/<name>@<version>` and whose versions are
 * dotted numbers; nothing here resolves with it. */
const TEST_FORMAT = {
  purl: (name: string, version: string) => `pkg:test/${name}@${version}`,
  parseVersion: (text: string) => {
    if (!/^\d+(\.\d+)*$/.test(text)) {
      throw new FabrError(`not a version: ${text}`);
    }
    return text.split(".").map(Number);
  },
  compare: (a: number[], b: number[]) => {
    for (let at = 0; at < Math.max(a.length, b.length); at++) {
      const difference = (a[at] ?? 0) - (b[at] ?? 0);
      if (difference !== 0) {
        return difference;
      }
    }
    return 0;
  },
} as unknown as PackageFormat<unknown, unknown>;

/** The package `name` at `version` as the audit lists it, reached by no tree. */
function audited(name: string, version: string): AuditedPackage {
  return { purl: `pkg:test/${name}@${version}`, packageName: name, version, format: TEST_FORMAT, paths: [] };
}

/** The provenance of a package resolved from a registry of {@link TEST_FORMAT},
 * among `selections`. */
function resolvedFrom(selections: Array<Selected<string>>): IResolutionOrigin<string> {
  return {
    kind: PACKAGE_RESOLUTION_PROVENANCE,
    root: { name: "root", versionConstraint: undefined },
    selections,
    versionToString: version => version,
    format: TEST_FORMAT,
  };
}

function reference(name: string, versionConstraint?: string): RepositoryRef {
  return new RepositoryRef({} as RefSource, { name, versionConstraint });
}

/** A registry package at `version`, resolved and unfetched, as the edge its reference makes. */
function registry(name: string, version: string, dependencies: Dependency[] = [], publishedName?: string): Dependency {
  const origin = resolvedFrom([{ name, version, ...(publishedName === undefined ? {} : { publishedName }) }]);
  const content = { key: `fetch ${name}@${version}`, files: () => Computable.resolve(EMPTY_FILESET) };
  return { reference: reference(name, `^${version}`), package: new ResolvedNode(content, name, version, dependencies, origin) };
}

/** A target's node, resolved and unbuilt, as the edge the reference to it makes. */
function built(name: string, dependencies: Dependency[] = []): Dependency {
  return {
    reference: new TargetRef({} as TargetSource, name),
    package: new ResolvedNode(
      { key: `built ${name}`, files: () => Computable.resolve(EMPTY_FILESET), builds: name },
      name,
      undefined,
      dependencies,
      { kind: "target" }
    ),
  };
}

/** A target made from the package `from` is the edge to, as `patched` makes one: named as the
 * target is, at that package's version and with its requirements, its build declared to fix `fixes`. */
class PatchedTarget extends ResolvedTarget {
  public readonly resolved: ResolvedRequirements;

  constructor(name: string, from: Dependency, fixes: string[]) {
    const pkg = from.package!;
    super({ key: `built ${name}`, files: () => Computable.resolve(EMPTY_FILESET), builds: name }, name, pkg.version, pkg.dependencies, {
      kind: "target",
    });
    this.resolved = new ResolvedRequirements(
      new Map([["extends", { sources: [pkg], references: [from.reference], reading: "packages", part: 0 }]]) as never,
      [{ conflicts: NO_CONFLICTS, conflictsAmong: () => Computable.resolve(NO_CONFLICTS) }],
      false,
      undefined,
      fixes
    );
  }

  public materialize(): Computable<never[]> {
    return Computable.resolve([]);
  }

  public projectBuilt(): never[] {
    return [];
  }
}

/** The patched target `name` made from `from`, fixing `fixes`, as the edge the reference to it makes. */
function patched(name: string, from: Dependency, fixes: string[]): Dependency {
  return { reference: new TargetRef({} as TargetSource, name), package: new PatchedTarget(name, from, fixes) };
}

/** What `title` resolved to: the packages `deps` are the edges to, as one unnamed list. */
function named(title: string, deps: Dependency[]): ResolvedName {
  return {
    title,
    resolved: ResolvedRequirements.of(
      deps.map(dep => dep.package!),
      deps.map(dep => dep.reference),
      NO_CONFLICTS
    ),
  };
}

/** A server answering from `advisories`, each affecting the purls listed for it. */
function server(advisories: Array<[Advisory, string[]]>): AdvisoryServer & { queries: string[][] } {
  const queries: string[][] = [];
  return {
    queries,
    query: purls => {
      queries.push([...purls]);
      return Computable.resolve(
        purls.map(purl => advisories.filter(([, affected]) => affected.includes(purl)).map(([advisory]) => advisory.id))
      );
    },
    advisory: id => {
      const found = advisories.find(([advisory]) => advisory.id === id);
      return found ? Computable.resolve(found[0]) : Computable.reject(new FabrError(`no advisory ${id}`));
    },
  };
}

const LODASH: Advisory = {
  id: "GHSA-35jh-r3h4-6jhm",
  aliases: ["CVE-2021-23337"],
  summary: "Command Injection in lodash",
  severity: "HIGH",
  url: "https://github.com/advisories/GHSA-35jh-r3h4-6jhm",
  affected: [{ purl: "pkg:test/lodash", fixed: ["4.17.21"] }],
};

const MINIMIST: Advisory = {
  id: "GHSA-xvch-5gv4-984h",
  aliases: [],
  summary: "Prototype Pollution in minimist",
  severity: "CRITICAL",
  affected: [
    { purl: "pkg:test/minimist", fixed: ["0.2.4"] },
    { purl: "pkg:test/minimist", fixed: ["1.2.6"] },
  ],
};

describe("auditedPackages", () => {
  it("lists each registry package once, at its exact version, with the first path per tree and the count of its other edges", () => {
    const lodash = registry("lodash", "4.17.15");
    const app = named("app", [
      registry("express", "4.17.1", [lodash]),
      lodash,
      registry("yargs", "17.0.0", [lodash]),
      registry("chai", "4.3.6"),
    ]);
    const tool = named("tool", [lodash]);
    expect(auditedPackages([app, tool])).to.deep.equal([
      { ...audited("chai", "4.3.6"), paths: [{ path: ["app", "chai@4.3.6"], others: 0 }] },
      { ...audited("express", "4.17.1"), paths: [{ path: ["app", "express@4.17.1"], others: 0 }] },
      {
        ...audited("lodash", "4.17.15"),
        paths: [
          { path: ["app", "express@4.17.1", "lodash@4.17.15"], others: 2 },
          { path: ["tool", "lodash@4.17.15"], others: 0 },
        ],
      },
      { ...audited("yargs", "17.0.0"), paths: [{ path: ["app", "yargs@17.0.0"], others: 0 }] },
    ]);
  });

  it("walks through a package built in the project and asks about nothing of it", () => {
    const lib = built("lib", [registry("semver", "7.6.3")]);
    expect(auditedPackages([named("app", [lib])])).to.deep.equal([
      { ...audited("semver", "7.6.3"), paths: [{ path: ["app", "lib", "semver@7.6.3"], others: 0 }] },
    ]);
  });

  it("asks about a target made from a registry package as that package, apart from the package itself", () => {
    const semver = registry("semver", "7.6.3");
    const lodash = registry("lodash", "4.17.15", [semver]);
    const app = named("app", [built("lib", [patched("lodash", lodash, ["CVE-2021-23337"])])]);
    const tool = named("tool", [lodash]);
    expect(auditedPackages([app, tool])).to.deep.equal([
      { ...audited("lodash", "4.17.15"), paths: [{ path: ["tool", "lodash@4.17.15"], others: 0 }] },
      {
        ...audited("lodash", "4.17.15"),
        paths: [{ path: ["app", "lib", "lodash@4.17.15"], others: 0 }],
        patchedBy: { target: "lodash", fixes: ["CVE-2021-23337"] },
      },
      {
        ...audited("semver", "7.6.3"),
        paths: [
          { path: ["app", "lib", "lodash@4.17.15", "semver@7.6.3"], others: 0 },
          { path: ["tool", "lodash@4.17.15", "semver@7.6.3"], others: 0 },
        ],
      },
    ]);
  });

  it("asks about a renamed package under the name the registry publishes it as", () => {
    const aliased = registry("wrap-ansi-cjs", "7.0.0", [], "wrap-ansi");
    expect(auditedPackages([named("app", [aliased])]).map(pkg => pkg.purl)).to.deep.equal(["pkg:test/wrap-ansi@7.0.0"]);
  });

  it("leaves out a package whose provenance holds no resolution", () => {
    const installed: Dependency = {
      reference: reference("sass"),
      package: new PackageFileSet([], "sass", "1.0.0", [], { kind: "fabr-home" }),
    };
    expect(auditedPackages([named("app", [installed])])).to.deep.equal([]);
  });
});

/** The build file the written references below sit in. */
const BUILD_FILE = "js_package app {\n  deps = @npm:lodash:^4;\n}\n";
const BUILD_FS = {} as FileSource;

/** `dependency` as written in {@link BUILD_FILE} at `offset`, for `length` characters. */
function written(dependency: Dependency, offset: number, length: number): Dependency {
  /* A reader knows the lines it has read: the parser reads the whole file. */
  const reader = new StringReader(BUILD_FILE);
  while (!reader.eof()) {
    reader.next();
  }
  const step: IModelStep = {
    kind: MODEL_PROVENANCE,
    value: {
      value: dependency.reference.name as never,
      offset,
      endOffset: offset + length,
      source: { fs: BUILD_FS, file: "PROJECT.fabr", reader },
    } as never,
    constraints: Constraints.of({}),
    property: {} as IPropertyDecl,
  };
  return { ...dependency, reference: dependency.reference.withStep(step) };
}

describe("auditSarif", () => {
  it("writes each advisory as a rule and each affected package as a result, located where the project requires it", async () => {
    const lodash = registry("lodash", "4.17.15");
    const names = [named("app", [written(registry("express", "4.17.1", [lodash]), 26, 14)])];
    const report = await audit(names, server([[LODASH, ["pkg:test/lodash@4.17.15"]]]));
    const log = auditSarif(report, { version: "1.2.3" }, site => (site.fs === BUILD_FS ? sarifLocation(site) : undefined));
    expect(log.$schema).to.match(/sarif-2\.1\.0/);
    expect(log.runs[0].properties).to.deep.equal({ packagesChecked: 2 });
    expect(log.runs[0].tool.driver).to.deep.equal({
      name: "fabr",
      version: "1.2.3",
      informationUri: "https://fabr.build/",
      rules: [
        {
          id: LODASH.id,
          shortDescription: { text: "Command Injection in lodash" },
          helpUri: LODASH.url,
          properties: { tags: ["security", "CVE-2021-23337"], "security-severity": "8.0" },
        },
      ],
    });
    expect(log.runs[0].results).to.deep.equal([
      {
        ruleId: LODASH.id,
        ruleIndex: 0,
        level: "error",
        message: { text: "lodash@4.17.15 (fixed in 4.17.21), required through app > express@4.17.1 > lodash@4.17.15" },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: "PROJECT.fabr", uriBaseId: "%SRCROOT%" },
              region: { startLine: 2, startColumn: 10, endLine: 2, endColumn: 24 },
            },
          },
        ],
        properties: {
          purl: "pkg:test/lodash@4.17.15",
          fixed: ["4.17.21"],
          paths: [{ path: ["app", "express@4.17.1", "lodash@4.17.15"], others: 0 }],
        },
      },
    ]);
  });

  it("writes a result a patched target fixes as suppressed in source", async () => {
    const names = [named("app", [built("lib", [patched("lodash", registry("lodash", "4.17.15"), [LODASH.id])])])];
    const report = await audit(names, server([[LODASH, ["pkg:test/lodash@4.17.15"]]]));
    const [result] = auditSarif(report, { version: "1.2.3" }, () => undefined).runs[0].results;
    expect(result.message.text).to.equal(
      "lodash@4.17.15 as patched by 'lodash' (fixed in 4.17.21), required through app > lib > lodash@4.17.15"
    );
    expect(result.suppressions).to.deep.equal([{ kind: "inSource", justification: "fixed by the patched target 'lodash'" }]);
    expect(result.properties).to.deep.include({ patchedBy: "lodash" });
  });

  it("locates nothing for a reference written outside the project, and rates an unrated advisory a warning", async () => {
    const names = [named("app", [registry("minimist", "0.0.8")])];
    const report = await audit(names, server([[{ ...MINIMIST, severity: undefined }, ["pkg:test/minimist@0.0.8"]]]));
    const log = auditSarif(report, { version: "1.2.3" }, () => undefined);
    expect(log.runs[0].tool.driver.rules[0].properties).to.deep.equal({ tags: ["security"] });
    expect(log.runs[0].results[0].level).to.equal("warning");
    expect(log.runs[0].results[0].locations).to.equal(undefined);
  });
});

describe("toAdvisory", () => {
  it("reads the id, aliases, summary, the database's rating, the advisory reference and the fixed versions", () => {
    const advisory = toAdvisory({
      id: "GHSA-1",
      aliases: ["CVE-1"],
      summary: "Bad",
      database_specific: { severity: "MODERATE" },
      references: [
        { type: "WEB", url: "https://example.com/blog" },
        { type: "ADVISORY", url: "https://nvd.nist.gov/vuln/detail/CVE-1" },
        { type: "ADVISORY", url: "https://github.com/advisories/GHSA-1" },
      ],
      affected: [
        {
          package: { ecosystem: "npm", name: "x", purl: "pkg:npm/x" },
          ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.2.3" }] }],
        },
      ],
    });
    expect(advisory).to.deep.equal({
      id: "GHSA-1",
      aliases: ["CVE-1"],
      summary: "Bad",
      severity: "MODERATE",
      url: "https://github.com/advisories/GHSA-1",
      affected: [{ purl: "pkg:npm/x", fixed: ["1.2.3"] }],
    });
  });

  it("takes the first line of the details where there is no summary, and reads a record stating little", () => {
    expect(toAdvisory({ id: "OSV-1", details: "First line.\nMore." })).to.deep.equal({
      id: "OSV-1",
      aliases: [],
      summary: "First line.",
      affected: [],
    });
    expect(() => toAdvisory({ summary: "no id" })).to.throw(/vulnerability record with an id/);
  });
});

describe("toQueryResults", () => {
  it("reads each query's advisory ids and its page token, in order", () => {
    expect(
      toQueryResults({
        results: [{ vulns: [{ id: "A", modified: "2024-01-01T00:00:00Z" }, { id: "B" }] }, {}, { vulns: [], next_page_token: "t" }],
      })
    ).to.deep.equal([{ ids: ["A", "B"] }, { ids: [] }, { ids: [], next: "t" }]);
    expect(() => toQueryResults({})).to.throw(/querybatch response/);
  });
});

describe("fixedVersions", () => {
  it("takes the fixed versions of the ranges naming the package, highest first, or of every range where none names one", () => {
    expect(fixedVersions(MINIMIST, audited("minimist", "0.0.8"))).to.deep.equal(["1.2.6", "0.2.4"]);
    expect(fixedVersions(LODASH, audited("other", "1.0.0"))).to.deep.equal([]);
    expect(
      fixedVersions({ ...LODASH, affected: [{ fixed: ["9.9.9", "10.0.0", "latest"] }] }, audited("other", "1.0.0"))
    ).to.deep.equal(["10.0.0", "9.9.9", "latest"]);
  });
});

describe("audit", () => {
  it("queries every package in one batch and reports each advisory against the packages it affects, worst first", async () => {
    const lodash = registry("lodash", "4.17.15");
    const minimist = registry("minimist", "0.0.8");
    const names = [named("app", [registry("express", "4.17.1", [lodash]), minimist])];
    const answers = server([
      [LODASH, ["pkg:test/lodash@4.17.15"]],
      [MINIMIST, ["pkg:test/minimist@0.0.8"]],
    ]);
    const report = await audit(names, answers);
    expect(answers.queries).to.deep.equal([["pkg:test/express@4.17.1", "pkg:test/lodash@4.17.15", "pkg:test/minimist@0.0.8"]]);
    expect(report.findings.map(finding => finding.advisory.id)).to.deep.equal([MINIMIST.id, LODASH.id]);
    expect(report.findings[1].packages.map(pkg => pkg.purl)).to.deep.equal(["pkg:test/lodash@4.17.15"]);
  });

  it("asks nothing where there is nothing to ask about, and says so", async () => {
    const answers = server([]);
    const report = await audit([named("app", [built("lib")])], answers);
    expect(answers.queries).to.deep.equal([]);
    expect(report).to.deep.equal({ packages: [], findings: [], unmatched: [] });
  });

  it("reports an advisory a patched target declares it fixes, by id or alias, as fixed there, and a declared fix nothing bears out", async () => {
    const lodash = registry("lodash", "4.17.15");
    const OTHER: Advisory = { ...LODASH, id: "GHSA-p6mc-m468-83gw", aliases: [], severity: "LOW" };
    const names = [named("app", [built("lib", [patched("lodash", lodash, ["CVE-2021-23337", "GHSA-none"])])]), named("tool", [lodash])];
    const answers = server([
      [LODASH, ["pkg:test/lodash@4.17.15"]],
      [OTHER, ["pkg:test/lodash@4.17.15"]],
    ]);
    const report = await audit(names, answers);
    expect(answers.queries).to.deep.equal([["pkg:test/lodash@4.17.15"]]);
    const [plain, made] = report.packages;
    expect(report.findings.map(({ advisory, packages, fixed }) => [advisory.id, packages, fixed])).to.deep.equal([
      [LODASH.id, [plain], [made]],
      [OTHER.id, [plain, made], []],
    ]);
    expect(report.unmatched).to.deep.equal([{ target: "lodash", id: "GHSA-none", pkg: made }]);
    expect(affectsAny(report)).to.equal(true);
    const fixedOnly = await audit([names[0]], server([[LODASH, ["pkg:test/lodash@4.17.15"]]]));
    expect(affectsAny(fixedOnly)).to.equal(false);
  });
});
