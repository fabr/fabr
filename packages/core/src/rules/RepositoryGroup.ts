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
import { FabrError } from "../core/Errors";
import { Name } from "../core/Name";
import { PackageFileSet } from "../core/PackageFileSet";
import { FileSet } from "../core/FileSet";
import { isRepositoryReader, Repository, RepositoryPublishRef, RepositoryReader, RepositoryRef, SourceRef } from "../core/Repository";
import { TargetContext } from "../context/index";
import { Requirement, Selected } from "../resolver/Types";
import { PackageFormat } from "../resolver/PackageFormat";
import { publishesNothingFor, vendPackageRef, versionChildren } from "../resolver/PackageResolver";
import { contentPackageMember } from "./ContentPackage";
import { PartialRepositoryRef } from "../core/PartialRepositoryRef";
import { NamespaceRef } from "../core/NamespaceRef";
import type { Reference } from "../core/Reference";
import { RepositoryImplementation, RepositoryRegistration } from "./Types";

/**
 * A parsed route key: a literal package name, matched against a name's leading
 * components (bounded by `/` or `:`, as in references), its last component
 * optionally a prefix (`@fortawesome/*`, `@acme/legacy-*`). A key matches only
 * as many components as it has, so a version or projection after the package
 * name plays no part.
 */
export interface RouteKey {
  /** The literal text of each claimed component; for a prefix key the last
   * entry is the prefix within its component ("" for the bare catch-all). */
  readonly components: string[];
  /** True where the last component matches as a prefix, not exactly. */
  readonly prefix: boolean;
}

/** One route: names matching `key` are served by `member`. */
export interface Route<V, C> {
  readonly key: RouteKey;
  readonly member: RepositoryReader<V, C>;
}

/** @return the canonical text of a route key (`@fortawesome/*`, `lodash`, `*`). */
export function routeKeyText(key: RouteKey): string {
  return key.components.join("/") + (key.prefix ? "*" : "");
}

/** @return a key's total literal length, the measure of how specific it is. */
function literalLength(key: RouteKey): number {
  return key.components.join("/").length;
}

/** @return true if `a` is the more specific of two keys that match one name,
 * otherwise false: the longer literal is, and of equal literals an exact key is
 * over a prefix one (`foo` over `foo*`). Two distinct canonical keys are never
 * equally specific. */
function moreSpecific(a: RouteKey, b: RouteKey): boolean {
  const byLength = literalLength(a) - literalLength(b);
  return byLength !== 0 ? byLength > 0 : !a.prefix && b.prefix;
}

/**
 * Parse a route key, its variables already substituted: a literal name, or a
 * literal with one trailing `*`.
 * @return the key, or an error message, for the caller to position at the
 * route, for any other pattern (`?`, a character class, an extglob, an interior
 * or doubled `*`) or an empty component.
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

/** Split a name into components at each `/` and `:`, as reference names are split. */
function splitComponents(text: string): string[] {
  return text.split(/[/:]/);
}

/** @return true if `key` claims `parts` (see {@link RouteKey}), otherwise false. */
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
 * Find the route serving `name`, a package name or a written reference or
 * coordinate: the most specific matching key ({@link moreSpecific}), whatever
 * the declaration order.
 * @return the route, or undefined where no key matches.
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
 * registries. Each per-package read is passed to the member the package's name
 * routes to ({@link bestRoute}). References written against the group are
 * resolved with the group as their registry, so every requirement in their
 * closure is answered through the routes too.
 *
 * A read of a name no route matches rejects, the routes listed in the
 * message. Keep the list in the message, not in help: a MetadataFetchError
 * wrapping it keeps only the cause's message.
 */
export class RepositoryGroup<V, C> implements Repository, RepositoryReader<V, C> {
  constructor(
    private readonly context: TargetContext,
    /** The format every member shares: one instance, checked when the group is made. */
    public readonly format: PackageFormat<V, C>,
    private readonly routes: Route<V, C>[]
  ) {}

  /** The group's declared name (`@deps`), which the packages it answers with are named under. */
  public get name(): string {
    return this.context.name;
  }

  /** The group's declared name, for messages. */
  private get groupName(): string {
    return this.context.name;
  }

