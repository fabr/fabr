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

import {
  Computable,
  FabrError,
  IProvenanceStep,
  Name,
  NamespaceRef,
  PendingFiles,
  Property,
  registerProvenanceDescriber,
  registerProvenanceRenderer,
  Repository,
  RepositoryLookup,
  RepositoryPublishRef,
  RepositoryRef,
  RepositoryRegistration,
  TargetContext,
} from "@fabr-build/core";
import { ImageFileSet, ILayerRecord } from "./ImageFileSet";
import { splitImageReference } from "./ImageReference";
import { IImageManifest, IOciPlatform, indexPlatforms, platformMatches, platformText, Registry, selectManifest } from "./OciProtocol";

/** Provenance kind for an image fetched from a registry. */
export const OCI_IMAGE_PROVENANCE = "oci-image";

interface IImageOrigin extends IProvenanceStep {
  readonly kind: typeof OCI_IMAGE_PROVENANCE;
  /** The image as written, under the repository's declared name (`@docker:node:22`). */
  readonly image: string;
  /** The manifest's digest, which a tag resolved to. */
  readonly digest: string;
  readonly platform: string;
}

registerProvenanceRenderer(OCI_IMAGE_PROVENANCE, step => {
  const origin = step as IImageOrigin;
  return [{ message: `image ${origin.image} (${origin.digest}, ${origin.platform})` }];
});
registerProvenanceDescriber(OCI_IMAGE_PROVENANCE, step => `${(step as IImageOrigin).image}@${(step as IImageOrigin).digest}`);

/** The configuration property naming the platform images are built for and looked up at. */
export const OCI_TARGET = "OCI_TARGET";

/** Each CPU of a target triple, as OCI names its architecture and variant. */
const ARCHITECTURES: ReadonlyArray<[RegExp, Pick<IOciPlatform, "architecture" | "variant">]> = [
  [/^x86_64$/, { architecture: "amd64" }],
  [/^(aarch64|arm64)$/, { architecture: "arm64" }],
  [/^armv7/, { architecture: "arm", variant: "v7" }],
  [/^armv6/, { architecture: "arm", variant: "v6" }],
  [/^i[3-6]86$/, { architecture: "386" }],
  [/^riscv64/, { architecture: "riscv64" }],
  [/^s390x$/, { architecture: "s390x" }],
  [/^(powerpc64le|ppc64le)$/, { architecture: "ppc64le" }],
];

/**
 * Read a target triple as OCI's platform: its CPU as an architecture (and an
 * arm variant), and its OS, which must be `linux`.
 */
export function ociPlatformOf(triple: string): IOciPlatform {
  const [cpu, , os] = triple.split("-");
  if (os !== "linux") {
    throw new FabrError(`'${triple}' is not a Linux platform, which is all an image can be built for`).withHelp(
      `set ${OCI_TARGET} to a Linux triple, as in 'x86_64-unknown-linux'`
    );
  }
  const found = ARCHITECTURES.find(([pattern]) => pattern.test(cpu ?? ""));
  if (found === undefined) {
    throw new FabrError(`'${cpu}' in '${triple}' is no CPU an image is built for`);
  }
  return { os, ...found[1] };
}

/**
 * A registry speaking the OCI distribution API (`@docker`). A name in it is an
 * image's name and its tag or digest (`node:22-bookworm-slim`,
 * `node:sha256:<hex>`), and what follows selects among the image's files
 * (`node:22:usr/local/bin/node`). An image's name alone is a namespace. Each
 * reference is looked up on its own, nothing selected among versions: the
 * image for `OCI_TARGET`'s platform, fetched only when its files are wanted.
 */
export class OciRepository implements Repository, RepositoryLookup {
  constructor(
    private readonly context: TargetContext,
    private readonly registry: Registry,
    /** The namespace a single-segment name is in (`library` on Docker Hub), where the registry has one. */
    private readonly defaultNamespace?: string
  ) {}

