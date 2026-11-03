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

/**
 * S3's wire protocol, as far as reading objects: where a request for an object
 * or a listing goes, which objects a written name can select, and the
 * `ListObjectsV2` and `ListBuckets` documents.
 */

import * as sax from "sax";
import { FabrError, Name } from "@fabr-build/core";
import { IServiceRequest, uriEncode } from "./Signing";

/** Where a bucket's requests go: AWS's S3 in the bucket's region, or an S3-compatible store. */
export interface IBucketLocation {
  readonly bucket: string;
  readonly region: string;
  /** The store's URL, where it is not AWS. */
  readonly endpoint?: URL;
}

/**
 * What to ask a bucket for to answer a pattern, before the pattern itself
 * selects among what is found:
 *
 * - `objects`: keys to fetch where they exist — the whole name where it is
 *   literal, and what precedes each `:` of its literal head, which an
 *   archive object may sit at (`dist/tool.tgz:*:bin/tool`).
 * - `listed`: a prefix to list, for a pattern with a glob.
 *
 * A literal name selects one file, never what is beneath it, as over any
 * repository's files.
 */
export interface IObjectSelection {
  readonly objects: readonly string[];
  readonly listed?: string;
}

/** Work out what to ask a bucket for to answer `pattern`, a name within it (see {@link IObjectSelection}). */
export function selectObjects(pattern: Name): IObjectSelection {
  const literal = pattern.getLiteralPrefix();
  const whole = pattern.isSimpleName();
  if (!whole && pattern.getSubstitutions().length > 0) {
    throw new FabrError(`'${pattern.toString()}' has a substitution left in it`);
  }
  const head = whole ? `${literal}:` : literal.substring(0, literal.lastIndexOf(":") + 1);
  const objects: string[] = [];
  for (let at = head.indexOf(":"); at !== -1; at = head.indexOf(":", at + 1)) {
    const key = toKey(head.substring(0, at));
    if (isFileKey(key) && !objects.includes(key)) {
      objects.push(key);
    }
  }
  return whole ? { objects } : { objects, listed: toKey(literal) };
}

/** Make the key a name's text names: a `:` is a path separator, as on disk. */
function toKey(text: string): string {
  return text.replaceAll(":", "/");
}

/** @return true if `key` names an object that is a file, otherwise false: a key ending in `/` is a folder marker. */
export function isFileKey(key: string): boolean {
  return key !== "" && !key.endsWith("/");
}

/** Make the request for the object `key` in a bucket. */
export function objectRequest(location: IBucketLocation, key: string): IServiceRequest {
  const base = bucketBase(location);
  return { ...base, method: "GET", path: `${base.path}/${key.split("/").map(uriEncode).join("/")}`, query: new Map() };
}

/** Make the request whose answer says whether a bucket exists (`HeadBucket`). */
export function bucketRequest(location: IBucketLocation): IServiceRequest {
  const base = bucketBase(location);
  return { ...base, method: "HEAD", path: base.path === "" ? "/" : base.path, query: new Map() };
}

/** Make the request for one page of a bucket's keys under `prefix`, from `token` where it is not the first, and grouped at `delimiter` where one is given. */
export function listRequest(location: IBucketLocation, prefix: string, token?: string, delimiter?: string): IServiceRequest {
  const base = bucketBase(location);
  const query = new Map([
    ["list-type", "2"],
    ["prefix", prefix],
  ]);
  if (token !== undefined) {
    query.set("continuation-token", token);
  }
  if (delimiter !== undefined) {
    query.set("delimiter", delimiter);
  }
  return { ...base, method: "GET", path: base.path === "" ? "/" : base.path, query };
}

/**
 * Make the request for one page of the account's buckets (`ListBuckets`), from
 * `token` where it is not the first: to `endpoint` where there is one, else to
 * AWS in `region`, whose answer is every bucket of the account, whatever its
 * region.
 */
export function bucketsRequest(region: string, endpoint: URL | undefined, token?: string): IServiceRequest {
  const query = new Map([["max-buckets", String(BUCKETS_PAGE)]]);
  if (token !== undefined) {
    query.set("continuation-token", token);
  }
  if (endpoint !== undefined) {
    return {
      method: "GET",
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: endpoint.port === "" ? undefined : Number(endpoint.port),
      path: `${endpoint.pathname.replace(/\/+$/, "")}/`,
      query,
    };
  }
  return { method: "GET", protocol: "https:", hostname: `s3.${region}.amazonaws.com`, path: "/", query };
}

/** The most buckets a `ListBuckets` page asks for (S3's own limit). */
const BUCKETS_PAGE = 10000;

