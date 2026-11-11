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
  compareText,
  Computable,
  Credential,
  FabrError,
  FileSet,
  IProvenanceStep,
  MemoryCache,
  Name,
  onlyTo,
  PartialRepositoryRef,
  Property,
  registerProvenanceDescriber,
  registerProvenanceRenderer,
  Repository,
  RepositoryLookup,
  PackagePublishRef,
  PublishableFileSet,
  PublishMember,
  PublishStatus,
  Reference,
  RepositoryPublishRef,
  RepositoryRef,
  RepositoryWriter,
  ResolvedNode,
  RunnableFileSet,
  TargetContext,
  RepositoryImplementation,
} from "@fabr-build/core";
import { ImageFileSet, ILayerRecord } from "./ImageFileSet";
import { imageRunnable } from "./ImageRunnable";
import { isDigest, splitImageReference } from "./ImageReference";
import { packageImage, pushImage } from "./ImagePublish";
import { authFileSignIn } from "./RegistrySignIn";
import {
  IDigested,
  IImageManifest,
  imageManifestOf,
  IOciPlatform,
  indexPlatforms,
  platformMatches,
  platformText,
  Registry,
  selectManifest,
} from "./OciProtocol";

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

/** What a reference asks the registry for. */
interface IImageRequest {
  /** The repository at the registry (`library/node`). */
  readonly repository: string;
  /** The reference as written, under the repository's declared name. */
  readonly written: string;
  /** The platform the image is for: `OCI_TARGET`'s. */
  readonly wanted: IOciPlatform;
}

/**
 * A registry speaking the OCI distribution API (`@docker`). A name in it is an
 * image's name and its tag or digest (`node:22-bookworm-slim`,
 * `node:sha256:<hex>`), and what follows selects among the image's files
 * (`node:22:usr/local/bin/node`). An image's name alone is a namespace. Each
 * reference is looked up on its own, nothing selected among versions: the
 * image for `OCI_TARGET`'s platform, its layers fetched only when its files
 * are wanted.
 */
export class OciRepository implements Repository, RepositoryLookup, RepositoryWriter {
  /** Each image fetched this run, by registry, repository and digest. */
  private readonly images = new MemoryCache<string, ImageFileSet>();

  constructor(
    private readonly context: TargetContext,
    private readonly registry: Registry,
    /** The namespace a single-segment name is in (`library` on Docker Hub), where the registry has one. */
    private readonly defaultNamespace?: string,
    /** The name the registry's login is stored under, where it is not the host of its URL (`login_url`). */
    private readonly loginUrl?: string
  ) {}

  public getRepositoryRef(name: Name): RepositoryRef | PartialRepositoryRef {
    const written = name.toString();
    if (name.getMarker() !== undefined) {
      throw new FabrError(`'${written}' is an image, not resolved, so an override marker means nothing on it`).withHelp(
        "write the reference without the marker"
      );
    }
    const literal = name.getLiteralPrefix();
    if (literal === "" && name.isSimpleName()) {
      return new PartialRepositoryRef(this, "");
    }
    const { name: image, version, rest } = splitImageReference(literal, written);
    if (version === undefined) {
      if (!name.isSimpleName()) {
        throw new FabrError(`'${written}' does not name its image literally`).withHelp(
          "an image is named as it is, without a pattern"
        );
      }
      return new PartialRepositoryRef(this, image);
    }
    const reference = new RepositoryRef(this, { name: image, versionConstraint: version });
    return rest === undefined ? reference : reference.find(name.substring(rest.at), rest.separator === "/" ? `${version}/` : "");
  }

  /** List the tags of the image a namespace names, each as the reference to its image; the registry's every image cannot be listed. */
  public children({ name }: PartialRepositoryRef): Computable<Map<string, Reference>> {
    if (name === "") {
      return Computable.reject(
        new FabrError(`${this.context.name} cannot list every image it holds`).withHelp(
          `name an image to list its tags, as in '${this.context.name}:node'`
        )
      );
    }
    return this.registry.tags(this.repositoryOf(name)).then(tags => {
      if (tags === undefined) {
        throw new FabrError(`${this.registry.url} has no image ${name}`);
      }
      return new Map(
        [...tags].sort(compareText).map((tag): [string, Reference] => [tag, new RepositoryRef(this, { name, versionConstraint: tag })])
      );
    });
  }

