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
  EMPTY_FILESET,
  FabrError,
  fetchDocument,
  fetchFile,
  FileSet,
  HttpStatusError,
  IProvenanceStep,
  Name,
  NamespaceRef,
  Reference,
  registerProvenanceDescriber,
  registerProvenanceRenderer,
  Repository,
  RepositoryLookup,
  RepositoryPublishRef,
  RepositoryRef,
  sendRequest,
  TargetContext,
  toError,
} from "@fabr-build/core";
import {
  bucketRequest,
  bucketsRequest,
  IBucketLocation,
  IListing,
  isFileKey,
  listRequest,
  objectRequest,
  parseBuckets,
  parseListing,
  regionProbeUrl,
  selectObjects,
} from "./S3Protocol";
import { IServiceRequest, RequestSigner, requestUrl } from "./Signing";

/** The name of the S3 service under an account: the first part of every name in it. */
export const S3_SERVICE = "s3";

/** What an account gives the services under it. */
export interface IAccountSettings {
  /** The account's declared name (`@aws`), for messages. */
  readonly name: string;
  readonly context: TargetContext;
  readonly signer: RequestSigner;
  readonly region?: string;
  readonly endpoint?: URL;
}

/** Provenance kind for an object fetched from S3. */
export const S3_PROVENANCE = "s3-object";

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
 * The S3 service of an account (`@aws:s3`). A name in it is `s3:<bucket>`,
 * followed by the name of what it selects in the bucket: after a `:` the
 * object's key names it (`s3:acme:v3/model.bin` is `v3/model.bin`), after a
 * `/` the bucket does too (`acme/v3/model.bin`). A bucket named alone is a
 * namespace, listed by its keys, and the service alone is listed by the
 * account's buckets. Objects are fetched with the account's credentials and
 * kept as HTTP caching says, revalidated on their ETag.
 */
export class S3Repository implements Repository, RepositoryLookup {
  /** The region of each bucket, found once per run. */
  private readonly regions = new Map<string, Computable<string>>();

  constructor(private readonly account: IAccountSettings) {}