/** Make the URL whose response says the region of `bucket` in AWS (its `x-amz-bucket-region` header), asked for without credentials. */
export function regionProbeUrl(bucket: string): string {
  return isVirtualHostable(bucket) ? `https://${bucket}.s3.amazonaws.com/` : `https://s3.amazonaws.com/${uriEncode(bucket)}`;
}

/** Make the parts of a request to a bucket other than its method, the key's path and the query: the bucket in the hostname where it can be, else in the path. */
function bucketBase(location: IBucketLocation): Pick<IServiceRequest, "protocol" | "hostname" | "port" | "path"> {
  const { bucket, region, endpoint } = location;
  if (endpoint !== undefined) {
    const root = endpoint.pathname.replace(/\/+$/, "");
    return {
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: endpoint.port === "" ? undefined : Number(endpoint.port),
      path: `${root}/${uriEncode(bucket)}`,
    };
  }
  return isVirtualHostable(bucket)
    ? { protocol: "https:", hostname: `${bucket}.s3.${region}.amazonaws.com`, path: "" }
    : { protocol: "https:", hostname: `s3.${region}.amazonaws.com`, path: `/${uriEncode(bucket)}` };
}

/** @return true if `bucket` can be named in a hostname (a name with `.` in it would not match S3's certificate), otherwise false. */
function isVirtualHostable(bucket: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(bucket);
}

/** One page of a bucket's keys. */
export interface IListing {
  /** The keys of the objects listed. */
  readonly keys: readonly string[];
  /** The prefixes the keys were grouped into, where a delimiter was given. */
  readonly prefixes: readonly string[];
  /** The token for the next page, where there is one. */
  readonly next?: string;
}

/**
 * Read an S3 response document, calling `visit` with the path of each element
 * from the root (`ListBucketResult/Contents/Key`) and its text, exactly as
 * written (a key may begin or end with a space). Throws, naming `what` as not
 * `kind`, where the document is not well formed or its root is not `root`.
 */
function readDocument(text: string, what: string, kind: string, root: string, visit: (path: string, value: string) => void): void {
  const parser = sax.parser(true);
  const fail = (message: string): never => {
    throw new FabrError(`${what} is not ${kind}: ${message}`);
  };
  const open: string[] = [];
  let found: string | undefined;
  let content: string[] = [];
  parser.onerror = err => fail(err.message.split("\n")[0]);
  parser.onopentag = tag => {
    const name = tag.name.substring(tag.name.indexOf(":") + 1);
    found ??= name;
    open.push(name);
    content = [];
  };
  parser.ontext = data => content.push(data);
  parser.oncdata = data => content.push(data);
  parser.onclosetag = () => {
    visit(open.join("/"), content.join(""));
    open.pop();
    content = [];
  };
  parser.write(text).close();
  if (found !== root) {
    fail(found === undefined ? "the document is empty" : `its root element is <${found}>`);
  }
}

/** Read a `ListObjectsV2` response. Throws, naming `what`, where it is not one. */
export function parseListing(text: string, what: string): IListing {
  const keys: string[] = [];
  const prefixes: string[] = [];
  let next: string | undefined;
  let truncated = false;
  readDocument(text, what, "a bucket listing", "ListBucketResult", (path, value) => {
    switch (path) {
      case "ListBucketResult/Contents/Key":
        keys.push(value);
        break;
      case "ListBucketResult/CommonPrefixes/Prefix":
        prefixes.push(value);
        break;
      case "ListBucketResult/NextContinuationToken":
        next = value;
        break;
      case "ListBucketResult/IsTruncated":
        truncated = value.trim() === "true";
        break;
    }
  });
  if (truncated && next === undefined) {
    throw new FabrError(`${what} is not a bucket listing: it is truncated but gives no continuation token`);
  }
  return { keys, prefixes, ...(truncated ? { next } : {}) };
}

/** One page of an account's buckets. */
export interface IBucketListing {
  /** The buckets' names. */
  readonly buckets: readonly string[];
  /** The token for the next page, where there is one. */
  readonly next?: string;
}

/** Read a `ListBuckets` response. Throws, naming `what`, where it is not one. */
export function parseBuckets(text: string, what: string): IBucketListing {
  const buckets: string[] = [];
  let next: string | undefined;
  readDocument(text, what, "a list of buckets", "ListAllMyBucketsResult", (path, value) => {
    if (path === "ListAllMyBucketsResult/Buckets/Bucket/Name") {
      buckets.push(value.trim());
    } else if (path === "ListAllMyBucketsResult/ContinuationToken" && value.trim() !== "") {
      next = value.trim();
    }
  });
  return { buckets, ...(next === undefined ? {} : { next }) };
}
