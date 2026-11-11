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
  contentSize,
  contentStream,
  EMPTY_FILESET,
  FabrError,
  fetchDocument,
  fetchFile,
  FileSet,
  HttpStatusError,
  ITaskReport,
  IProvenanceStep,
  mapComputable,
  Name,
  PartialRepositoryRef,
  PublishableFileSet,
  PublishMember,
  PublishStatus,
  Reference,
  registerProvenanceDescriber,
  registerProvenanceRenderer,
  reportingProgress,
  Repository,
  RepositoryLookup,
  RepositoryRef,
  RepositoryWriter,
  sendRequest,
  toError,
} from "@fabr-build/core";
import {
  bucketRequest,
  bucketsRequest,
  headRequest,
  IBucketLocation,
  IListedObject,
  IListing,
  isFileKey,
  listRequest,
  objectRequest,
  parseBuckets,
  parseListing,
  putRequest,
  regionProbeUrl,
  selectObjects,
} from "./S3Protocol";
import {
  checkedPublishKey,
  publishHelp,
  checksumOf,
  contentTypeOf,
  etagOf,
  IStoredObject,
  packageS3Member,
  S3PublishRef,
  s3CoordinateOf,
  sha256Of,
  storedObjects,
} from "./S3Publish";
import { IServiceRequest, requestUrl } from "./Signing";
import { IAccountSettings } from "./Types";

/** The name of the S3 service under an account: the first part of every name in it. */
export const S3_SERVICE = "s3";

/** Provenance kind for an object fetched from S3. */
const S3_PROVENANCE = "s3-object";

interface IS3Origin extends IProvenanceStep {
  readonly kind: typeof S3_PROVENANCE;
  /** The account it was fetched with (`@aws`). */
  readonly account: string;
  readonly url: string;
}

registerProvenanceRenderer(S3_PROVENANCE, step => {
  const origin = step as IS3Origin;
  return [{ message: `fetched from ${origin.url} with ${origin.account}` }];
});
registerProvenanceDescriber(S3_PROVENANCE, step => (step as IS3Origin).url);

/** Bumped when what is stored under an object's or a listing's key changes shape. */
const OBJECT_TAG = "aws:s3:object:1";
const LISTING_TAG = "aws:s3:list:1";
const BUCKETS_TAG = "aws:s3:buckets:1";

/** What fetching one object found: its file, or the refusal where it was absent or not ours to read. */
type Fetched = { readonly files: FileSet } | { readonly absent: HttpStatusError };

/**
 * The S3 service of an account (`@aws:s3`). A name in it is a bucket,
 * followed by the name of what it selects in the bucket: after a `:` the
 * object's key names it (`acme:v3/model.bin` is `v3/model.bin`), after a
 * `/` the bucket does too (`acme/v3/model.bin`). A bucket named alone is a
 * namespace, listed by its keys, and the service alone is listed by the
 * account's buckets. Objects are fetched with the account's credentials and
 * kept as HTTP caching says, revalidated on their ETag. A `sync` member
 * publishes to an object or a prefix ({@link S3PublishRef}).
 */
export class S3Repository implements Repository, RepositoryLookup, RepositoryWriter {
  /** The region of each bucket, found once per run. */
  private readonly regions = new Map<string, Computable<string>>();

  /** The name the service is written as (`@aws:s3`), for messages. */
  private readonly written: string;

  constructor(private readonly account: IAccountSettings) {
    this.written = `${account.name}:${S3_SERVICE}`;
  }

  /** Vend the reference for `name` (see the class comment): an object or objects of a bucket, or the namespace of a bucket. */
  public getRepositoryRef(name: Name): RepositoryRef | PartialRepositoryRef {
    if (name.getMarker() !== undefined) {
      throw new FabrError(`'${name.toString()}' is an S3 object, not resolved, so an override marker means nothing on it`).withHelp(
        "write the reference without the marker"
      );
    }
    const { bucket, separator, at } = this.splitBucket(name);
    if (separator === undefined) {
      return new PartialRepositoryRef(this, bucket);
    }
    return new RepositoryRef(this, { name: bucket, versionConstraint: undefined }).find(
      name.substring(at),
      separator === "/" ? `${bucket}/` : ""
    );
  }