  /** Vend the reference `name` names, addressed to the group, so a consumer resolves every reference to the group together. */
  public getRepositoryRef(name: Name): RepositoryRef | PartialRepositoryRef {
    return vendPackageRef(this, this.format, name);
  }

  /** List a package's versions as the member it routes to lists them, each
   *  version's reference addressed to the group. Rejects for the whole group,
   *  and where no route serves the package. */
  public children({ name: namespace }: PartialRepositoryRef): Computable<Map<string, Reference>> {
    if (namespace === "") {
      return Computable.reject(
        new FabrError(`${this.groupName} cannot list every package it serves`).withHelp(
          `name a package to list its versions, as in '${this.groupName}:<package>'`
        )
      );
    }
    const member = this.routed(namespace);
    if (member instanceof Error) {
      return Computable.reject(member);
    }
    const listing = (member as Partial<Repository>).children;
    if (listing === undefined) {
      return versionChildren(this, this.format, namespace, member.availableVersions?.(namespace) ?? Computable.resolve(undefined));
    }
    return listing
      .call(member, new PartialRepositoryRef(member as Repository & typeof member, namespace))
      .then(
        children =>
          new Map(
            [...children].map(([name, child]): [string, Reference] => [
              name,
              child instanceof RepositoryRef
                ? new RepositoryRef(this, { name: child.name, versionConstraint: child.versionConstraint })
                : child,
            ])
          )
      );
  }

