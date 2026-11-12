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

import { Computable } from "./core/Computable";
import { FabrError } from "./core/Errors";
import { sendRequest } from "./core/Fetch";
import { Dependency, Package } from "./core/PackageFileSet";
import { ResolvedTarget } from "./context/index";
import { madeFrom, nameEdges, ResolvedName, walkedEdges, WalkedEdge, walkReadingFiles } from "./Fabr";
import { declPosn } from "./model/AST";
import { IModelStep, MODEL_PROVENANCE } from "./model/ModelProvenance";
import { builtInProject } from "./model/Target";
import { PackageFormat } from "./resolver/PackageFormat";
import { formatOf, purlOf } from "./resolver/ResolutionProvenance";
import { isJsonObject, parseJson } from "./support/Json";
import { ISourceSpan } from "./support/Log";
import { compareText } from "./support/Functional";
import { decidingStatement, suppresses, VexStatement } from "./support/OpenVex";
import { ISarifLocation, ISarifLog, ISarifResult, ISarifRule, sarifLog } from "./support/Sarif";

/*
 * The audit behind `fabr audit`, without its rendering: a driver resolves the
 * names ({@link BuildContext.resolve}), passes them to {@link audit} with the
 * {@link AdvisoryServer} to ask, and renders the {@link AuditReport}, or
 * writes it as SARIF ({@link auditSarif}). No package is fetched and no target
 * built, and nothing the advisory database answers is cached.
 */

/** How a name's dependencies reach a package. */
export interface AuditedPath {
  /** The first path found: the name as written, then each package down to it, as `name@version`. */
  readonly path: ReadonlyArray<string>;
  /** How many other edges among the name's dependencies lead to the package. */
  readonly others: number;
  /** Where the first reference on the path that a build file wrote was written, where there is one. */
  readonly site?: ISourceSpan;
}

/** Get where `dependency`'s reference was written, where a build file wrote it. */
function siteOf(dependency: Dependency): ISourceSpan | undefined {
  const step = dependency.reference.steps.find(each => each.kind === MODEL_PROVENANCE) as IModelStep | undefined;
  return step === undefined ? undefined : declPosn(step.value);
}

/** One exact version of a package the audit asks about. */
export interface AuditedPackage {
  readonly purl: string;
  readonly packageName: string;
  readonly version: string;
  /** The format it was resolved in, whose versions the advisories' are. */
  readonly format: PackageFormat<unknown, unknown>;
  /** How each name reaches the package, one entry per name that does. */
  readonly paths: ReadonlyArray<AuditedPath>;
  /** The target the package is made into, where the trees reach a target made
   * from it rather than the package itself, with the advisories its rule
   * declares the target's build fixes (`ResolvedRequirements.fixes`). */
  readonly patchedBy?: { readonly target: string; readonly fixes: ReadonlyArray<string> };
}

/** @return `pkg` as a path names it. */
function pathName(pkg: Package): string {
  return pkg.version === undefined ? pkg.packageName : `${pkg.packageName}@${pkg.version}`;
}

/**
 * List the packages among what `names` resolve to that an advisory database
 * can be asked about: each registry package at its exact version, by its purl,
 * once however many names reach it. A package built in the project is walked
 * through for what it requires, and listed as the registry package it is made
 * from ({@link madeFrom}), as an entry apart from that package's own;
 * otherwise it is not listed.
 */
export function auditedPackages(names: ReadonlyArray<ResolvedName>): Computable<AuditedPackage[]> {
  return walkNames(names).then(walked => walked.packages);
}

/** List the {@link auditedPackages} among what `names` resolve to, and the
 * advisories declared fixed by each target among them that is made from no
 * registry package. */
function walkNames(names: ReadonlyArray<ResolvedName>): Computable<{ packages: AuditedPackage[]; unattached: UnmatchedFix[] }> {
  return walkReadingFiles(readFor => walkNamesReading(names, readFor));
}

/** Walk `names` as {@link walkNames} does, with what `readFor` holds of the
 * targets each target reads for its files. */
