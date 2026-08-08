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

import { Computable } from "../core/Computable";
import { attachHelp } from "../core/Errors";
import { FileSet } from "../core/FileSet";
import { Name } from "../core/Name";
import { PackageFileSet } from "../core/PackageFileSet";
import { PublishableFileSet } from "../core/PublishableFileSet";
import {
  isRepository,
  MaterializeOptions,
  PublishMember,
  PublishStatus,
  Repository,
  RepositoryPublishRef,
  RepositoryReader,
  RepositoryRef,
  RepositoryWriter,
  Resolution,
  SourceRef,
} from "../core/Repository";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { RepositoryContext } from "../model/BuildContext";
import { Requirement, Selected } from "../resolver/Types";
import {
  declaredRequirementOf,
  isPackageRegistry,
  materializePackages,
  PackageLanguage,
  RegistryAdapter,
  resolvePackages,
  vendPackageRef,
} from "../resolver/PackageResolver";
import { RepositoryRegistration } from "./Types";

/**
 * A parsed route key: a literal package-name prefix, matched by whole leading
 * components (both `/` and `:` bound components, as in references), with the
 * final component optionally a prefix (`@fortawesome/*`, `@acme/legacy-*`).
 * The key's own depth decides how much of a name it claims — routing never
 * needs the ecosystem's identity split, and a version component cannot confuse
 * it because no route key extends into version position.
 */
export interface RouteKey {
  /** The literal text of each claimed component; for a prefix key the last
   * entry is the prefix within its component ("" for the bare catch-all). */
  readonly components: string[];
  /** Whether the final component prefix-matches rather than exact-matches. */
  readonly prefix: boolean;
}

/** One route: names matching `key` are served by `member`. */
export interface Route<V, C> {
  readonly key: RouteKey;
  readonly member: RegistryAdapter<V, C>;
}

/** The canonical text of a route key (`@fortawesome/*`, `lodash`, `*`). */
export function routeKeyText(key: RouteKey): string {
  return key.components.join("/") + (key.prefix ? "*" : "");
}

/** The primary specificity metric: total literal length (see {@link bestRoute}
 * for the exact-over-prefix tie-break). */
function literalLength(key: RouteKey): number {
  return key.components.join("/").length;
}

/** Whether `a` is the more specific of two MATCHING keys: longer literal wins;
 * on equal literals an exact key beats its prefix twin (`foo` over `foo*` for
 * the name `foo` — the one shape where two distinct keys match with equal
 * length). Total for any two distinct canonical keys, so declaration order
 * never decides. */
function moreSpecific(a: RouteKey, b: RouteKey): boolean {
  const byLength = literalLength(a) - literalLength(b);
  return byLength !== 0 ? byLength > 0 : !a.prefix && b.prefix;
}

/**
 * Parse a written route key, enforcing the shape rule: a literal name, or a
 * literal with one trailing `*`. Returns an error message (for the caller to
 * position at the route) on any other pattern shape — `?`, a character class,
 * an extglob, an interior or doubled `*` — or on a `${...}` substitution (the
 * key's name text is canonical, never substituted).
 */
export function parseRouteKey(text: string): RouteKey | { error: string } {
  if (text.includes("${")) {
    return { error: `route key '${text}' may not contain a variable substitution` };
  }
  const prefix = text.endsWith("*");
  const literal = prefix ? text.slice(0, -1) : text;
  const bad = literal.match(/[*?[\]()]/);
  if (bad) {
    return {
      error:
        bad[0] === "*"
          ? `route key '${text}' may only use '*' as its final character (a literal name prefix)`
          : `route key '${text}' is not a literal name prefix ('${bad[0]}' is a pattern character; routes are a literal, optionally ending in '*')`,
    };
  }
  const components = literal === "" ? [""] : splitComponents(literal);
  if (components.some((component, index) => component === "" && index < components.length - 1)) {
    return { error: `route key '${text}' has an empty name component` };
  }
  return { components, prefix };
}

/** Name components, both `/` and `:` bounding — the same boundaries reference
 * names use (Name's separator set). */
function splitComponents(text: string): string[] {
  return text.split(/[/:]/);
}

/** Whether `key` claims `parts` (see {@link RouteKey}). */
function routeMatches(key: RouteKey, parts: string[]): boolean {
  const depth = key.components.length;
  if (depth > parts.length) {
    return false;
  }
  for (let i = 0; i < depth - 1; i++) {
    if (key.components[i] !== parts[i]) {
      return false;
    }
  }
  const last = key.components[depth - 1];
  return key.prefix ? parts[depth - 1].startsWith(last) : parts[depth - 1] === last;
}