  public getRepositoryRef(name: Name): RepositoryRef | NamespaceRef {
    const written = name.toString();
    if (name.getMarker() !== undefined) {
      throw new FabrError(`'${written}' is an image, not resolved, so an override marker means nothing on it`).withHelp("write the reference without the marker");
    }
    const literal = name.getLiteralPrefix();
    if (literal === "" && name.isSimpleName()) {
      return new NamespaceRef(this, "");
    }
    const { name: image, version, rest } = splitImageReference(literal, written);
    if (version === undefined) {
      if (!name.isSimpleName()) {
        throw new FabrError(`'${written}' does not name its image literally`).withHelp("an image is named as it is, without a pattern");
      }
      return new NamespaceRef(this, image);
    }
    const reference = new RepositoryRef(this, { name: image, versionConstraint: version });
    return rest === undefined ? reference : reference.find(name.substring(rest.at), rest.separator === "/" ? `${version}/` : "");
  }

  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    throw new FabrError(`${this.context.name} is not a publish destination yet (cannot sync to '${name.toString()}')`);
  }

  /** Answer `reference` with its image's files pending: nothing is fetched until they are wanted. */
  public resolve(reference: RepositoryRef): Computable<PendingFiles> {
    return Computable.resolve(new PendingFiles(() => this.image(reference)));
  }

  /** Fetch the image `reference` names for `OCI_TARGET`'s platform. */
  private image(reference: RepositoryRef): Computable<ImageFileSet> {
    const repository = this.repositoryOf(reference.name);
    const version = reference.versionConstraint!;
    const written = `${this.context.name}:${reference.name}:${version}`;
    return this.context.getGlobalString(OCI_TARGET).then(triple => {
      const wanted = ociPlatformOf(triple);
      return this.registry
        .manifest(repository, version)
        .then(served => {
          if (served === undefined) {
            throw new FabrError(`${this.registry.url} has no image ${reference.name}:${version}`);
          }
          if (served.document.kind === "manifest") {
            return { manifest: served.document as IImageManifest, digest: served.digest };
          }
          const entry = selectManifest(served.document.manifests, wanted);
          if (entry === undefined) {
            const has = indexPlatforms(served.document.manifests).join(", ");
            throw new FabrError(`${written} has no image for ${platformText(wanted)}`).withHelp(
              has === "" ? "the image names no platform" : `it has images for ${has}; set ${OCI_TARGET} to one of them`
            );
          }
          return this.registry.manifest(repository, entry.digest).then(chosen => {
            if (chosen === undefined || chosen.document.kind !== "manifest") {
              throw new FabrError(`${this.registry.url} has no image manifest ${entry.digest} for ${written}`);
            }
            return { manifest: chosen.document as IImageManifest, digest: chosen.digest };
          });
        })
        .then(({ manifest, digest }) =>
          this.registry.config(repository, manifest.config).then(config => {
            if (!platformMatches(config.platform, wanted)) {
              throw new FabrError(`${written} is an image for ${platformText(config.platform)}, not ${platformText(wanted)}`).withHelp(
                `set ${OCI_TARGET} to its platform, or name an image for ${platformText(wanted)}`
              );
            }
            if (config.diffIds.length !== manifest.layers.length) {
              throw new FabrError(`${written}'s config names ${config.diffIds.length} layers, its manifest ${manifest.layers.length}`);
            }
            return Computable.forAll(
              manifest.layers.map((layer, index) =>
                this.registry.layer(repository, layer, config.diffIds[index]).then(
                  (stored): ILayerRecord => ({
                    ...stored,
                    published: { digest: layer.digest, mediaType: layer.mediaType, size: layer.size, from: `${this.registry.url}/${repository}` },
                  })
                )
              ),
              (...layers: ILayerRecord[]) => {
                const origin: IImageOrigin = { kind: OCI_IMAGE_PROVENANCE, image: written, digest, platform: platformText(wanted) };
                return new ImageFileSet(config, layers, origin);
              }
            );
          })
        );
    });
  }

  /** Name the repository an image's name is in at the registry: a single-segment name in the default namespace. */
  private repositoryOf(image: string): string {
    return this.defaultNamespace !== undefined && !image.includes("/") ? `${this.defaultNamespace}/${image}` : image;
  }
}

/** Make the repository an `oci_repository` declaration declares. */
function createRepository(context: TargetContext): Computable<Repository> {
  return Computable.forAll(
    [context.getRequiredString("url"), context.getProperty("default_namespace")],
    (url: string, defaultNamespace: Property | undefined) =>
      new OciRepository(context, new Registry(context, url.replace(/\/+$/, "")), defaultNamespace?.toString())
  );
}

export const ociRepositoryRegistration: RepositoryRegistration = { type: "oci_repository", provider: createRepository };

/** The implementation CONTAINER.fabr's `repository` declaration names. */
export default createRepository;
