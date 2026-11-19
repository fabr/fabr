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
  INTOTO_PAYLOAD_TYPE,
  ISigstoreInstance,
  parseJson,
  provenanceStatement,
  SerializedBundle,
  SIGSTORE_AUDIENCE,
  signDsse,
  TargetContext,
  toJsonObject,
} from "@fabr-build/core";
import { digestOf, IDescriptor, OCI_INDEX, OCI_MANIFEST, Registry } from "./OciProtocol";

/** The media type of a Sigstore bundle, as an attestation's artifact type and its one layer. */
const SIGSTORE_BUNDLE = "application/vnd.dev.sigstore.bundle.v0.3+json";

/** OCI's empty descriptor content, the config of an artifact that has none. */
const OCI_EMPTY = "application/vnd.oci.empty.v1+json";
const EMPTY_CONTENT = Buffer.from("{}", "utf8");

/** A signed provenance statement for an image, ready to attach to it. */
export interface IImageAttestation {
  readonly bundle: SerializedBundle;
  /** The predicate type of the statement the bundle signs. */
  readonly predicateType: string;
}

/**
 * Sign a provenance statement that the CI job's build built the image whose
 * manifest is `manifest`, published as `name` (`host/repository`), where it
 * applies: the job states its build and its source repository is public.
 * Undefined where it does not apply; any failure once it applies is an error.
 */
export function signImageProvenance(
  context: TargetContext,
  name: string,
  manifest: IDescriptor,
  sigstore: ISigstoreInstance
): Computable<IImageAttestation | undefined> {
  const provider = context.execution.identityProvider;
  const build = provider?.build;
  if (!provider || !build) {
    return Computable.resolve(undefined);
  }
  return build.isPublicSource().then(isPublic => {
    if (!isPublic) {
      return undefined;
    }
    const subject = { name, digest: { sha256: manifest.digest.substring("sha256:".length) } };
    const statement = Buffer.from(JSON.stringify(provenanceStatement(subject, build)));
    return provider
      .token(SIGSTORE_AUDIENCE)
      .then(token => signDsse(statement, INTOTO_PAYLOAD_TYPE, token, sigstore))
      .then((bundle): IImageAttestation => ({ bundle, predicateType: build.predicateType }));
  });
}

/**
 * Attach `attestation` to the image `subject` in `repository`, as an OCI
 * referrer: an artifact manifest whose subject is the image, its one layer
 * the Sigstore bundle. Where the registry does not say it recorded the
 * subject (no `OCI-Subject` on the put), the referrer is added to the
 * referrers tag index (`sha256-<hex>`) instead, as the distribution spec
 * says a client does for a registry without the referrers API.
 */
export function attachImageAttestation(
  registry: Registry,
  repository: string,
  subject: IDescriptor,
  attestation: IImageAttestation
): Computable<void> {
  const bundle = Buffer.from(JSON.stringify(attestation.bundle), "utf8");
  const config: IDescriptor = { mediaType: OCI_EMPTY, digest: digestOf(EMPTY_CONTENT), size: EMPTY_CONTENT.length };
  const layer: IDescriptor = { mediaType: SIGSTORE_BUNDLE, digest: digestOf(bundle), size: bundle.length };
  const annotations = {
    "dev.sigstore.bundle.content": "dsse-envelope",
    "dev.sigstore.bundle.predicateType": attestation.predicateType,
    "org.opencontainers.image.created": new Date().toISOString(),
  };
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      artifactType: SIGSTORE_BUNDLE,
      config,
      layers: [layer],
      subject: { mediaType: subject.mediaType, digest: subject.digest, size: subject.size },
      annotations,
    }),
    "utf8"
  );
  const digest = digestOf(manifest);
  return Computable.forAll(
    [ensureBlob(registry, repository, config, EMPTY_CONTENT), ensureBlob(registry, repository, layer, bundle)],
    () => undefined
  )
    .then(() => registry.putManifest(repository, digest, manifest, OCI_MANIFEST))
    .then(recorded => {
      if (recorded === subject.digest) {
        return Computable.resolve(undefined);
      }
      const entry = { mediaType: OCI_MANIFEST, artifactType: SIGSTORE_BUNDLE, digest, size: manifest.length, annotations };
      return addReferrer(registry, repository, subject.digest, entry);
    });
}

/** Upload `content`, of `blob`, to `repository` where the repository lacks it. */
function ensureBlob(registry: Registry, repository: string, blob: IDescriptor, content: Buffer): Computable<void> {
  return registry
    .hasBlob(repository, blob.digest)
    .then(held => (held ? Computable.resolve(undefined) : registry.uploadBlob(repository, blob.digest, blob.size, content)));
}

/**
 * Add `entry`, a referrer of `subject`, to the referrers tag index of
 * `subject` in `repository`, kept as the registry holds it: made where there
 * is none, unchanged where it already lists the referrer.
 */
function addReferrer(registry: Registry, repository: string, subject: string, entry: { digest: string }): Computable<void> {
  const tag = subject.replace(":", "-");
  return registry.currentManifest(repository, tag).then(held => {
    const manifests = held === undefined ? [] : parseJson(held.toString("utf8"), `${repository}:${tag}`, toReferrerEntries);
    if (manifests.some(listed => listed.digest === entry.digest)) {
      return Computable.resolve(undefined);
    }
    const index = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: [...manifests, entry] }), "utf8");
    return registry.putManifest(repository, tag, index, OCI_INDEX).then(() => undefined);
  });
}

/** Read the entries of a referrers tag index, each as written. */
function toReferrerEntries(json: unknown): Array<Record<string, unknown>> {
  const { manifests } = toJsonObject(json);
  if (!Array.isArray(manifests)) {
    throw new FabrError("the referrers index has no 'manifests'");
  }
  return manifests.map(entry => toJsonObject(entry));
}