/**
 * The route serving `name` — longest literal match wins (an exact key always
 * beats every prefix key it extends; two distinct keys of equal length cannot
 * both match, so there is no tie and declaration order carries no meaning).
 * Undefined when no route claims the name. `name` may be a bare package name
 * or a written reference/coordinate — the key's own depth decides how much it
 * claims, so trailing version/projection components cannot confuse it.
 */
export function bestRoute<R extends { key: RouteKey }>(routes: readonly R[], name: string): R | undefined {
  const parts = splitComponents(name);
  let best: R | undefined;
  for (const route of routes) {
    if (routeMatches(route.key, parts) && (!best || moreSpecific(route.key, best.key))) {
      best = route;
    }
  }
  return best;
}

/**
 * The repository a `repository_group` declares: a registry made of other
 * registries — a {@link RegistryAdapter} implementing every per-name operation
 * by delegating to the member the name routes to. Its reader face hands each
 * reference batch to the package resolver with ITSELF as the registry, so the
 * whole closure of a reference written against the group, transitive
 * requirements included, flows through this table: all dependencies come from
 * the origin the reference named.
 *
 * A name no route matches is not served: per-name reads reject (the miss rides
 * the error MESSAGE, not attached help, because a mid-walk miss is wrapped in
 * a MetadataFetchError, which keeps only the cause's message), and the routes
 * are listed so the remedy is visible. No fall-through, ever.
 */
export class RepositoryGroup<V, C> implements Repository, RepositoryReader, RepositoryWriter, RegistryAdapter<V, C> {
  public readonly language: PackageLanguage<V, C>;

  constructor(
    private readonly context: RepositoryContext,
    private readonly routes: Route<V, C>[]
  ) {
    this.language = routes[0].member.language;
  }

  /** The group's declared name (`@deps`), for miss diagnostics. */
  private get groupName(): string {
    return this.context.target.name;
  }

