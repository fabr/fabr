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
import { Name } from "../core/Name";
import { PackageFileSet } from "../core/PackageFileSet";
import {
  isRepository,
  Repository,
  RepositoryPublishRef,
  RepositoryRef,
  SourceRef,
} from "../core/Repository";
import { TargetContext } from "../model/BuildContext";
import { Requirement, Selected } from "../resolver/Types";
import { PackageFormat } from "../resolver/PackageFormat";
import {
  isPackageRegistry,
  PackageRegistry,
  vendPackageRef,
} from "../resolver/PackageResolver";
import { contentPackageMember } from "./ContentPackage";
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
  readonly member: PackageRegistry<V, C>;
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
 * Parse a route key (its variables already substituted — the caller reads keys
 * through the wildcard-property surface), enforcing the shape rule: a literal
 * name, or a literal with one trailing `*`. Returns an error message (for the
 * caller to position at the route) on any other pattern shape — `?`, a
 * character class, an extglob, an interior or doubled `*`.
 */
export function parseRouteKey(text: string): RouteKey | { error: string } {
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
 * registries — a {@link PackageRegistry} implementing every per-name operation
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
export class RepositoryGroup<V, C>
  implements Repository, PackageRegistry<V, C>
{
  constructor(
    private readonly context: TargetContext,
    /** The domain's shared format — every member holds this same instance
     * (registry members by the homogeneity check, content members by
     * construction), so the factory passes it explicitly rather than having
     * the group trust whichever member happens to be first. */
    public readonly format: PackageFormat<V, C>,
    private readonly routes: Route<V, C>[]
  ) {}

  /** The group's declared name (`@deps`), for miss diagnostics. */
  private get groupName(): string {
    return this.context.name;
  }

  public getRepositoryRef(name: Name): RepositoryRef {
    /* The ref's source is the GROUP, so every reference written against it
     * lands in one joint batch at the consumer's collection point. */
    return vendPackageRef(this, this.format, name);
  }

  /**
   * Publishing is pure pass-through: the routed member vends its own ref
   * (validating the address shape itself), so the sync binds directly to the
   * destination registry — `BuildSync` already partitions a release by
   * destination and drives each one's package/publish, which is the only
   * "multi-registry" work a group could have added. A member without the vend
   * (a content route) is refused here, routes listed.
   */
  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    const member = this.memberFor(name.getLiteralPathPrefix());
    if (!member) {
      throw attachHelp(
        new Error(`${this.groupName} has no route serving publish coordinate '${name.toString()}'`),
        `its routes are: ${this.routes.map(route => routeKeyText(route.key)).join(", ")}`
      );
    }
    const destination = member as Partial<Repository>;
    if (typeof destination.getRepositoryPublishRef !== "function") {
      throw attachHelp(
        new Error(`publish coordinate '${name.toString()}' routes to a member of ${this.groupName} that is not a publish destination`),
        "a content route serves declared files and cannot be published to — route the name to a registry to publish it"
      );
    }
    return destination.getRepositoryPublishRef(name);
  }

  /** The serialized route table — the identity a resolution memo keys on:
   * what a name resolves to depends on where every name routes. */
  public get identity(): string {
    return this.routes.map(route => `${routeKeyText(route.key)}=${route.member.identity}`).join(" ");
  }

  /** The registry serving `pkg`, undefined when no route claims it. */
  private memberFor(pkg: string): PackageRegistry<V, C> | undefined {
    return bestRoute(this.routes, pkg)?.member;
  }

  /** The registry serving `pkg`, or the miss error (see the class comment). */
  private routed(pkg: string): PackageRegistry<V, C> | Error {
    const member = this.memberFor(pkg);
    if (member) {
      return member;
    }
    return new Error(
      `${this.groupName} has no route serving '${pkg}' (its routes are: ${this.routes
        .map(route => routeKeyText(route.key))
        .join(", ")})`
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
    return member?.availableVersions ? member.availableVersions(pkg) : Computable.resolve(undefined);
  }

  /** Environment keys deduplicated across the members — with a shared format
   * they answer alike, but the memo key must be right even if they differ. */
  public environmentKey(): Computable<string> {
    return Computable.forAll(
      this.routes.map(route => route.member.environmentKey()),
      (...keys: string[]) => [...new Set(keys)].join(",")
    );
  }

  /** Post-resolution policy runs per member, each over its routed slice of the
   * finished graph (members without a policy contribute none). */
  public validateSelections(selections: Selected<V>[]): Computable<void> {
    const slices = new Map<PackageRegistry<V, C>, Selected<V>[]>();
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
      [...slices].map(([member, sliced]) => member.validateSelections?.(sliced) ?? Computable.resolve(undefined)),
      () => undefined
    );
  }

  public fetch(pkg: string, version: V): Computable<PackageFileSet> {
    const member = this.routed(pkg);
    return member instanceof Error ? Computable.reject(member) : member.fetch(pkg, version);
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
 * A route's value may instead be package **content** — a fetched archive's
 * expansion, a local directory — in which case the value IS the one package
 * the key names, resolved from the ecosystem's manifest inside it:
 *
 * The content-served package participates in the joint resolution like any
 * registry-served one (its declared version answers range requirements on the
 * name; its own requirements route through the group), with exactly one
 * version available. Content routes borrow the group's format, so at least
 * one route must name a registry.
 *
 * Routes are read from the declaration's own properties: nothing is reserved
 * (a package may be named anything, including `default`), and a name no route
 * matches is simply not served — never a fall-through to another registry
 * (see DESIGN-repository-group.md). A group with no `*` route is a legitimate
 * closed domain.
 */
function createRepositoryGroup(context: TargetContext): Computable<Repository> {
  const groupName = context.name;
  /* Routes are the declaration's wildcard members: every property the targetdef
   * does not declare, its key variable-substituted like any other name — so a
   * route may be written `${SCOPE}/* = @fa;` — while the VALUE resolves under
   * the written property name. What routes is the substituted text; the shape
   * check judges it after substitution. All validation happens inside the
   * forAll callback: a provider is invoked synchronously, so a failure must
   * reject the Computable, never throw past it — and a then-callback's throw
   * is exactly that. */
  return context.getWildcardProperties().then(members =>
    Computable.forAll(
      members.map(member => context.getFileProperty(member.decl.name)),
      (...values) => {
        const routes = members.map(member => {
          const text = member.key.toGlobString();
          const key = parseRouteKey(text);
          if ("error" in key) {
            throw attachHelp(
              new Error(`route '${member.decl.name}' in ${groupName}: ${key.error}`),
              "a route key is a literal package name (`lodash`), a literal with a trailing '*' (`@fortawesome/*`, `acme-*`), " +
                "or the catch-all `*`"
            );
          }
          return { name: member.decl.name, key };
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
        const classified = routes.map((route, index) => routeValue(groupName, route.name, values[index]));
        /* Homogeneity: a domain is defined by ONE shared format (the name
         * and version forms every member agrees on), checked by object
         * identity — the per-ecosystem format is a shared singleton, so two
         * npm registries hold the same object while a registry of another
         * ecosystem cannot. No ecosystem tags anywhere. Content routes have no
         * format of their own — they borrow the group's, which is why the
         * group must have at least one registry route to define it. */
        const anchor = classified.findIndex(value => "registry" in value);
        if (anchor === -1) {
          throw attachHelp(
            new Error(`${groupName} has no registry route — content routes borrow their package ecosystem from one`),
            "declare at least one route naming a registry (e.g. `* = @npm;`) alongside the content routes"
          );
        }
        const format = (classified[anchor] as RegistryRoute).registry.format;
        const foreign = classified.findIndex(value => "registry" in value && value.registry.format !== format);
        if (foreign > anchor) {
          throw attachHelp(
            new Error(
              `route '${routes[foreign].name}' in ${groupName} names a repository speaking a different package format than ` +
                `route '${routes[anchor].name}'`
            ),
            "one group resolves one ecosystem's names jointly — declare a separate group (or repository) per ecosystem"
          );
        }
        const table: Route<unknown, unknown>[] = routes.map((route, index) => {
          const value = classified[index];
          if ("registry" in value) {
            return { key: route.key, member: value.registry };
          }
          /* A content route serves exactly ONE declared package — the name that
           * is its key — so a prefix cannot mean anything for it. */
          if (route.key.prefix) {
            throw attachHelp(
              new Error(`route '${route.name}' in ${groupName} maps a name prefix to package content`),
              "a content route serves exactly one package, so its key must be the package's literal name (`amperize = ./vendor/amperize;`)"
            );
          }
          return { key: route.key, member: contentPackageMember(format, context, routeKeyText(route.key), value.content) };
        });
        return new RepositoryGroup(context, format, table);
      }
    )
  );
}

/** A registry route's member, classified by {@link routeValue}. */
interface RegistryRoute {
  readonly registry: PackageRegistry<unknown, unknown>;
}

/** A content route's declared source, classified by {@link routeValue}. */
interface ContentRoute {
  readonly content: SourceRef;
}

/**
 * Classify one route's value. A value naming a repository is a **registry
 * route**: exactly one repository, one that is a package registry (what
 * `npm_repository` declares), and not itself a group. Any other value is a
 * **content route** — the value IS the one package the key names
 * (`amperize = @dl:amperize.tgz:*:**;`, or a local directory), served by the
 * format's single-package member ({@link ContentPackageMember}): its version and requirements are read
 * from the ecosystem's manifest inside the content, so it joins the domain's
 * joint resolution exactly as a registry-served package does.
 */
function routeValue(groupName: string, routeName: string, sources: readonly SourceRef[]): RegistryRoute | ContentRoute {
  const repositories = sources.filter(isRepository);
  if (repositories.length === 0) {
    if (sources.length !== 1) {
      throw attachHelp(
        new Error(
          `route '${routeName}' in ${groupName} must name a registry or one package's content` +
            (sources.length === 0 ? " (its value resolves to nothing)" : ` (its value resolves to ${sources.length} sources)`)
        ),
        "a route's value is a reference to a declared registry (`@fortawesome/* = @fa;`) or the content of the one package " +
          "the key names (`amperize = @dl:amperize.tgz:*:**;`)"
      );
    }
    return { content: sources[0] };
  }
  if (repositories.length > 1 || sources.length !== 1) {
    throw attachHelp(
      new Error(
        `route '${routeName}' in ${groupName} must name exactly one repository` +
          (repositories.length > 1 ? ` (it names ${repositories.length})` : " (its value carries more than the repository)")
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
  return { registry: member };
}

export const repositoryGroupRegistration: RepositoryRegistration = { type: "repository_group", provider: createRepositoryGroup };