  /** Vend the publish coordinate `name` names: an image's name and the tag it is published under. */
  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    const written = name.toString();
    const { name: image, version, rest } = splitImageReference(name.getLiteralPrefix(), written);
    if (!name.isSimpleName() || version === undefined || isDigest(version) || rest !== undefined) {
      throw new FabrError(`'${written}' is no image and tag to publish to`).withHelp(
        "name the image and the tag it is published under, as in 'myorg/app:1.4'"
      );
    }
    return new PackagePublishRef(this, { name: image, version });
  }

  /** Package each member's image for this registry (see {@link packageImage}). */
  public package(members: PublishMember[]): Computable<PublishableFileSet[]> {
    return Computable.forAll(
      members.map(member => packageImage(this.context, member)),
      (...carriers: PublishableFileSet[]) => carriers
    );
  }

  /** Push a packaged image under its tag (see {@link pushImage}). */
  public publish(artifact: PublishableFileSet): Computable<PublishStatus> {
    return pushImage(this.context, this.registry, artifact, this.repositoryOf(artifact.destination.name));
  }

  /**
   * Answer `reference` with the node of its image for `OCI_TARGET`'s platform:
   * a package named as written, at the digest of the platform's manifest,
   * which its tag resolves to here. Its config and layers are fetched only
   * when its files are wanted, once a run. Under `run` its files are the
   * image as a program the container engine runs (see {@link imageRunnable}).
   */
  public resolve(reference: RepositoryRef): Computable<ResolvedNode> {
    return this.context.getGlobalString(OCI_TARGET).then(triple => {
      const version = reference.versionConstraint!;
      const request: IImageRequest = {
        repository: this.repositoryOf(reference.name),
        written: `${this.context.name}:${reference.name}:${version}`,
        wanted: ociPlatformOf(triple),
      };
      return this.manifestFor(request, version).then(manifest => {
        const origin: IImageOrigin = {
          kind: OCI_IMAGE_PROVENANCE,
          image: request.written,
          digest: manifest.digest,
          platform: platformText(request.wanted),
        };
        const key = `${this.registry.url} ${request.repository}@${manifest.digest}`;
        const image = (): Computable<ImageFileSet> =>
          this.images.getOrCreate(key, () => this.image(request, manifest, reference.name, origin));
        /* Under `run`, the image is a program the container engine runs. */
        const files = (): Computable<FileSet> =>
          this.context.operation === "run"
            ? Computable.forAll(
                [image(), this.context.getGlobalRunnable("CONTAINER_ENGINE")] as const,
                (pulled: ImageFileSet, engine: RunnableFileSet) => imageRunnable(pulled, reference.name, engine, this.context)
              )
            : image();
        return new ResolvedNode(
          { key: this.context.operation === "run" ? `runnable ${key}` : key, files },
          reference.name,
          manifest.digest,
          [],
          origin
        );
      });
    });
  }

  /** Find the manifest of the image `request` asks for: the one `version` names, or, where that is an index, the one in it for the platform. */
  private manifestFor({ repository, written, wanted }: IImageRequest, version: string): Computable<IDigested<IImageManifest>> {
    return this.registry.manifest(repository, version).then(served => {
      if (served === undefined) {
        throw new FabrError(`${this.registry.url} has no image ${written}`);
      }
      const { document } = served;
      if (document.kind === "manifest") {
        return { ...served, document };
      }
      const entry = selectManifest(document.manifests, wanted);
      if (entry === undefined) {
        const has = indexPlatforms(document.manifests).join(", ");
        throw new FabrError(`${written} has no image for ${platformText(wanted)}`).withHelp(
          has === "" ? "the image names no platform" : `it has images for ${has}; set ${OCI_TARGET} to one of them`
        );
      }
      return this.registry.manifest(repository, entry.digest).then(chosen => {
        const found = chosen === undefined ? undefined : imageManifestOf(chosen);
        if (found === undefined) {
          throw new FabrError(`${this.registry.url} has no image manifest ${entry.digest} for ${written}`);
        }
        return found;
      });
    });
  }

  /** Fetch the config and layers of the image `manifest` is, as `request` asked for it. */
  private image(
    { repository, written, wanted }: IImageRequest,
    { document: manifest, digest }: IDigested<IImageManifest>,
    name: string,
    origin: IImageOrigin
  ): Computable<ImageFileSet> {
    return this.registry.config(repository, manifest.config).then(config => {
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
          this.registry.layer(repository, layer, config.diffIds[index]).then((stored): ILayerRecord => ({
            ...stored,
            published: {
              digest: layer.digest,
              mediaType: layer.mediaType,
              size: layer.size,
              registry: this.registry.url,
              repository,
              ...(this.loginUrl === undefined ? {} : { loginUrl: this.loginUrl }),
            },
          }))
        ),
        (...layers: ILayerRecord[]) => ImageFileSet.of(config, layers, name, digest, origin)
      );
    });
  }

  /** @return the repository an image's name is in at the registry: a single-segment name's in the default namespace. */
  private repositoryOf(image: string): string {
    return this.defaultNamespace !== undefined && !image.includes("/") ? `${this.defaultNamespace}/${image}` : image;
  }
}

/**
 * Make the repository an `oci_repository` declaration declares, or a namespace
 * makes with `url` and `credential`: the declaration's `url` over the one
 * given, and a `credential` in place of signing in with the auth files' (see
 * {@link authFileSignIn}).
 */
function createRepository(context: TargetContext, url?: string, credential?: Credential): Computable<Repository> {
  return Computable.forAll(
    [context.getProperty("url"), context.getProperty("default_namespace"), context.getProperty("login_url")],
    (declared: Property | undefined, defaultNamespace: Property | undefined, loginUrl: Property | undefined) => {
      const written = declared?.toString() ?? url;
      if (written === undefined) {
        throw new FabrError("Missing required property url");
      }
      const base = written.replace(/\/+$/, "");
      const signIn = registrySignIn(context, base, loginUrl?.toString(), credential);
      return new OciRepository(
        context,
        new Registry(context, base, signIn),
        defaultNamespace?.toString(),
        credential === undefined ? loginUrl?.toString() : undefined
      );
    }
  );
}

/** The implementation CONTAINER.fabr's `repository` declaration names. */
/**
 * Make what signs in the requests to the registry at `base`: `credential`, or
 * the auth files' login for `loginUrl`, applied to the registry's own origin
 * alone, so a blob read or an upload elsewhere carries nothing of it.
 */
export function registrySignIn(context: TargetContext, base: string, loginUrl?: string, credential?: Credential): Credential {
  return onlyTo(new URL(base).origin, credential ?? authFileSignIn(context, base, loginUrl));
}

export default { provider: createRepository } satisfies RepositoryImplementation;