  public getRepositoryRef(name: Name): RepositoryRef {
    /* The ref's source is the GROUP, so every reference written against it
     * lands in one joint batch at the consumer's collection point. */
    return vendPackageRef(this, this.language, name);
  }

  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    this.validateCoordinate(name); /* validate the route + address shape up front */
    return new RepositoryPublishRef(this, name);
  }

  public resolve(references: RepositoryRef[]): Computable<Resolution> {
    return resolvePackages(this.context, this, references);
  }

  public materialize(references: RepositoryRef[], resolution: Resolution, options?: MaterializeOptions): Computable<FileSet[]> {
    return materializePackages(this.context, this, references, resolution, options);
  }

  public declaredRequirement(ref: RepositoryRef): Computable<Requirement | undefined> {
    return declaredRequirementOf(this.language, ref);
  }

  /** The serialized route table — the identity a resolution memo keys on:
   * what a name resolves to depends on where every name routes. */
  public get identity(): string {
    return this.routes.map(route => `${routeKeyText(route.key)}=${route.member.identity}`).join(" ");
  }

  /** The registry serving `pkg`, undefined when no route claims it. */
  private memberFor(pkg: string): RegistryAdapter<V, C> | undefined {
    return bestRoute(this.routes, pkg)?.member;
  }

  /** The registry serving `pkg`, or the miss error (see the class comment). */
  private routed(pkg: string): RegistryAdapter<V, C> | Error {
    const member = this.memberFor(pkg);
    if (member) {
      return member;
    }
    return new Error(
      `${this.groupName} has no route serving '${pkg}' (its routes are: ${this.routes.map(route => routeKeyText(route.key)).join(", ")})`
    );
  }

  public getRequirements(pkg: string, version: V): Computable<Requirement[]> {
    const member = this.routed(pkg);
    return member instanceof Error ? Computable.reject(member) : member.getRequirements(pkg, version);
  }

  public lowestAvailable(pkg: string, constraint: string): Computable<V | undefined> {
    const member = this.memberFor(pkg);
    return member?.lowestAvailable ? member.lowestAvailable(pkg, constraint) : Computable.resolve(undefined);
  }

  public availableVersions(pkg: string): Computable<V[] | undefined> {
    const member = this.memberFor(pkg);
    return member ? member.availableVersions(pkg) : Computable.resolve(undefined);
  }

  /** Environment keys deduplicated across the members — with a shared language
   * they answer alike, but the memo key must be right even if they differ. */
  public environmentKey(): Computable<string> {
    return Computable.forAll(
      this.routes.map(route => route.member.environmentKey()),
      (...keys: string[]) => [...new Set(keys)].join(",")
    );
  }

  /** Post-resolution policy runs per member, each over its routed slice of the
   * finished graph. */
  public validateSelections(selections: Selected<V>[]): Computable<void> {
    const slices = new Map<RegistryAdapter<V, C>, Selected<V>[]>();
    for (const sel of selections) {
      const member = this.routed(sel.pkg);
      if (member instanceof Error) {
        /* Can't happen normally: every selection was reached through routed
         * metadata. Guards a route table edited between memo misses. */
        return Computable.reject(member);
      }
      slices.set(member, [...(slices.get(member) ?? []), sel]);
    }
    return Computable.forAll(
      [...slices].map(([member, sliced]) => member.validateSelections(sliced)),
      () => undefined
    );
  }

  public fetch(pkg: string, version: V): Computable<PackageFileSet> {
    const member = this.routed(pkg);
    return member instanceof Error ? Computable.reject(member) : member.fetch(pkg, version);
  }

  public makeRunnable(pkg: PackageFileSet): Computable<RunnableFileSet> {
    const member = this.routed(pkg.packageName);
    return member instanceof Error ? Computable.reject(member) : member.makeRunnable(pkg);
  }

  public validateCoordinate(name: Name): void {
    const member = this.memberFor(name.getLiteralPathPrefix());
    if (!member) {
      throw attachHelp(
        new Error(`${this.groupName} has no route serving publish coordinate '${name.toString()}'`),
        `its routes are: ${this.routes.map(route => routeKeyText(route.key)).join(", ")}`
      );
    }
    member.validateCoordinate(name);
  }

  /**
   * Package a publish batch: the members partition by routed registry (each
   * registry packages its own slice jointly, seeing the whole release for
   * cross-registry rewrites), and the carriers reassemble in member order.
   */
  public package(members: PublishMember[], release: readonly RepositoryPublishRef[]): Computable<PublishableFileSet[]> {
    const batches = new Map<RegistryAdapter<V, C>, { member: PublishMember; index: number }[]>();
    for (const [index, member] of members.entries()) {
      const routed = this.routed(member.destination.name.getLiteralPathPrefix());
      if (routed instanceof Error) {
        /* Can't happen: the publish ref was routed at vend time. Guards a
         * route table edited since. */
        throw routed;
      }
      batches.set(routed, [...(batches.get(routed) ?? []), { member, index }]);
    }
    const batchList = [...batches];
    return Computable.forAll(
      batchList.map(([routed, batch]) =>
        routed.package(
          batch.map(entry => entry.member),
          release
        )
      ),
      (...packaged: PublishableFileSet[][]) => {
        /* Reassemble in member order: each registry returns carriers parallel
         * to the batch it was given, indexed back to the caller's positions. */
        const carriers = new Array<PublishableFileSet>(members.length);
        batchList.forEach(([, batch], group) =>
          batch.forEach((entry, position) => (carriers[entry.index] = packaged[group][position]))
        );
        return carriers;
      }
    );
  }

  /** Upload one packaged artifact via the registry its coordinate routes to. */
  public publish(artifact: PublishableFileSet): Computable<PublishStatus> {
    const member = this.routed(artifact.destination.name.getLiteralPathPrefix());
    return member instanceof Error ? Computable.reject(member) : member.publish(artifact);
  }
}

/**
 * A `repository_group` declares one package **domain** served by several
 * registries: every member is a route — a literal package-name prefix mapped
 * to a registry — and references written against the group resolve in ONE
 * joint resolution, each per-name lookup dispatched to the registry the name
 * routes to (longest literal match wins; `*` is the empty prefix, so it sorts
 * last under the same rule). The motivating shape:
 *
 * ```
 * npm_repository @fa  { url = "https://npm.fontawesome.com/"; }
 * npm_repository @npm { url = ${NPM_REPOSITORY_URL}; }
 *
 * repository_group @deps {
 *     @fortawesome/* = @fa;
 *     *              = @npm;
 * }
 * ```
 *
 * A transitive requirement discovered inside one registry's metadata is
 * answered by whichever registry its name routes to — the one thing separately
 * declared registries cannot do, each being its own independently resolved
 * domain.
 *
 * Routes are read from the declaration's own properties: nothing is reserved
 * (a package may be named anything, including `default`), and a name no route
 * matches is simply not served — never a fall-through to another registry
 * (see DESIGN-repository-group.md). A group with no `*` route is a legitimate
 * closed domain.
 */