  /** Vend the reference for `name` (see the class comment): an object or objects of a bucket, or the namespace of a bucket or of the service. */
  public getRepositoryRef(name: Name): RepositoryRef | NamespaceRef {
    if (name.getMarker() !== undefined) {
      throw new FabrError(`'${name.toString()}' is an S3 object, not resolved, so an override marker means nothing on it`).withHelp(
        "write the reference without the marker"
      );
    }
    const { bucket, separator, at } = this.splitBucket(name);
    if (bucket === undefined) {
      return new NamespaceRef(this, S3_SERVICE);
    }
    if (separator === undefined) {
      return new NamespaceRef(this, `${S3_SERVICE}:${bucket}`);
    }
    return new RepositoryRef(this, { name: `${S3_SERVICE}:${bucket}`, versionConstraint: undefined }).find(
      name.substring(at),
      separator === "/" ? `${bucket}/` : ""
    );
  }

  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    throw new FabrError(`${this.account.name}:${S3_SERVICE} is not a publish destination yet (cannot sync to '${name.toString()}')`);
  }

  /** List the account's buckets, or what is directly in a bucket or a directory of one: each object by its name there, each bucket and prefix as a namespace. */
  public children({ name }: NamespaceRef): Computable<Map<string, Reference>> {
    if (name === S3_SERVICE) {
      return this.listBuckets().then(
        buckets =>
          new Map(
            [...buckets].sort(compareText).map((bucket): [string, Reference] => [bucket, new NamespaceRef(this, `${S3_SERVICE}:${bucket}`)])
          )
      );
    }
    const within = name.substring(S3_SERVICE.length + 1);
    const slash = within.indexOf("/");
    const bucket = slash === -1 ? within : within.substring(0, slash);
    const prefix = slash === -1 ? "" : `${within.substring(slash + 1)}/`;
    return this.locate(bucket)
      .then(location => this.listAll(location, prefix, "/"))
      .then(({ keys, prefixes }) => {
        const children: Array<[string, Reference]> = [
          ...keys
            .filter(key => isFileKey(key) && key.length > prefix.length)
            .map((key): [string, Reference] => [
              key.substring(prefix.length),
              new RepositoryRef(this, { name: `${S3_SERVICE}:${bucket}`, versionConstraint: undefined }).find(Name.fromLiteral(key)),
            ]),
          ...prefixes.map((listed): [string, Reference] => {
            const directory = listed.replace(/\/$/, "");
            return [directory.substring(prefix.length), new NamespaceRef(this, `${S3_SERVICE}:${bucket}/${directory}`)];
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
    const bucket = reference.name.substring(S3_SERVICE.length + 1);
    const projection = reference.projections[0];
    if (projection === undefined) {
      return Computable.reject(
        new FabrError(`'${this.account.name}:${reference.name}' names a bucket, not objects`).withHelp(
          `name the objects, as in '${this.account.name}:${reference.name}:<key>'`
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
            : this.listAll(location, listed).then(({ keys }) =>
                this.fetchAll(
                  location,
                  keys.filter(key => isFileKey(key) && !selection.objects.includes(key))
                ).then(more => more.filter((fetched): fetched is { files: FileSet } => "files" in fetched).map(({ files }) => files))
              );
        return rest.then(more => {
          const all = [...found, ...more];
          const refused = named.find((fetched): fetched is { absent: HttpStatusError } => "absent" in fetched && fetched.absent.statusCode === 403);
          if (all.length === 0 && refused !== undefined) {
            throw new FabrError(`${refused.absent.url} was not found, or is not readable with ${this.account.name}'s credentials`);
          }
          return all.length === 0 ? EMPTY_FILESET : FileSet.unionAll(...all);
        });
      })
    );
  }

  /** Split the bucket off `name`: undefined where the name is the service alone, with the separator after it and where the rest begins where there is a rest. */
  private splitBucket(name: Name): { bucket?: string; separator?: ":" | "/"; at: number } {
    const literal = name.getLiteralPrefix();
    const written = name.toString();
    if (name.isSimpleName() && literal === S3_SERVICE) {
      return { at: literal.length };
    }
    if (!literal.startsWith(`${S3_SERVICE}:`)) {
      throw new FabrError(`'${written}' does not name a bucket`).withHelp(`write the bucket after '${S3_SERVICE}:', as in '${S3_SERVICE}:<bucket>:<key>'`);
    }
    const start = S3_SERVICE.length + 1;
    const end = literal.slice(start).search(/[:/]/);
    if (end === -1) {
      if (!name.isSimpleName()) {
        throw new FabrError(`'${written}' does not name its bucket literally`).withHelp("a bucket is named as it is, without a pattern");
      }
      return { bucket: checkedBucket(literal.substring(start), written), at: literal.length };
    }
    const bucket = checkedBucket(literal.substring(start, start + end), written);
    return { bucket, separator: literal[start + end] as ":" | "/", at: start + end + 1 };
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
            response.statusCode === 404 ? `S3 has no bucket '${bucket}'` : `cannot find the region of S3 bucket '${bucket}' (${response.statusCode} from ${url})`
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

  /** List every key under `prefix`, a page at a time, grouped at `delimiter` where one is given. */
  private listAll(location: IBucketLocation, prefix: string, delimiter?: string): Computable<IListing> {
    const page = (token: string | undefined, keys: string[], prefixes: string[]): Computable<IListing> => {
      const request = listRequest(location, prefix, token, delimiter);
      const url = requestUrl(request);
      return fetchDocument(this.account.context, {
        url,
        file: "list.xml",
        tag: LISTING_TAG,
        report: { resource: `listing of s3://${location.bucket}/${prefix}`, role: "index" },
        convert: text => parseListing(text, url),
        headers: () => this.signed(request, location),
        options: { immutable: false },
      }).then(listing => {
        if (listing === undefined) {
          throw new FabrError(`S3 has no bucket '${location.bucket}'`);
        }
        const all = { keys: [...keys, ...listing.keys], prefixes: [...prefixes, ...listing.prefixes] };
        return listing.next === undefined ? all : page(listing.next, all.keys, all.prefixes);
      });
    };
    return page(undefined, [], []);
  }

  /** List every bucket of the account, a page at a time. */
  private listBuckets(): Computable<string[]> {
    const { endpoint } = this.account;
    const region = this.account.region ?? "us-east-1";
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

/** Check `bucket` is a name S3 could have given a bucket, naming `written` where it is not. */
function checkedBucket(bucket: string, written: string): string {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new FabrError(`'${written}' names '${bucket}', which is not an S3 bucket name`).withHelp(
      "a bucket's name is 3 to 63 lowercase letters, digits, '.' and '-'"
    );
  }
  return bucket;
}
