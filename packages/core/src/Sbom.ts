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

import { ResolvedName, rootEdges } from "./Audit";
import { Computable } from "./core/Computable";
import { FabrError } from "./core/Errors";
import { Dependency, isPackage, Package, ResolvedNode } from "./core/PackageFileSet";
import { ILicense, IVersionMetadata } from "./core/Repository";
import { ResolvedTarget } from "./context/index";
import { builtInProject } from "./model/Target";
import { purlOf } from "./resolver/ResolutionProvenance";
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

/** An SPDX licence id or a single licence name, as against an expression over several. */
const SPDX_ID = /^[A-Za-z0-9.+-]+$/;
const SPDX_OPERATOR = /\s(AND|OR|WITH)\s|[()]/;

/** Convert a licence as a package declares it to CycloneDX's: an expression
 * where it combines several, an SPDX id where it is spelled as one, a name otherwise. */
export function cycloneDxLicense({ text, url }: ILicense): ICycloneDxLicense {
  if (SPDX_OPERATOR.test(text)) {
    return { expression: text };
  }
  return { license: { ...(SPDX_ID.test(text) ? { id: text } : { name: text }), ...(url === undefined ? {} : { url }) } };
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

/** Name a package in the document: its purl, else its name and version, a
 * build with the configuration that tells it from the target's other builds. */
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

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Make the bill of materials of what `name` resolves to: one target, whose
 * build is the component described and whose rule's requirements are its
 * dependencies, or one package, with its closure. A name resolving to several
 * things is refused: a bill describes one. `tool` names the fabr that wrote it.
 */
export function sbom(name: ResolvedName, tool: { version: string }): Computable<ICycloneDxBom> {
  const { title, resolved } = name;
  const [only] = resolved.denoted;
  if (resolved.denoted.length !== 1 || !isPackage(only)) {
    throw new FabrError(
      `'${title}' resolves to ${
        resolved.denoted.length === 1 ? "something that is not a package" : `${resolved.denoted.length} things`
      }; a bill of materials describes one package or target`
    );
  }
  const root: ICycloneDxComponent = {
    type: only instanceof ResolvedTarget ? "application" : "library",
    "bom-ref": referenceOf(only),
    name: only.packageName,
    ...(only.version === undefined ? {} : { version: only.version }),
  };
  const rootPurl = only instanceof ResolvedTarget ? undefined : referenceOf(only);
  if (rootPurl !== undefined && rootPurl.startsWith("pkg:")) {
    root.purl = rootPurl;
  }
  /* Every package reached, once, by its reference, with the packages its edges bind. */
  const reached = new Map<string, { pkg: Package; dependsOn: Set<string> }>();
  const walk = (deps: ReadonlyArray<Dependency>): string[] =>
    deps.flatMap(({ package: pkg }) => {
      if (pkg === undefined) {
        return [];
      }
      const ref = referenceOf(pkg);
      if (!reached.has(ref) && ref !== root["bom-ref"]) {
        const entry = { pkg, dependsOn: new Set<string>() };
        reached.set(ref, entry);
        walk(pkg.dependencies).forEach(dep => entry.dependsOn.add(dep));
      }
      return [ref];
    });
  const rootDependsOn = new Set(walk(only instanceof ResolvedTarget ? rootEdges(resolved) : only.dependencies));
  const refs = [...reached.keys()].sort(compareText);
  const metadata = (pkg: Package): Computable<IVersionMetadata | undefined> =>
    pkg instanceof ResolvedNode && pkg.content.metadata !== undefined ? pkg.content.metadata() : Computable.resolve(undefined);
  return Computable.forAll(
    [metadata(only), ...refs.map(ref => metadata(reached.get(ref)!.pkg))],
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
        return {
          type,
          "bom-ref": ref,
          ...(ref.startsWith("pkg:") ? cycloneDxNaming(ref) : { name: pkg.packageName }),
          ...(pkg.version === undefined ? {} : { version: pkg.version }),
          ...(ref.startsWith("pkg:") ? { purl: ref } : {}),
          ...(meta === undefined || meta.licenses.length === 0 ? {} : { licenses: meta.licenses.map(cycloneDxLicense) }),
          ...(hashes.length === 0 ? {} : { hashes }),
        };
      };
      const [rootMeta, ...rest] = published;
      return {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        version: 1,
        metadata: {
          tools: { components: [{ type: "application", "bom-ref": "fabr", name: "fabr", version: tool.version }] },
          component: component(root["bom-ref"], only, rootMeta, root.type),
        },
        components: refs.map((ref, at) => component(ref, reached.get(ref)!.pkg, rest[at], "library")),
        dependencies: [
          { ref: root["bom-ref"], dependsOn: [...rootDependsOn].sort(compareText) },
          ...refs.map(ref => ({ ref, dependsOn: [...reached.get(ref)!.dependsOn].sort(compareText) })),
        ],
      };
    }
  );
}