function createRepositoryGroup(context: RepositoryContext): Computable<Repository> {
  const groupName = context.target.name;
  const properties = context.target.properties;
  /* All validation happens inside the forAll callback: a provider is invoked
   * synchronously, so a failure must reject the Computable, never throw past
   * it — and a then-callback's throw is exactly that. */
  return Computable.forAll(
    properties.map(prop => context.getFileProperty(prop.name)),
    (...values) => {
      /* Routes are read off the property NAMES directly (not through the
       * wildcard-property surface, which drops bare-identifier keys — an exact
       * unscoped route like `lodash = @npm;` has no keyRef). The name text is
       * canonical and never variable-substituted: what routes is what is
       * written, so a `${...}` in a key is rejected by the shape check. */
      const routes = properties.map(prop => {
        const key = parseRouteKey(prop.name);
        if ("error" in key) {
          throw attachHelp(
            new Error(`route '${prop.name}' in ${groupName}: ${key.error}`),
            "a route key is a literal package name (`lodash`), a literal with a trailing '*' (`@fortawesome/*`, `acme-*`), " +
              "or the catch-all `*`"
          );
        }
        return { name: prop.name, key };
      });
      if (routes.length === 0) {
        throw attachHelp(
          new Error(`${groupName} declares no routes`),
          "declare at least one route (`<name-prefix> = <repository>;`), e.g. `* = @npm;`"
        );
      }
      /* Two textually distinct keys can parse to one canonical key (`a:b` and
       * `a/b` — the separators are equivalent name-component boundaries), a
       * duplicate the property-level check cannot see. */
      const canonical = new Map<string, string>();
      for (const route of routes) {
        const text = routeKeyText(route.key);
        const existing = canonical.get(text);
        if (existing !== undefined) {
          throw attachHelp(
            new Error(`routes '${existing}' and '${route.name}' in ${groupName} are the same key ('${text}')`),
            "':' and '/' are equivalent name-component separators in a route key — remove one of the two routes"
          );
        }
        canonical.set(text, route.name);
      }
      const members = routes.map((route, index) => routeMember(groupName, route.name, values[index]));
      /* Homogeneity: a domain is defined by ONE shared language (the name
       * and version forms every member agrees on), checked by object
       * identity — the per-ecosystem language is a shared singleton, so two
       * npm registries hold the same object while a registry of another
       * ecosystem cannot. No ecosystem tags anywhere. */
      const language = members[0].language;
      const foreign = members.findIndex(member => member.language !== language);
      if (foreign > 0) {
        throw attachHelp(
          new Error(
            `route '${routes[foreign].name}' in ${groupName} names a repository speaking a different package language than ` +
              `route '${routes[0].name}'`
          ),
          "one group resolves one ecosystem's names jointly — declare a separate group (or repository) per ecosystem"
        );
      }
      const table: Route<unknown, unknown>[] = routes.map((route, index) => ({ key: route.key, member: members[index] }));
      return new RepositoryGroup(context, table);
    }
  );
}

/** The registry a route's value names: exactly one repository, one that is a
 * package registry (what `npm_repository` declares), and not itself a group. */
function routeMember(groupName: string, routeName: string, sources: readonly SourceRef[]): RegistryAdapter<unknown, unknown> {
  const repositories = sources.filter(isRepository);
  if (repositories.length !== 1 || sources.length !== 1) {
    throw attachHelp(
      new Error(
        `route '${routeName}' in ${groupName} must name exactly one repository` +
          (repositories.length === 0
            ? " (its value does not resolve to one)"
            : repositories.length > 1
              ? ` (it names ${repositories.length})`
              : " (its value carries more than the repository)")
      ),
      "a route's value is a reference to a declared registry, e.g. `@fortawesome/* = @fa;`"
    );
  }
  const member = repositories[0];
  if (!isPackageRegistry(member) || member instanceof RepositoryGroup) {
    throw attachHelp(
      new Error(
        `route '${routeName}' in ${groupName} does not name a package registry` +
          (member instanceof RepositoryGroup ? " (it names another repository group)" : "")
      ),
      member instanceof RepositoryGroup
        ? "routes name registries directly (an npm_repository), never another group — flatten the routes into one group"
        : "a route's value must be a registry declaration such as an npm_repository (a fetch or catalog repository does not resolve package names)"
    );
  }
  return member;
}

export const repositoryGroupRegistration: RepositoryRegistration = { type: "repository_group", provider: createRepositoryGroup };