  /** Vend the coordinate `name` publishes at: an object's key, or a prefix ending in `/` (see {@link S3PublishRef}). */
  public getRepositoryPublishRef(name: Name): S3PublishRef {
    const written = `${this.written}:${name.toString()}`;
    if (!name.isSimpleName() || name.getMarker() !== undefined || name.getRenameTo() !== undefined) {
      throw new FabrError(
        `'${written}' is not an S3 address to publish to: it is written as a pattern, a rename or with a marker`
      ).withHelp(publishHelp(this.account.name));
    }
    const { bucket, separator, at } = this.splitBucket(name);
    const key = checkedPublishKey(separator === undefined ? "" : name.getLiteralPrefix().substring(at), written, this.account.name);
    return new S3PublishRef(this, bucket, key);
  }

  /** Package each member as the objects it is stored as (see {@link packageS3Member}). */
  public package(members: PublishMember[]): Computable<PublishableFileSet[]> {
    try {
      return Computable.resolve(members.map(packageS3Member));
    } catch (err) {
      return Computable.reject(toError(err));
    }
  }

  /**
   * Store the objects `artifact` holds, each read as it is sent, skipping one
   * the bucket already holds ({@link holds}): `already-synced` where it holds
   * them all. Nothing else under a prefix is changed. `report` is told the
   * bytes sent of all the objects stored.
   */
  public publish(artifact: PublishableFileSet, report: ITaskReport): Computable<PublishStatus> {
    const coordinate = s3CoordinateOf(artifact.destination);
    const objects = storedObjects(artifact);
    return this.locate(coordinate.bucket).then(location =>
      this.storedAt(location, coordinate)
        .then(stored =>
          mapComputable(objects, object =>
            this.holds(location, object, stored.get(object.key)).then(held => (held ? undefined : object))
          )
        )
        .then(missing => {
          const toStore = missing.filter((object): object is IStoredObject => object !== undefined);
          return mapComputable(toStore, object => contentSize(object.file)).then(sizes => {
            const total = sizes.reduce((sum, size) => sum + size, 0);
            const sent = toStore.map(() => 0);
            const progress = (index: number, bytes: number): void => {
              sent[index] = bytes;
              report.progress({ measure: "bytes", done: sent.reduce((sum, each) => sum + each, 0), total });
            };
            return mapComputable(toStore, (object, index) =>
              this.store(location, object, sizes[index], bytes => progress(index, bytes))
            ).then((): PublishStatus => (toStore.length > 0 ? "published" : "already-synced"));
          });
        })
    );
  }

  /** List the account's buckets, or what is directly in a bucket or a directory of one: each object by its name there, each bucket and prefix as a namespace. */
  public children({ name }: PartialRepositoryRef): Computable<Map<string, Reference>> {
    if (name === "") {
      return this.listBuckets().then(
        buckets =>
          new Map(
            [...buckets].sort(compareText).map((bucket): [string, Reference] => [bucket, new PartialRepositoryRef(this, bucket)])
          )
      );
    }
    const within = name;
    const slash = within.indexOf("/");
    const bucket = slash === -1 ? within : within.substring(0, slash);
    const prefix = slash === -1 ? "" : `${within.substring(slash + 1)}/`;
    return this.locate(bucket)
      .then(location => this.listAll(location, prefix, "/"))
      .then(({ objects, prefixes }) => {
        const children: Array<[string, Reference]> = [
          ...objects
            .map(({ key }) => key)
            .filter(key => isFileKey(key) && key.length > prefix.length)
            .map((key): [string, Reference] => [
              key.substring(prefix.length),
              new RepositoryRef(this, { name: bucket, versionConstraint: undefined }).find(Name.fromLiteral(key)),
            ]),
          ...prefixes.map((listed): [string, Reference] => {
            const directory = listed.replace(/\/$/, "");
            return [directory.substring(prefix.length), new PartialRepositoryRef(this, `${bucket}/${directory}`)];
          }),
        ];
        return new Map(children.sort(([a], [b]) => compareText(a, b)));
      });
  }