function walkNamesReading(
  names: ReadonlyArray<ResolvedName>,
  readFor: (target: ResolvedTarget) => ReadonlyArray<Dependency>
): { packages: AuditedPackage[]; unattached: UnmatchedFix[] } {
  const unattached: UnmatchedFix[] = [];
  interface Entry {
    purl: string;
    packageName: string;
    version: string;
    format: PackageFormat<unknown, unknown>;
    paths: Array<{ path: string[]; others: number; site?: ISourceSpan }>;
    patchedBy?: { target: string; fixes: ReadonlyArray<string> };
  }
  const audited = new Map<string, Entry>();
  for (const { title, resolved } of names) {
    /* Walk each package's dependencies once per name; count every further
     * edge to it in its first path's `others`. */
    const reached = new Map<Package, { path: string[]; others: number } | undefined>();
    const walk = (edges: ReadonlyArray<WalkedEdge>, path: string[], site: ISourceSpan | undefined): void => {
      for (const { edge: dependency, whole } of edges) {
        const pkg = dependency.package;
        if (pkg === undefined) {
          continue;
        }
        const written = site ?? siteOf(dependency);
        if (reached.has(pkg)) {
          const first = reached.get(pkg);
          if (first !== undefined) {
            first.others++;
          }
          continue;
        }
        const here = [...path, pathName(pkg)];
        const patched = builtInProject(pkg.origin) ? madeFrom(pkg) : undefined;
        if (patched === undefined && pkg instanceof ResolvedTarget) {
          unattached.push(...pkg.resolved.fixes.map((id): UnmatchedFix => ({ target: pkg.packageName, id })));
        }
        const subject = patched?.from ?? (builtInProject(pkg.origin) ? undefined : pkg);
        const version = subject?.version;
        const purl = subject === undefined || version === undefined ? undefined : purlOf(subject.origin, subject.packageName, version);
        const format = subject === undefined || purl === undefined ? undefined : formatOf(subject.origin);
        if (subject === undefined || version === undefined || purl === undefined || format === undefined) {
          reached.set(pkg, undefined);
        } else {
          const found = { path: here, others: 0, ...(written === undefined ? {} : { site: written }) };
          reached.set(pkg, found);
          /* A target made from the package is an entry of its own. */
          const key = patched === undefined ? purl : `${purl} ${pkg.packageName}`;
          const entry = audited.get(key) ?? {
            purl,
            packageName: subject.packageName,
            version,
            format,
            paths: [],
            ...(patched === undefined ? {} : { patchedBy: { target: pkg.packageName, fixes: patched.fixes } }),
          };
          entry.paths.push(found);
          audited.set(key, entry);
        }
        walk(walkedEdges(pkg, whole, readFor), here, written);
      }
    };
    walk(nameEdges(resolved, readFor), [title], undefined);
  }
  return { packages: [...audited].sort(([a], [b]) => compareText(a, b)).map(([, entry]) => entry), unattached };
}

/** A range of versions an advisory affects, in one package. */
interface AffectedRange {
  /** The package's purl, without a version, where the record names one. */
  readonly purl?: string;
  /** The versions that fix it, as the range's `fixed` events state them. */
  readonly fixed: ReadonlyArray<string>;
}

/** An advisory as OSV publishes it (https://ossf.github.io/osv-schema/), the
 * fields the report shows. */
export interface Advisory {
  readonly id: string;
  readonly aliases: ReadonlyArray<string>;
  readonly summary: string;
  /** The database's own rating (`CRITICAL`, `HIGH`, `MODERATE`, `LOW`), where it gives one. */
  readonly severity?: string;
  /** Where the advisory is published: of the record's references of type
   * `ADVISORY`, the one naming the advisory's own id, else the first. */
  readonly url?: string;
  readonly affected: ReadonlyArray<AffectedRange>;
}

/** @return the strings among `value` where it is an array, otherwise none. */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];
}

/** @return the objects among `value` where it is an array, otherwise none. */
function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

