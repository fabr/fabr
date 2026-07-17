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
 */

import { expect } from "chai";
import { NPMConfig, parseNpmrc } from "./NPMConfig";

/** Base64, for building `_auth`/`_password` fixtures. */
function b64(s: string): string {
  return Buffer.from(s).toString("base64");
}

describe("parseNpmrc", () => {
  it("parses key=value, skipping blanks, comments and section headers", () => {
    const entries = parseNpmrc(
      ["# a comment", "; another", "[a-section]", "", "//reg/:_authToken=abc", "registry = https://reg/  "].join("\n")
    );
    expect(entries.get("//reg/:_authToken")).to.equal("abc");
    expect(entries.get("registry")).to.equal("https://reg/");
    expect(entries.has("# a comment")).to.equal(false);
    expect(entries.has("[a-section]")).to.equal(false);
  });

  it("substitutes ${VAR} from the environment (unset → empty)", () => {
    process.env.FABR_NPMRC_TEST = "sekret";
    try {
      const entries = parseNpmrc("//reg/:_authToken=${FABR_NPMRC_TEST}\n//other/:_authToken=${FABR_NPMRC_MISSING}");
      expect(entries.get("//reg/:_authToken")).to.equal("sekret");
      expect(entries.get("//other/:_authToken")).to.equal("");
    } finally {
      delete process.env.FABR_NPMRC_TEST;
    }
  });

  it("strips surrounding quotes", () => {
    expect(parseNpmrc('//reg/:_authToken="quoted"').get("//reg/:_authToken")).to.equal("quoted");
  });
});

describe("NPMConfig.getHeadersFor", () => {
  it("sends _authToken as Bearer, matched by longest registry prefix", () => {
    const config = new NPMConfig(
      new Map([
        ["//registry.example.org/:_authToken", "root-token"],
        ["//registry.example.org/private/:_authToken", "scoped-token"],
      ])
    );
    /* Deeper path → the more specific key wins. */
    expect(config.getHeadersFor("https://registry.example.org/private/pkg")).to.deep.equal({
      Authorization: "Bearer scoped-token",
    });
    expect(config.getHeadersFor("https://registry.example.org/public/pkg")).to.deep.equal({
      Authorization: "Bearer root-token",
    });
  });

  it("sends _auth as Basic verbatim", () => {
    const config = new NPMConfig(new Map([["//reg/:_auth", b64("user:pass")]]));
    expect(config.getHeadersFor("https://reg/pkg")).to.deep.equal({ Authorization: `Basic ${b64("user:pass")}` });
  });

  it("builds Basic from username + base64 _password", () => {
    const config = new NPMConfig(new Map([["//reg/:username", "alice"], ["//reg/:_password", b64("hunter2")]]));
    expect(config.getHeadersFor("https://reg/pkg")).to.deep.equal({ Authorization: `Basic ${b64("alice:hunter2")}` });
  });

  it("prefers _authToken over the other mechanisms", () => {
    const config = new NPMConfig(new Map([["//reg/:_authToken", "tok"], ["//reg/:_auth", b64("u:p")]]));
    expect(config.getHeadersFor("https://reg/pkg")).to.deep.equal({ Authorization: "Bearer tok" });
  });

  it("matches registry prefixes at a path boundary, not a bare string prefix", () => {
    /* A non-slash-terminated key (`//host/npm`) must not leak its credential to a
     * sibling path (`//host/npm-other`); it applies only under `//host/npm/`. */
    const config = new NPMConfig(new Map([["//host/npm:_authToken", "tok"]]));
    expect(config.getHeadersFor("https://host/npm/pkg")).to.deep.equal({ Authorization: "Bearer tok" });
    expect(config.getHeadersFor("https://host/npm")).to.deep.equal({ Authorization: "Bearer tok" });
    expect(config.getHeadersFor("https://host/npm-other/pkg")).to.deep.equal({});
  });

  it("sends no headers for a host with no configured credential", () => {
    const config = new NPMConfig(new Map([["//reg/:_authToken", "tok"]]));
    expect(config.getHeadersFor("https://cdn.other.net/pkg-1.0.0.tgz")).to.deep.equal({});
  });

  it("layers project over user (project overrides on a shared key)", () => {
    /* Sources in increasing precedence: user first, project last (wins the shared key). */
    const config = NPMConfig.fromSources("//reg/:_authToken=user\n//user-only/:_authToken=u", "//reg/:_authToken=project");
    expect(config.getHeadersFor("https://reg/pkg")).to.deep.equal({ Authorization: "Bearer project" });
    expect(config.getHeadersFor("https://user-only/pkg")).to.deep.equal({ Authorization: "Bearer u" });
  });
});