  /**
   * Vend the publish reference of the member `name` routes to, which validates
   * the address: the reference is addressed to that member, not the group.
   * Throws where no route serves the coordinate, or it routes to a content
   * route.
   */
  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    const member = this.memberFor(name.getLiteralPathPrefix());
    if (!member) {
      throw new FabrError(`${this.groupName} has no route serving publish coordinate '${name.toString()}'`).withHelp(
        `its routes are: ${this.routes.map(route => routeKeyText(route.key)).join(", ")}`
      );
    }
    const destination = member as Partial<Repository>;
    if (typeof destination.getRepositoryPublishRef !== "function") {
      throw new FabrError(
        `publish coordinate '${name.toString()}' routes to a member of ${this.groupName} that is not a publish destination`
      ).withHelp("a content route serves declared files and cannot be published to — route the name to a registry to publish it");
    }
    return destination.getRepositoryPublishRef(name);
  }

  /** The route table as text, each key with its member's identity: the group's identity for a resolution memo. */
  public get identity(): string {
    return this.routes.map(route => `${routeKeyText(route.key)}=${route.member.identity}`).join(" ");
  }

  /** Find the registry serving `pkg`, undefined when no route claims it. */
  private memberFor(pkg: string): RepositoryReader<V, C> | undefined {
    return bestRoute(this.routes, pkg)?.member;
  }

  /** Find the registry serving `pkg`, or make the error for a name no route serves, listing the routes. */
  private routed(pkg: string): RepositoryReader<V, C> | Error {
    const member = this.memberFor(pkg);
    if (member) {
      return member;
    }
    return new FabrError(
      `${this.groupName} has no route serving '${pkg}' (its routes are: ${this.routes
        .map(route => routeKeyText(route.key))
        .join(", ")})`
    );
  }

  public getRequirements(pkg: string, version: V, operation?: string): Computable<Requirement[]> {
    const member = this.routed(pkg);
    return member instanceof Error ? Computable.reject(member) : member.getRequirements(pkg, version, operation);
  }

  public lowestAvailable(pkg: string, constraint: string): Computable<V | undefined> {
    const member = this.memberFor(pkg);
    return member?.lowestAvailable ? member.lowestAvailable(pkg, constraint) : Computable.resolve(undefined);
  }

  public availableVersions(pkg: string): Computable<V[] | undefined> {
    const member = this.memberFor(pkg);
    return member?.availableVersions ? member.availableVersions(pkg) : Computable.resolve(undefined);
  }

  /** The operation of this group's configuration, which its members are made in too. */
  public get operation(): string {
    return this.context.operation;
  }

  public fetchFiles(reference: RepositoryRef): Computable<FileSet> {
    const member = this.routed(reference.name);
    return member instanceof Error ? Computable.reject(member) : member.fetchFiles(reference);
  }

  /** @return the members' distinct environment keys, joined. */
  public environmentKey(operation?: string): Computable<string> {
    return Computable.forAll(
      this.routes.map(route => route.member.environmentKey(operation)),
      (...keys: string[]) => [...new Set(keys)].join(",")
    );
  }

  /** Check `selections` with each member's `validateSelections`, over the
   * selections whose names route to it. */
  public validateSelections(selections: Selected<V>[]): Computable<void> {
    const slices = new Map<RepositoryReader<V, C>, Selected<V>[]>();
    for (const sel of selections) {
      const member = this.routed(sel.publishedName ?? sel.name);
      if (member instanceof Error) {
        /* Every selection was read through a route; reached only if a cached
         * resolution outlived a change to the routes. */
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

  public fetchFor(pkg: string, version: V, operation: string): Computable<FileSet> {
    const member = this.routed(pkg);
    if (member instanceof Error) {
      return Computable.reject(member);
    }
    return member.fetchFor === undefined
      ? Computable.reject(publishesNothingFor(member, pkg, operation))
      : member.fetchFor(pkg, version, operation);
  }
}

/**
 * Make the repository a `repository_group` declares: one ecosystem's packages,
 * served by several registries. Each property of the declaration is a route, a
 * literal package-name prefix mapped to a registry, and references written
 * against the group resolve together, each package's reads answered by the
 * registry its name routes to (the longest literal match; `*`, the empty
 * prefix, matches every name least specifically):
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
 * A requirement found in one registry's metadata is answered by whichever
 * registry its name routes to.
 *
 * A route's value may instead be package content (a fetched archive expanded,
 * a local directory): the one package the key names, read from the manifest
 * in it ({@link contentPackageMember}; `amperize = @dl:amperize.tgz:*:**;`).
 * Its key must be a literal name. Content routes take the group's format from
 * its registry routes, so a group needs at least one.
 *
 * No property name is reserved (a route may be named `default`). A name no
 * route matches is served by no member; a group without a `*` route serves
 * only the names its routes match.
 *
 * Rejects where a key is malformed, two keys are the same once parsed (`a:b`
 * and `a/b`), a route's value is neither one registry nor one package's
 * content, a registry is another group, or registries' formats differ.
 */
function createRepositoryGroup(context: TargetContext): Computable<Repository> {
  const groupName = context.name;
  /* Routes are the properties the targetdef does not declare, each key
   * substituted (`${SCOPE}/* = @fa;`) and its value read under the property
   * name as written. Validate only inside the forAll callback: a provider is
   * called synchronously, so a failure must reject the Computable, not throw
   * past it. */
  return context.getWildcardProperties().then(members =>
    Computable.forAll(
      members.map(member => context.getFileProperty(member.decl.name.toBaseString())),
      (...values) => {
        const routes = members.map(member => {
          const text = member.key.toGlobString();
          const key = parseRouteKey(text);
          if ("error" in key) {
            throw new FabrError(`route '${member.decl.name.toBaseString()}' in ${groupName}: ${key.error}`).withHelp(
              "a route key is a literal package name (`lodash`), a literal with a trailing '*' (`@fortawesome/*`, `acme-*`), " +
                "or the catch-all `*`"
            );
          }
          return { name: member.decl.name.toBaseString(), key };
        });
        if (routes.length === 0) {
          throw new FabrError(`${groupName} declares no routes`).withHelp(
            "declare at least one route (`<name-prefix> = <repository>;`), e.g. `* = @npm;`"
          );
        }
        /* Two keys written differently may parse to one (`a:b` and `a/b`),
         * which the check for duplicate properties does not see. */
        const canonical = new Map<string, string>();
        for (const route of routes) {
          const text = routeKeyText(route.key);
          const existing = canonical.get(text);
          if (existing !== undefined) {
            throw new FabrError(`routes '${existing}' and '${route.name}' in ${groupName} are the same key ('${text}')`).withHelp(
              "':' and '/' are equivalent name-component separators in a route key — remove one of the two routes"
            );
          }
          canonical.set(text, route.name);
        }
        const classified = routes.map((route, index) => routeValue(groupName, route.name, values[index]));
        /* Every registry route must hold the same format object (one per
         * ecosystem). Content routes take theirs from the first registry
         * route. */
        const anchor = classified.findIndex(value => "registry" in value);
        if (anchor === -1) {
          throw new FabrError(`${groupName} has no registry route — content routes borrow their package ecosystem from one`).withHelp(
            "declare at least one route naming a registry (e.g. `* = @npm;`) alongside the content routes"
          );
        }
        const format = (classified[anchor] as RegistryRoute).registry.format;
        const foreign = classified.findIndex(value => "registry" in value && value.registry.format !== format);
        if (foreign > anchor) {
          throw new FabrError(
            `route '${routes[foreign].name}' in ${groupName} names a repository speaking a different package format than ` +
              `route '${routes[anchor].name}'`
          ).withHelp("one group resolves one ecosystem's names jointly — declare a separate group (or repository) per ecosystem");
        }
        const table: Route<unknown, unknown>[] = routes.map((route, index) => {
          const value = classified[index];
          if ("registry" in value) {
            return { key: route.key, member: value.registry };
          }
          /* A content route serves the one package its key names: refuse a prefix key. */
          if (route.key.prefix) {
            throw new FabrError(`route '${route.name}' in ${groupName} maps a name prefix to package content`).withHelp(
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
  readonly registry: RepositoryReader<unknown, unknown>;
}

/** A content route's declared source, classified by {@link routeValue}. */
interface ContentRoute {
  readonly content: SourceRef;
}

/**
 * Classify one route's value. A value naming a repository is a registry route:
 * it must name exactly one repository, a package registry (an
 * `npm_repository`), not a group. A value naming none is a content route: it
 * must be one source, the content of the package the key names
 * (`amperize = @dl:amperize.tgz:*:**;`, or a local directory). Throws for
 * anything else, a namespace of a repository included.
 */
function routeValue(groupName: string, routeName: string, sources: readonly SourceRef[]): RegistryRoute | ContentRoute {
  const named = sources.filter((source): source is PartialRepositoryRef => source instanceof PartialRepositoryRef);
  const within = named.find(source => source.name !== "");
  if (within !== undefined) {
    throw new FabrError(
      `route '${routeName}' in ${groupName} names a namespace of a repository ('${within.toString()}'), not a repository`
    ).withHelp(
      "a route's value is a reference to a declared registry, e.g. `@fortawesome/* = @fa;`: the key selects the package names"
    );
  }
  const holding = sources.find((source): source is NamespaceRef => source instanceof NamespaceRef);
  if (holding !== undefined) {
    throw new FabrError(`route '${routeName}' in ${groupName} names a namespace ('${holding.toString()}'), not a repository`).withHelp(
      `name one of its repositories, as in '${holding.toString()}:<name>'`
    );
  }
  const repositories = named.map(source => source.repository);
  if (repositories.length === 0) {
    if (sources.length !== 1) {
      throw new FabrError(
        `route '${routeName}' in ${groupName} must name a registry or one package's content` +
          (sources.length === 0 ? " (its value resolves to nothing)" : ` (its value resolves to ${sources.length} sources)`)
      ).withHelp(
        "a route's value is a reference to a declared registry (`@fortawesome/* = @fa;`) or the content of the one package " +
          "the key names (`amperize = @dl:amperize.tgz:*:**;`)"
      );
    }
    return { content: sources[0] };
  }
  if (repositories.length > 1 || sources.length !== 1) {
    throw new FabrError(
      `route '${routeName}' in ${groupName} must name exactly one repository` +
        (repositories.length > 1 ? ` (it names ${repositories.length})` : " (its value carries more than the repository)")
    ).withHelp("a route's value is a reference to a declared registry, e.g. `@fortawesome/* = @fa;`");
  }
  const member = repositories[0];
  if (!isRepositoryReader(member) || member instanceof RepositoryGroup) {
    throw new FabrError(
      `route '${routeName}' in ${groupName} does not name a package registry` +
        (member instanceof RepositoryGroup ? " (it names another repository group)" : "")
    ).withHelp(
      member instanceof RepositoryGroup
        ? "routes name registries directly (an npm_repository), never another group — flatten the routes into one group"
        : "a route's value must be a registry declaration such as an npm_repository (a fetch or catalog repository does not resolve package names)"
    );
  }
  return { registry: member };
}

export const repositoryGroupRegistration: RepositoryRegistration = { type: "repository_group", provider: createRepositoryGroup };

/** The implementation STD.fabr's `repository` declaration names. */
export default { provider: createRepositoryGroup } satisfies RepositoryImplementation;