  /**
   * Fetch the objects `reference` can select, named by their keys: the object
   * its first projection names literally, or everything under the literal head
   * of its pattern (see {@link selectObjects}). Its projections then select from
   * them, as from any repository's files.
   */
  public resolve(reference: RepositoryRef): Computable<FileSet> {
    const bucket = reference.name;
    const projection = reference.projections[0];
    if (projection === undefined) {
      return Computable.reject(
        new FabrError(`'${this.written}:${reference.name}' names a bucket, not objects`).withHelp(
          `name the objects, as in '${this.written}:${reference.name}:<key>'`
        )
      );
    }
    let selection: ReturnType<typeof selectObjects>;
    try {
      selection = selectObjects(projection.pattern);
    } catch (err) {
      return Computable.reject(toError(err));
    }
    return this.locate(bucket).then(location =>
      this.fetchAll(location, selection.objects).then(named => {
        const found = named.filter((fetched): fetched is { files: FileSet } => "files" in fetched).map(({ files }) => files);
        const { listed } = selection;
        const rest =
          listed === undefined
            ? Computable.resolve<FileSet[]>([])
            : this.listAll(location, listed).then(({ objects }) =>
                this.fetchAll(
                  location,
                  objects.map(({ key }) => key).filter(key => isFileKey(key) && !selection.objects.includes(key))
                ).then(more => more.filter((fetched): fetched is { files: FileSet } => "files" in fetched).map(({ files }) => files))
              );
        return rest.then(more => {
          const all = [...found, ...more];
          const refused = named.find(
            (fetched): fetched is { absent: HttpStatusError } => "absent" in fetched && fetched.absent.statusCode === 403
          );
          if (all.length === 0 && refused !== undefined) {
            throw new FabrError(`${refused.absent.url} was not found, or is not readable with ${this.account.name}'s credentials`);
          }
          return all.length === 0 ? EMPTY_FILESET : FileSet.unionAll(...all);
        });
      })
    );
  }

  /** Split the bucket off `name`, with the separator after it and where the rest begins where there is a rest. */
  private splitBucket(name: Name): { bucket: string; separator?: ":" | "/"; at: number } {
    const literal = name.getLiteralPrefix();
    const written = `${this.written}:${name.toString()}`;
    const end = literal.search(/[:/]/);
    if (end === -1) {
      if (!name.isSimpleName()) {
        throw new FabrError(`'${written}' does not name its bucket literally`).withHelp(
          "a bucket is named as it is, without a pattern"
        );
      }
      return { bucket: checkedBucket(literal, written), at: literal.length };
    }
    const bucket = checkedBucket(literal.substring(0, end), written);
    return { bucket, separator: literal[end] as ":" | "/", at: end + 1 };
  }

  /**
   * Find where requests for `bucket` go: its region in AWS, or the account's
   * endpoint. Asked once per run, which is also where a bucket that does not
   * exist is refused (an object's 404 cannot say whether its bucket is missing).
   */
  private locate(bucket: string): Computable<IBucketLocation> {
    const { endpoint, region } = this.account;
    let found = this.regions.get(bucket);
    if (found === undefined && endpoint !== undefined) {
      const location: IBucketLocation = { bucket, region: region ?? "us-east-1", endpoint };
      const request = bucketRequest(location);
      found = this.signed(request, location)
        .then(headers => sendRequest(requestUrl(request), { method: "HEAD", headers }))
        .then(response => {
          if (response.statusCode === 404) {
            throw new FabrError(`${endpoint.origin} has no bucket '${bucket}'`);
          }
          return location.region;
        });
      this.regions.set(bucket, found);
    } else if (found === undefined) {
      const url = regionProbeUrl(bucket);
      found = sendRequest(url, { method: "HEAD" }).then(response => {
        const header = response.headers["x-amz-bucket-region"];
        const named = Array.isArray(header) ? header[0] : header;
        if (named === undefined || named === "") {
          throw new FabrError(
            response.statusCode === 404
              ? `S3 has no bucket '${bucket}'`
              : `cannot find the region of S3 bucket '${bucket}' (${response.statusCode} from ${url})`
          );
        }
        return named;
      });
      this.regions.set(bucket, found);
    }
    return found.then(named => ({ bucket, region: named, ...(endpoint === undefined ? {} : { endpoint }) }));
  }