/** Convert an OSV vulnerability record to the {@link Advisory} the report shows. */
export function toAdvisory(json: unknown): Advisory {
  if (!isJsonObject(json) || typeof json.id !== "string") {
    throw new FabrError("expected a vulnerability record with an id");
  }
  const specific = isJsonObject(json.database_specific) ? json.database_specific : {};
  const advisories = objects(json.references).filter(each => each.type === "ADVISORY" && typeof each.url === "string");
  const reference = advisories.find(each => (each.url as string).includes(json.id as string)) ?? advisories[0];
  return {
    id: json.id,
    aliases: strings(json.aliases),
    summary: typeof json.summary === "string" ? json.summary : typeof json.details === "string" ? json.details.split("\n")[0] : "",
    ...(typeof specific.severity === "string" ? { severity: specific.severity } : {}),
    ...(reference === undefined ? {} : { url: reference.url as string }),
    affected: objects(json.affected).map(each => {
      const pkg = isJsonObject(each.package) ? each.package : {};
      return {
        ...(typeof pkg.purl === "string" ? { purl: pkg.purl } : {}),
        /* A GIT range's events are commits, not versions. */
        fixed: objects(each.ranges)
          .filter(range => range.type === "SEMVER" || range.type === "ECOSYSTEM")
          .flatMap(range => objects(range.events).flatMap(event => (typeof event.fixed === "string" ? [event.fixed] : []))),
      };
    }),
  };
}

/** One query's answer in a batch: the advisories' ids, and the page token for
 * the rest where there are more. */
interface QueryResult {
  readonly ids: string[];
  readonly next?: string;
}

/** Convert an OSV `querybatch` response to each query's answer, in order. */
export function toQueryResults(json: unknown): QueryResult[] {
  if (!isJsonObject(json) || !Array.isArray(json.results)) {
    throw new FabrError("expected a querybatch response with results");
  }
  return json.results.map((result): QueryResult => {
    const record = isJsonObject(result) ? result : {};
    return {
      ids: objects(record.vulns).flatMap(vuln => (typeof vuln.id === "string" ? [vuln.id] : [])),
      ...(typeof record.next_page_token === "string" ? { next: record.next_page_token } : {}),
    };
  });
}

/** An advisory database the audit asks. */
export interface AdvisoryServer {
  /** Query the advisories affecting each of `purls`: their ids, aligned with the purls. */
  query(purls: ReadonlyArray<string>): Computable<ReadonlyArray<ReadonlyArray<string>>>;
  /** Get the advisory `id`. */
  advisory(id: string): Computable<Advisory>;
}

/** The most queries one `querybatch` request takes. */
const QUERY_BATCH = 1000;

/**
 * Make the server at `base`, a URL answering OSV's API
 * (https://google.github.io/osv.dev/api/): `v1/querybatch` for the queries, a
 * thousand at a time, following each query's pages to the end, and
 * `v1/vulns/<id>` for each advisory. Nothing is cached. A request rejects
 * where the server answers other than 200, with a body that does not convert,
 * or with a different number of answers than queries.
 */
