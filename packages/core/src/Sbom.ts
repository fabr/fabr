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

import SPDX_LICENSE_IDS from "spdx-license-ids/index.json";
import SPDX_DEPRECATED_IDS from "spdx-license-ids/deprecated.json";
import { Computable } from "./core/Computable";
import { FabrError } from "./core/Errors";
import { isPackage, Package, ResolvedNode } from "./core/PackageFileSet";
import { ILicense, IVersionMetadata } from "./core/Repository";
import { ResolvedTarget } from "./context/index";
import { isDenoted, madeFrom, nameEdges, ResolvedName, walkedEdges, WalkedEdge, walkReadingFiles } from "./Fabr";
import { builtInProject } from "./model/Target";
import { purlOf } from "./resolver/ResolutionProvenance";
import { compareText } from "./support/Functional";
import { ExpectedDigest } from "./support/Integrity";

/**
 * The software bill of materials of what a name resolves to, as CycloneDX
 * (https://cyclonedx.org, version 1.6): the thing described and every package
 * among its dependencies as a component, named by purl where its ecosystem has
 * one, with the licence and digests its registry publishes, and the dependency
 * graph between them. The render-free operation behind `fabr sbom`: a driver
 * resolves the name and hands it to {@link sbom}. Nothing is fetched or built
 * but each registry's metadata, and the document is a function of the
 * resolution alone: it carries no timestamp or serial number.
 */

export interface ICycloneDxLicense {
  license?: { id?: string; name?: string; url?: string };
  expression?: string;
}

export interface ICycloneDxHash {
  alg: string;
  /** The digest, in hex. */
  content: string;
}

export interface ICycloneDxComponent {
  type: "application" | "library";
  "bom-ref": string;
  /** The namespace the name is in, as the ecosystem spells it: a Maven group, an npm scope. */
  group?: string;
  name: string;
  version?: string;
  purl?: string;
  licenses?: ICycloneDxLicense[];
  hashes?: ICycloneDxHash[];
  /** What the component is made from: the package it changes, and the change. */
  pedigree?: { ancestors: Array<Omit<ICycloneDxComponent, "bom-ref">>; patches: ICycloneDxPatch[] };
}

/** A change to an ancestor, with the issues it resolves: here, the advisories
 * a target declares its build fixes. */
export interface ICycloneDxPatch {
  type: "unofficial";
  resolves?: Array<{ type: "security"; id: string }>;
}

export interface ICycloneDxDependency {
  ref: string;
  dependsOn: string[];
}

export interface ICycloneDxBom {
  bomFormat: "CycloneDX";
  specVersion: "1.6";
  version: 1;
  metadata: {
    tools: { components: ICycloneDxComponent[] };
    component: ICycloneDxComponent;
  };
  components: ICycloneDxComponent[];
  dependencies: ICycloneDxDependency[];
}

/** The licence ids of the SPDX licence list, which CycloneDX validates a licence's `id` against. */
const SPDX_IDS = new Set([...SPDX_LICENSE_IDS, ...SPDX_DEPRECATED_IDS]);
const SPDX_OPERATOR = /\s(AND|OR|WITH)\s|[()]/;

/** Convert a licence as a package declares it to CycloneDX's: an expression
 * where it combines several, an SPDX id where it is one of the SPDX licence
 * list's, a name otherwise. */
export function cycloneDxLicense({ text, url }: ILicense): ICycloneDxLicense {
  if (SPDX_OPERATOR.test(text)) {
    return { expression: text };
  }
  return { license: { ...(SPDX_IDS.has(text) ? { id: text } : { name: text }), ...(url === undefined ? {} : { url }) } };
}

/** The names CycloneDX gives the digest algorithms registries publish. */
const HASH_ALGORITHMS = new Map([
  ["sha1", "SHA-1"],
  ["sha256", "SHA-256"],
  ["sha384", "SHA-384"],
  ["sha512", "SHA-512"],
]);

/** Convert a digest to CycloneDX's, in hex; none for an algorithm it does not name. */
export function cycloneDxHash(digest: ExpectedDigest): ICycloneDxHash | undefined {
  const alg = HASH_ALGORITHMS.get(digest.algorithm.toLowerCase());
  if (alg === undefined) {
    return undefined;
  }
  return {
    alg,
    content: digest.encoding === "hex" ? digest.value.toLowerCase() : Buffer.from(digest.value, "base64").toString("hex"),
  };
}

/**
 * Split a purl into the group and name CycloneDX gives a component: its
 * namespace, decoded, and its name, decoded. A purl with no namespace gives
 * the name alone.
 */
export function cycloneDxNaming(purl: string): { group?: string; name: string } {
  const path = purl.substring("pkg:".length, purl.lastIndexOf("@"));
  const parts = path.split("/").slice(1).map(decodeURIComponent);
  const name = parts[parts.length - 1];
  return parts.length > 1 ? { group: parts.slice(0, -1).join("/"), name } : { name };
}

/** @return the name of `pkg` in the document: its purl, else its name and
 * version, a build's with the configuration that tells it from the target's
 * other builds. */
function referenceOf(pkg: Package): string {
  const purl = pkg.version === undefined || builtInProject(pkg.origin) ? undefined : purlOf(pkg.origin, pkg.packageName, pkg.version);
  if (purl !== undefined) {
    return purl;
  }
  const configuration =
    pkg instanceof ResolvedNode && pkg.content.builds !== undefined && pkg.content.configuration
      ? `<${pkg.content.configuration}>`
      : "";
  return `${pkg.packageName}${configuration}${pkg.version === undefined ? "" : `@${pkg.version}`}`;
}

/** Make the pedigree of a component made from the package `from` by a change
 * that fixes the advisories `fixes`. */
