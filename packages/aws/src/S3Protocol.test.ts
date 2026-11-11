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

import { expect } from "chai";
import { parseName } from "@fabr-build/core";
import {
  bucketsRequest,
  listRequest,
  objectRequest,
  parseBuckets,
  parseListing,
  putRequest,
  regionProbeUrl,
  selectObjects,
} from "./S3Protocol";
import { requestUrl } from "./Signing";

describe("selecting objects for a name", () => {
  it("fetches the object a literal key names", () => {
    expect(selectObjects(parseName("v3/model.bin"))).to.deep.equal({ objects: ["v3/model.bin"] });
  });

  it("lists from the literal head of a pattern", () => {
    expect(selectObjects(parseName("assets/img*.png"))).to.deep.equal({ objects: [], listed: "assets/img" });
  });

  it("fetches what precedes each ':' of the literal head, where an archive may sit", () => {
    expect(selectObjects(parseName("dist/tool.tgz:*:bin/tool"))).to.deep.equal({
      objects: ["dist/tool.tgz"],
      listed: "dist/tool.tgz/",
    });
    expect(selectObjects(parseName("tool.tgz:bin/tool"))).to.deep.equal({ objects: ["tool.tgz", "tool.tgz/bin/tool"] });
  });

  it("fetches no folder for a name ending at a separator", () => {
    expect(selectObjects(parseName("assets:"))).to.deep.equal({ objects: ["assets"] });
  });

  it("lists the whole bucket for a pattern with no literal head", () => {
    expect(selectObjects(parseName("**"))).to.deep.equal({ objects: [], listed: "" });
  });
});

describe("S3 requests", () => {
  const aws = { bucket: "acme-models", region: "eu-west-2" };

  it("names a bucket in the hostname, and its key in the path, encoded", () => {
    expect(requestUrl(objectRequest(aws, "v3/a model (1).bin"))).to.equal(
      "https://acme-models.s3.eu-west-2.amazonaws.com/v3/a%20model%20%281%29.bin"
    );
  });

  it("names a bucket with a '.' in the path, which S3's certificate would not match as a hostname", () => {
    expect(requestUrl(objectRequest({ bucket: "acme.models", region: "us-east-1" }, "k"))).to.equal(
      "https://s3.us-east-1.amazonaws.com/acme.models/k"
    );
  });

  it("addresses an endpoint by path", () => {
    const endpoint = new URL("http://localhost:9000/store/");
    expect(requestUrl(objectRequest({ ...aws, endpoint }, "v3/x"))).to.equal("http://localhost:9000/store/acme-models/v3/x");
    expect(requestUrl(listRequest({ ...aws, endpoint }, "v3/", "t+1", "/"))).to.equal(
      "http://localhost:9000/store/acme-models?continuation-token=t%2B1&delimiter=%2F&list-type=2&prefix=v3%2F"
    );
  });

  it("stores an object with the headers it is signed with", () => {
    const request = putRequest(aws, "v3/x", new Map([["content-type", "text/plain"]]));
    expect([request.method, requestUrl(request), [...request.headers!]]).to.deep.equal([
      "PUT",
      "https://acme-models.s3.eu-west-2.amazonaws.com/v3/x",
      [["content-type", "text/plain"]],
    ]);
  });

  it("lists a bucket from its root", () => {
    expect(requestUrl(listRequest(aws, ""))).to.equal("https://acme-models.s3.eu-west-2.amazonaws.com/?list-type=2&prefix=");
  });

  it("lists the account's buckets from the account's region, or the endpoint's root", () => {
    expect(requestUrl(bucketsRequest("eu-west-2", undefined))).to.equal("https://s3.eu-west-2.amazonaws.com/?max-buckets=10000");
    expect(requestUrl(bucketsRequest("us-east-1", new URL("http://localhost:4566"), "t"))).to.equal(
      "http://localhost:4566/?continuation-token=t&max-buckets=10000"
    );
  });

  it("asks AWS's global endpoint for a bucket's region", () => {
    expect(regionProbeUrl("acme-models")).to.equal("https://acme-models.s3.amazonaws.com/");
    expect(regionProbeUrl("acme.models")).to.equal("https://s3.amazonaws.com/acme.models");
  });
});

describe("reading a bucket listing", () => {
  const listing = (body: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${body}</ListBucketResult>`;

  it("reads the keys exactly, a space at either end kept", () => {
    expect(
      parseListing(listing("<Contents><Key> a&amp;b </Key><Size>3</Size></Contents><IsTruncated>false</IsTruncated>"), "x")
    ).to.deep.equal({
      objects: [{ key: " a&b " }],
      prefixes: [],
    });
  });

  it("reads each object's ETag", () => {
    expect(
      parseListing(listing('<Contents><Key>a</Key><ETag>"abc"</ETag></Contents><Contents><Key>b</Key></Contents>'), "x").objects
    ).to.deep.equal([{ key: "a", etag: '"abc"' }, { key: "b" }]);
  });

  it("reads the prefixes and the continuation token", () => {
    expect(
      parseListing(
        listing(
          "<Contents><Key>a</Key></Contents><CommonPrefixes><Prefix>d/</Prefix></CommonPrefixes><IsTruncated>true</IsTruncated><NextContinuationToken>tok</NextContinuationToken>"
        ),
        "x"
      )
    ).to.deep.equal({ objects: [{ key: "a" }], prefixes: ["d/"], next: "tok" });
  });

  it("refuses a document that is not a listing", () => {
    expect(() => parseListing("<Error><Code>AccessDenied</Code></Error>", "the listing")).to.throw(
      "the listing is not a bucket listing: its root element is <Error>"
    );
  });

  it("refuses a truncated listing with no token to go on from", () => {
    expect(() => parseListing(listing("<IsTruncated>true</IsTruncated>"), "the listing")).to.throw("gives no continuation token");
  });
});

describe("reading a list of buckets", () => {
  it("reads the buckets' names and the continuation token", () => {
    expect(
      parseBuckets(
        `<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>x</ID></Owner><Buckets>` +
          `<Bucket><Name>acme</Name><CreationDate>2026-01-01T00:00:00Z</CreationDate></Bucket><Bucket><Name>beta</Name></Bucket>` +
          `</Buckets><ContinuationToken>tok</ContinuationToken></ListAllMyBucketsResult>`,
        "x"
      )
    ).to.deep.equal({ buckets: ["acme", "beta"], next: "tok" });
  });

  it("refuses a document that is not a list of buckets", () => {
    expect(() => parseBuckets("<ListBucketResult/>", "the list")).to.throw(
      "the list is not a list of buckets: its root element is <ListBucketResult>"
    );
  });
});