  /** Fetch the objects `keys` names, in order, each found or absent. */
  private fetchAll(location: IBucketLocation, keys: readonly string[]): Computable<Fetched[]> {
    return Computable.forAll(
      keys.map(key => this.fetchObject(location, key)),
      (...fetched: Fetched[]) => fetched
    );
  }

  /** Fetch the object `key`, kept under its URL and revalidated as HTTP caching says. A 404 or a 403 is its absence: S3 answers 403 for a missing key to whoever may not list the bucket. */
  private fetchObject(location: IBucketLocation, key: string): Computable<Fetched> {
    const request = objectRequest(location, key);
    const url = requestUrl(request);
    const origin: IS3Origin = { kind: S3_PROVENANCE, account: this.account.name, url: `s3://${location.bucket}/${key}` };
    return fetchFile(this.account.context, {
      key: url,
      tag: OBJECT_TAG,
      report: { resource: origin.url, role: "content" },
      name: key,
      source: () => this.signed(request, location).then(headers => ({ url, expected: undefined, headers })),
      options: { immutable: false },
    }).then(
      (files): Fetched => ({ files: files.withOrigin(origin) }),
      (err): Fetched => {
        if (err instanceof HttpStatusError && (err.statusCode === 404 || err.statusCode === 403)) {
          return { absent: err };
        }
        throw err;
      }
    );
  }

  /** List every key under `prefix`, a page at a time, grouped at `delimiter` where one is given, and read afresh where `current`. */
  private listAll(location: IBucketLocation, prefix: string, delimiter?: string, current = false): Computable<IListing> {
    const page = (token: string | undefined, objects: IListedObject[], prefixes: string[]): Computable<IListing> => {
      const request = listRequest(location, prefix, token, delimiter);
      const url = requestUrl(request);
      return fetchDocument(this.account.context, {
        url,
        file: "list.xml",
        tag: LISTING_TAG,
        report: { resource: `listing of s3://${location.bucket}/${prefix}`, role: "index" },
        convert: text => parseListing(text, url),
        headers: () => this.signed(request, location),
        options: { immutable: false, forceRevalidate: current },
      }).then(listing => {
        if (listing === undefined) {
          throw new FabrError(`S3 has no bucket '${location.bucket}'`);
        }
        const all = { objects: [...objects, ...listing.objects], prefixes: [...prefixes, ...listing.prefixes] };
        return listing.next === undefined ? all : page(listing.next, all.objects, all.prefixes);
      });
    };
    return page(undefined, [], []);
  }

  /** Find what is stored at `coordinate` now, by key: everything under a prefix (`ListObjectsV2`, which gives no checksums), or the one object (`HeadObject`). */
  private storedAt(location: IBucketLocation, coordinate: S3PublishRef): Computable<Map<string, IStoredState>> {
    if (coordinate.isPrefix) {
      return this.listAll(location, coordinate.key, undefined, true).then(
        ({ objects }) => new Map(objects.map(({ key, etag }) => [key, { etag }]))
      );
    }
    return this.headObject(location, coordinate.key).then(state => new Map(state === undefined ? [] : [[coordinate.key, state]]));
  }

  /**
   * @return true if `stored`, what the bucket holds at `object`'s key, is
   * `object`'s file, otherwise false: its ETag is the file's MD5, or, where it
   * is not (an encrypted bucket's ETag is no MD5), its stored SHA-256 checksum
   * is the file's, read with a `HeadObject` where it is not yet known.
   */
  private holds(location: IBucketLocation, object: IStoredObject, stored: IStoredState | undefined): Computable<boolean> {
    if (stored === undefined) {
      return Computable.resolve(false);
    }
    return etagOf(object.file).then(etag => {
      if (stored.etag === etag) {
        return true;
      }
      const checksum =
        stored.checksum !== undefined
          ? Computable.resolve(stored.checksum)
          : this.headObject(location, object.key).then(state => state?.checksum);
      return checksum.then(found => found === checksumOf(object.file));
    });
  }