function pedigreeOf(from: Package, fixes: ReadonlyArray<string>): NonNullable<ICycloneDxComponent["pedigree"]> {
  const ref = referenceOf(from);
  /* No bom-ref: the package itself may be a component of the document too. */
  const ancestor: Omit<ICycloneDxComponent, "bom-ref"> = {
    type: "library",
    ...(ref.startsWith("pkg:") ? cycloneDxNaming(ref) : { name: from.packageName }),
    ...(from.version === undefined ? {} : { version: from.version }),
    ...(ref.startsWith("pkg:") ? { purl: ref } : {}),
  };
  const patch: ICycloneDxPatch = {
    type: "unofficial",
    ...(fixes.length === 0 ? {} : { resolves: fixes.map(id => ({ type: "security" as const, id })) }),
  };
  return { ancestors: [ancestor], patches: [patch] };
}

/**
 * Make the bill of materials of what `name` resolves to: one target, whose
 * build is the component described and whose rule's requirements are its
 * dependencies; a declaration's requirements (a catalog's), the declaration
 * described by its name with them as its dependencies; or one package, with
 * its closure. A target read for its files (a program a `container_image`
 * holds) is a component its reader depends on, with everything it requires. A
 * name resolving to several things is refused: a bill describes one. `tool`
 * names the fabr that wrote it.
 */
export function sbom(name: ResolvedName, tool: { version: string }): Computable<ICycloneDxBom> {
  const { title, resolved } = name;
  /* A declaration's requirements (a catalog's) describe the declaration, by its name. */
  const declared = !isDenoted(resolved);
  const [only] = resolved.denoted;
  if (!declared && (resolved.denoted.length !== 1 || !isPackage(only))) {
    throw new FabrError(
      `'${title}' resolves to ${
        resolved.denoted.length === 1 ? "something that is not a package" : `${resolved.denoted.length} things`
      }; a bill of materials describes one package or target`
    );
  }
  const described = declared ? undefined : (only as Package);
  const root = {
    type: described === undefined || described instanceof ResolvedTarget ? "application" : "library",
    "bom-ref": described === undefined ? title : referenceOf(described),
  } as const;
  const bill = walkReadingFiles(readFor => {
    /* Every package reached, once, by its reference, with the packages its edges bind. */
    const reached = new Map<string, { pkg: Package; dependsOn: Set<string> }>();
    const walk = (edges: ReadonlyArray<WalkedEdge>): string[] =>
      edges.flatMap(({ edge: { package: pkg }, whole }) => {
        if (pkg === undefined) {
          return [];
        }
        const ref = referenceOf(pkg);
        if (!reached.has(ref) && ref !== root["bom-ref"]) {
          const entry = { pkg, dependsOn: new Set<string>() };
          reached.set(ref, entry);
          walk(walkedEdges(pkg, whole, readFor)).forEach(dep => entry.dependsOn.add(dep));
        }
        return [ref];
      });
    const rootDependsOn = new Set(
      walk(
        described === undefined ? nameEdges(resolved, readFor) : walkedEdges(described, described instanceof ResolvedTarget, readFor)
      )
    );
    return { reached, rootDependsOn };
  });
  const document = (
    reached: ReadonlyMap<string, { pkg: Package; dependsOn: Set<string> }>,
    rootDependsOn: ReadonlySet<string>
  ): Computable<ICycloneDxBom> => {
    const entries = [...reached].sort(([a], [b]) => compareText(a, b));
    const metadata = (pkg: Package): Computable<IVersionMetadata | undefined> =>
      pkg instanceof ResolvedNode && pkg.content.metadata !== undefined ? pkg.content.metadata() : Computable.resolve(undefined);
    return Computable.forAll(
      [described === undefined ? Computable.resolve(undefined) : metadata(described), ...entries.map(([, { pkg }]) => metadata(pkg))],
      (...published: Array<IVersionMetadata | undefined>) => {
        const component = (
          ref: string,
          pkg: Package,
          meta: IVersionMetadata | undefined,
          type: "application" | "library"
        ): ICycloneDxComponent => {
          const hashes = (meta?.hashes ?? []).flatMap(digest => {
            const hash = cycloneDxHash(digest);
            return hash === undefined ? [] : [hash];
          });
          const made = madeFrom(pkg);
          return {
            type,
            "bom-ref": ref,
            ...(ref.startsWith("pkg:") ? cycloneDxNaming(ref) : { name: pkg.packageName }),
            ...(pkg.version === undefined ? {} : { version: pkg.version }),
            ...(ref.startsWith("pkg:") ? { purl: ref } : {}),
            ...(meta === undefined || meta.licenses.length === 0 ? {} : { licenses: meta.licenses.map(cycloneDxLicense) }),
            ...(hashes.length === 0 ? {} : { hashes }),
            ...(made === undefined ? {} : { pedigree: pedigreeOf(made.from, made.fixes) }),
          };
        };
        const [rootMeta, ...rest] = published;
        return {
          bomFormat: "CycloneDX",
          specVersion: "1.6",
          version: 1,
          metadata: {
            tools: { components: [{ type: "application", "bom-ref": "fabr", name: "fabr", version: tool.version }] },
            component:
              described === undefined
                ? { type: root.type, "bom-ref": root["bom-ref"], name: title }
                : component(root["bom-ref"], described, rootMeta, root.type),
          },
          components: entries.map(([ref, { pkg }], at) => component(ref, pkg, rest[at], "library")),
          dependencies: [
            { ref: root["bom-ref"], dependsOn: [...rootDependsOn].sort(compareText) },
            ...entries.map(([ref, { dependsOn }]) => ({ ref, dependsOn: [...dependsOn].sort(compareText) })),
          ],
        };
      }
    );
  };
  return bill.then(({ reached, rootDependsOn }) => document(reached, rootDependsOn));
}