export function osvServer(base: string): AdvisoryServer {
  const root = base.replace(/\/+$/, "");
  const request = <T>(path: string, body: unknown, convert: (json: unknown) => T): Computable<T> => {
    const url = `${root}/${path}`;
    return sendRequest(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then(response => {
      if (response.statusCode !== 200) {
        throw new FabrError(`${url} answered ${response.statusCode}: ${response.body.toString("utf8").trim().split("\n")[0]}`);
      }
      return parseJson(response.body, `response from ${url}`, convert);
    });
  };
  /** Query `purls`, following each query's pages to the end. */
  const query = (purls: ReadonlyArray<string>, tokens: ReadonlyArray<string | undefined>): Computable<string[][]> =>
    request(
      "v1/querybatch",
      { queries: purls.map((purl, at) => ({ package: { purl }, ...(tokens[at] === undefined ? {} : { page_token: tokens[at] }) })) },
      toQueryResults
    ).then(results => {
      if (results.length !== purls.length) {
        throw new FabrError(`${root} answered ${results.length} of ${purls.length} queries`);
      }
      const more = results.flatMap((result, at) => (result.next === undefined ? [] : [at]));
      if (more.length === 0) {
        return results.map(result => result.ids);
      }
      return query(
        more.map(at => purls[at]),
        more.map(at => results[at].next)
      ).then(rest => results.map((result, at) => [...result.ids, ...(more.includes(at) ? rest[more.indexOf(at)] : [])]));
    });
  return {
    query: purls => {
      const batches: Array<ReadonlyArray<string>> = [];
      for (let at = 0; at < purls.length; at += QUERY_BATCH) {
        batches.push(purls.slice(at, at + QUERY_BATCH));
      }
      return Computable.forAll(
        batches.map(batch =>
          query(
            batch,
            batch.map(() => undefined)
          )
        ),
        (...answered: string[][][]) => answered.flat()
      );
    },
    advisory: id => request(`v1/vulns/${encodeURIComponent(id)}`, undefined, toAdvisory),
  };
}

/** A package an advisory would affect, which an OpenVEX statement says it does not. */
export interface SuppressedPackage {
  readonly pkg: AuditedPackage;
  /** The statement deciding the advisory's status in the package. */
  readonly statement: VexStatement;
}

/** One advisory the audit found, and the audited packages it affects. */
export interface Finding {
  readonly advisory: Advisory;
  /** The packages it affects. */
  readonly packages: ReadonlyArray<AuditedPackage>;
  /** The packages it would affect, made into targets whose builds fix it. */
  readonly fixed: ReadonlyArray<AuditedPackage>;
  /** The packages it would affect, apart from those {@link fixed}, which OpenVEX statements say it does not. */
  readonly suppressed: ReadonlyArray<SuppressedPackage>;
}

/** An advisory a target declares its build fixes that does not affect the
 * package it is made from, or a target made from no registry package. */
export interface UnmatchedFix {
  readonly target: string;
  /** The advisory as the target names it. */
  readonly id: string;
  /** The package the target is made from; none where it is made from no registry package. */
  readonly pkg?: AuditedPackage;
}

/** What an audit found: the packages asked about, the advisories affecting
 * them, and the declared fixes that match no advisory affecting them. */
export interface AuditReport {
  readonly packages: ReadonlyArray<AuditedPackage>;
  readonly findings: ReadonlyArray<Finding>;
  readonly unmatched: ReadonlyArray<UnmatchedFix>;
}

/** @return true if `advisory` is one of those `ids` name, by its id or an alias, otherwise false. */
function namedAmong(advisory: Advisory, ids: ReadonlyArray<string>): boolean {
  return ids.includes(advisory.id) || advisory.aliases.some(alias => ids.includes(alias));
}

/** @return true if any advisory `report` found affects a package, neither fixed nor suppressed, otherwise false. */
export function affectsAny(report: AuditReport): boolean {
  return report.findings.some(finding => finding.packages.length > 0);
}

/** The order advisories are reported in: the database's ratings from the
 * worst down, then those it does not rate. */
const SEVERITIES = ["CRITICAL", "HIGH", "MODERATE", "MEDIUM", "LOW"];

/** @return where `advisory`'s rating stands in {@link SEVERITIES}, its length for one unrated. */
export function severityRank(advisory: Advisory): number {
  const at = SEVERITIES.indexOf(advisory.severity?.toUpperCase() ?? "");
  return at === -1 ? SEVERITIES.length : at;
}

/**
 * Audit what `names` resolve to: ask `server` about every package
 * {@link auditedPackages} lists among them (what the targets they read for
 * their files require included), and report what it answers.
 *
 * The report holds:
 * - `packages`: every package asked about.
 * - `findings`: each advisory `server` answers with, worst rated first (see
 *   {@link severityRank}), then by id. Each package it affects is in exactly
 *   one of: `fixed`, where the package is made into a target that declares
 *   its build fixes the advisory (by its id or an alias); `suppressed`, where
 *   the deciding statement among `statements` for the advisory and package
 *   has the status `not_affected` or `fixed`; `packages`, otherwise.
 * - `unmatched`: each advisory a target declares its build fixes that does
 *   not affect the package it is made from, and each a target made from no
 *   registry package declares.
 *
 * Rejects where `server` fails to answer.
 */
export function audit(
  names: ReadonlyArray<ResolvedName>,
  server: AdvisoryServer,
  statements: ReadonlyArray<VexStatement> = []
): Computable<AuditReport> {
  return walkNames(names).then(({ packages, unattached }) => auditPackages(packages, unattached, server, statements));
}

/** Audit `packages` as {@link audit} does, adding `unattached` (the fixes declared by targets made from no registry package) to the unmatched. */
function auditPackages(
  packages: AuditedPackage[],
  unattached: UnmatchedFix[],
  server: AdvisoryServer,
  statements: ReadonlyArray<VexStatement>
): Computable<AuditReport> {
  if (packages.length === 0) {
    return Computable.resolve({ packages, findings: [], unmatched: unattached });
  }
  const purls = [...new Set(packages.map(pkg => pkg.purl))];
  return server.query(purls).then(answers => {
    const answered = new Map(purls.map((purl, at) => [purl, answers[at]]));
    const ids = [...new Set(answers.flat())].sort();
    return Computable.forAll(
      ids.map(id => server.advisory(id)),
      (...advisories: Advisory[]): AuditReport => {
        const byId = new Map(ids.map((id, at) => [id, advisories[at]]));
        const affecting = (pkg: AuditedPackage): Advisory[] => (answered.get(pkg.purl) ?? []).map(id => byId.get(id)!);
        const fixes = (pkg: AuditedPackage, advisory: Advisory): boolean =>
          pkg.patchedBy !== undefined && namedAmong(advisory, pkg.patchedBy.fixes);
        return {
          packages,
          findings: advisories
            .map((advisory, at): Finding => {
              const reached = packages.filter(pkg => (answered.get(pkg.purl) ?? []).includes(ids[at]));
              const known = [advisory.id, ...advisory.aliases];
              const decided = reached
                .filter(pkg => !fixes(pkg, advisory))
                .map(pkg => ({ pkg, statement: decidingStatement(statements, known, pkg.purl) }));
              return {
                advisory,
                packages: decided.filter(({ statement }) => statement === undefined || !suppresses(statement)).map(({ pkg }) => pkg),
                fixed: reached.filter(pkg => fixes(pkg, advisory)),
                suppressed: decided.flatMap(({ pkg, statement }) =>
                  statement !== undefined && suppresses(statement) ? [{ pkg, statement }] : []
                ),
              };
            })
            .sort((a, b) => severityRank(a.advisory) - severityRank(b.advisory) || compareText(a.advisory.id, b.advisory.id)),
          unmatched: [
            ...packages.flatMap(pkg =>
              pkg.patchedBy === undefined
                ? []
                : pkg.patchedBy.fixes
                    .filter(id => !affecting(pkg).some(advisory => namedAmong(advisory, [id])))
                    .map((id): UnmatchedFix => ({ target: pkg.patchedBy!.target, id, pkg }))
            ),
            ...unattached,
          ],
        };
      }
    );
  });
}

/** @return the versions `advisory` says fix it in `pkg`, highest first: those
 * of the affected ranges naming the package, or of every range where the
 * record names no package. A version the package's format cannot read sorts
 * last, by its text. */
export function fixedVersions(advisory: Advisory, pkg: AuditedPackage): string[] {
  const base = pkg.purl.substring(0, pkg.purl.lastIndexOf("@"));
  const named = advisory.affected.filter(range => range.purl !== undefined);
  const ranges = named.length === 0 ? advisory.affected : named.filter(range => range.purl === base);
  const parsed = (text: string): unknown => {
    try {
      return pkg.format.parseVersion(text);
    } catch {
      return undefined;
    }
  };
  const versions = [...new Set(ranges.flatMap(range => range.fixed))].map(text => ({ text, version: parsed(text) }));
  return versions
    .sort((a, b) =>
      a.version === undefined || b.version === undefined
        ? Number(a.version === undefined) - Number(b.version === undefined) || compareText(a.text, b.text)
        : pkg.format.compare(b.version, a.version)
    )
    .map(each => each.text);
}

/** @return the SARIF level a result for `advisory` is reported at, by the
 * database's rating: `CRITICAL` and `HIGH` are errors, `MODERATE`, `MEDIUM`
 * and an unrated one warnings, `LOW` a note. */
function sarifLevel(advisory: Advisory): ISarifResult["level"] {
  const rank = severityRank(advisory);
  return rank < 2 ? "error" : rank < 4 ? "warning" : rank < SEVERITIES.length ? "note" : "warning";
}

/** The SARIF `security-severity` (a CVSS-scaled score, as text) given for
 * each of the database's ratings. */
const SECURITY_SEVERITY = new Map([
  ["CRITICAL", "9.5"],
  ["HIGH", "8.0"],
  ["MODERATE", "5.5"],
  ["MEDIUM", "5.5"],
  ["LOW", "2.0"],
]);

/** Render what `statement` says as a report spells it: its status, and its
 * justification or impact statement where it gives one, then the document it
 * is read from. */
export function vexText(statement: VexStatement): string {
  const why = statement.justification ?? statement.impact;
  return `${statement.status.replace(/_/g, " ")}${why === undefined ? "" : `: ${why}`} (${statement.document})`;
}

/** Render a path as a report spells it. */
export function pathText({ path, others }: AuditedPath): string {
  return `${path.join(" > ")}${others === 0 ? "" : ` (+${others})`}`;
}

/**
 * Write an audit report as a SARIF log, for a code-scanning service. Each
 * finding's advisory is a rule, and each package it would affect a result at
 * the level its rating gives ({@link sarifLevel}): a package a target's build
 * fixes carries an `inSource` suppression, one an OpenVEX statement
 * suppresses an `external` one. A result is located where `locate` places the
 * written references its paths start from; `locate` returns undefined for a
 * reference it cannot place, such as one outside the project's build files.
 * `tool.version` is the version of fabr that ran.
 */
export function auditSarif(
  report: AuditReport,
  tool: { version: string },
  locate: (site: ISourceSpan) => ISarifLocation | undefined
): ISarifLog {
  const rules: ISarifRule[] = report.findings.map(({ advisory }) => ({
    id: advisory.id,
    shortDescription: { text: advisory.summary === "" ? advisory.id : advisory.summary },
    ...(advisory.url === undefined ? {} : { helpUri: advisory.url }),
    properties: {
      tags: ["security", ...advisory.aliases],
      ...(advisory.severity === undefined || !SECURITY_SEVERITY.has(advisory.severity.toUpperCase())
        ? {}
        : { "security-severity": SECURITY_SEVERITY.get(advisory.severity.toUpperCase()) }),
    },
  }));
  const result = (advisory: Advisory, ruleIndex: number, pkg: AuditedPackage, statement?: VexStatement): ISarifResult => {
    const fixed = fixedVersions(advisory, pkg);
    /* Locate paths that start from one reference once. */
    const located = new Map<string, ISarifLocation>();
    for (const { site } of pkg.paths) {
      const location = site === undefined ? undefined : locate(site);
      if (location !== undefined) {
        located.set(JSON.stringify(location), location);
      }
    }
    const locations = [...located.values()];
    const patched = pkg.patchedBy;
    return {
      ruleId: advisory.id,
      ruleIndex,
      level: sarifLevel(advisory),
      message: {
        text: `${pkg.packageName}@${pkg.version}${patched === undefined ? "" : ` as patched by '${patched.target}'`}${
          fixed.length === 0 ? "" : ` (fixed in ${fixed.join(", ")})`
        }, required through ${pkg.paths.map(pathText).join("; ")}`,
      },
      ...(locations.length === 0 ? {} : { locations }),
      /* A target's declared fix is suppressed in source; an OpenVEX
       * statement's externally. */
      ...(patched !== undefined && namedAmong(advisory, patched.fixes)
        ? { suppressions: [{ kind: "inSource" as const, justification: `fixed by the patched target '${patched.target}'` }] }
        : statement !== undefined
          ? { suppressions: [{ kind: "external" as const, justification: vexText(statement) }] }
          : {}),
      properties: {
        purl: pkg.purl,
        fixed,
        paths: pkg.paths.map(({ path, others }) => ({ path, others })),
        ...(patched === undefined ? {} : { patchedBy: patched.target }),
      },
    };
  };
  const results = report.findings.flatMap(({ advisory, packages, fixed, suppressed }, ruleIndex) => [
    ...[...packages, ...fixed].map(pkg => result(advisory, ruleIndex, pkg)),
    ...suppressed.map(({ pkg, statement }) => result(advisory, ruleIndex, pkg, statement)),
  ]);
  return sarifLog({ name: "fabr", version: tool.version, informationUri: "https://fabr.build/", rules }, results, {
    packagesChecked: report.packages.length,
  });
}