  /** Read what is stored at `key` (`HeadObject`): its ETag and SHA-256 checksum, or undefined where nothing readable is. */
  private headObject(location: IBucketLocation, key: string): Computable<IStoredState | undefined> {
    const request = headRequest(location, key);
    return this.signed(request, location)
      .then(headers => sendRequest(requestUrl(request), { method: "HEAD", headers }))
      .then(response => {
        if (response.statusCode !== 200) {
          return undefined;
        }
        const header = response.headers["x-amz-checksum-sha256"];
        const checksum = Array.isArray(header) ? header[0] : header;
        return { etag: response.headers.etag, ...(checksum === undefined ? {} : { checksum }) };
      });
  }

  /**
   * Store `object` (`PutObject`), `size` bytes read as they are sent, checked by
   * S3 against its SHA-256 and kept with it as its checksum. `sent` is told the
   * bytes sent so far.
   */
  private store(
    location: IBucketLocation,
    { key, file }: IStoredObject,
    size: number,
    sent: (bytes: number) => void
  ): Computable<void> {
    return contentStream(file).then(content => {
      const body = reportingProgress(content, sent);
      const request = putRequest(
        location,
        key,
        new Map([
          ["content-length", String(size)],
          ["content-type", contentTypeOf(key, file)],
          ["x-amz-content-sha256", sha256Of(file)],
          ["x-amz-checksum-sha256", checksumOf(file)],
        ])
      );
      return this.signed(request, location)
        .then(headers => sendRequest(requestUrl(request), { method: "PUT", headers, body }))
        .then(response => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            throw new FabrError(
              `cannot store s3://${location.bucket}/${key} (${response.statusCode}): ${errorMessageOf(response.body)}`
            );
          }
        });
    });
  }

  /** List every bucket of the account, a page at a time. */
  private listBuckets(): Computable<string[]> {
    const { endpoint } = this.account;
    const region = this.account.region;
    const page = (token: string | undefined, buckets: string[]): Computable<string[]> => {
      const request = bucketsRequest(region, endpoint, token);
      const url = requestUrl(request);
      return fetchDocument(this.account.context, {
        url,
        file: "buckets.xml",
        tag: BUCKETS_TAG,
        report: { resource: `buckets of ${this.account.name}`, role: "index" },
        convert: text => parseBuckets(text, url),
        headers: () => this.account.signer.sign(request, S3_SERVICE, region),
        options: { immutable: false },
      }).then(
        listing => {
          if (listing === undefined) {
            throw new FabrError(`${url} has no list of buckets`);
          }
          const all = [...buckets, ...listing.buckets];
          return listing.next === undefined ? all : page(listing.next, all);
        },
        err => {
          if (err instanceof HttpStatusError && err.statusCode === 403) {
            throw new FabrError(`${this.account.name}'s credentials may not list its buckets`).withHelp(
              `listing them needs s3:ListAllMyBuckets; a bucket can still be read by name, as in '${this.account.name}:${S3_SERVICE}:<bucket>:<key>'`
            );
          }
          throw err;
        }
      );
    };
    return page(undefined, []);
  }

  private signed(request: IServiceRequest, location: IBucketLocation): Computable<Record<string, string>> {
    return this.account.signer.sign(request, S3_SERVICE, location.region);
  }
}

/** What is stored at a key: its ETag, and its SHA-256 checksum where it is known to have one. */
interface IStoredState {
  readonly etag?: string;
  readonly checksum?: string;
}

/** Read the message of an S3 error document, or its text where it is none. */
function errorMessageOf(body: Buffer): string {
  const text = body.toString("utf8");
  const message = /<Message>([^<]*)<\/Message>/.exec(text)?.[1];
  const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1];
  return message === undefined ? text.trim() || "no detail given" : code === undefined ? message : `${code}: ${message}`;
}

/** Check `bucket` is a name S3 could have given a bucket, naming `written` where it is not. */
function checkedBucket(bucket: string, written: string): string {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new FabrError(`'${written}' names '${bucket}', which is not an S3 bucket name`).withHelp(
      "a bucket's name is 3 to 63 lowercase letters, digits, '.' and '-'"
    );
  }
  return bucket;
}
