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
import { inspect } from "util";
import { FabrError } from "./Errors";
import { secure, SecureString } from "./SecureString";

const TOKEN = SecureString.masked("s3cret", "${ENV.TOKEN}");

/** @return `text` as its value and as output shows it. */
function forms(text: SecureString): [string, string] {
  return [text.toUnmaskedString(), text.toDisplayString()];
}

describe("SecureString", () => {
  it("shows a masked run as written, and its value only when asked for", () => {
    const text = secure`--key=${TOKEN} --n=${3}`;
    expect(forms(text)).to.deep.equal(["--key=s3cret --n=3", "--key=${ENV.TOKEN} --n=3"]);
    expect(text.isMasked()).to.equal(true);
    expect(SecureString.of("plain").isMasked()).to.equal(false);
    expect(text.length).to.equal("--key=s3cret --n=3".length);
  });

  it("refuses to become a string implicitly", () => {
    expect(() => `${TOKEN as unknown as string}`).to.throw(/implicitly/);
    expect(() => String(TOKEN)).to.throw(/implicitly/);
    expect(() => JSON.stringify({ token: TOKEN })).to.throw(/implicitly/);
    expect(inspect(TOKEN)).to.equal('SecureString("${ENV.TOKEN}")');
  });

  it("shows what remains of a cut masked run whole", () => {
    const text = secure`a${TOKEN}b`;
    expect(forms(text.slice(0, 3))).to.deep.equal(["as3", "a${ENV.TOKEN}"]);
    expect(forms(text.slice(-3))).to.deep.equal(["etb", "${ENV.TOKEN}b"]);
    expect(forms(text.substring(4, 2))).to.deep.equal(["3c", "${ENV.TOKEN}"]);
    expect(forms(text.at(0)!)).to.deep.equal(["a", "a"]);
    expect(forms(text.at(-2)!)).to.deep.equal(["t", "${ENV.TOKEN}"]);
    expect(text.at(99)).to.equal(undefined);
  });

  it("takes the pieces of one masked run joined again as one run", () => {
    const text = secure`a${TOKEN}b`;
    expect(forms(text.slice(0, 4).concat(text.slice(4)))).to.deep.equal(["as3cretb", "a${ENV.TOKEN}b"]);
  });

  it("joins, splits and trims, keeping masked runs", () => {
    const joined = SecureString.join([TOKEN, "x", SecureString.of("y")], ",");
    expect(forms(joined)).to.deep.equal(["s3cret,x,y", "${ENV.TOKEN},x,y"]);
    expect(joined.split(",").map(part => part.toDisplayString())).to.deep.equal(["${ENV.TOKEN}", "x", "y"]);
    expect(
      SecureString.of("a1b22c")
        .split(/\d+/)
        .map(part => part.toUnmaskedString())
    ).to.deep.equal(["a", "b", "c"]);
    expect(
      SecureString.of("abc")
        .split("")
        .map(part => part.toUnmaskedString())
    ).to.deep.equal(["a", "b", "c"]);
    expect(joined.split(",", 2)).to.have.lengthOf(2);
    expect(forms(secure`  ${TOKEN} `.trim())).to.deep.equal(["s3cret", "${ENV.TOKEN}"]);
    expect(forms(TOKEN.padStart(8, "-").padEnd(10, "."))).to.deep.equal(["--s3cret..", "--${ENV.TOKEN}.."]);
    expect(forms(secure`${TOKEN};`.repeat(2))).to.deep.equal(["s3cret;s3cret;", "${ENV.TOKEN};${ENV.TOKEN};"]);
  });

  it("splits as String.prototype.split splits", () => {
    const cases: Array<[string, string | RegExp, number?]> = [
      ["", ""],
      ["", ","],
      ["abc", ""],
      ["abc", /b*/],
      ["a,b", /(,)/],
      ["a,,b,", ","],
      [",a,", ","],
      ["a1b22c", /\d+/],
      ["a b  c", " ", 2],
      ["abc", "", 0],
      ["a.b", "."],
      ["aXbxc", /x/i],
      [";b", /(,)|(;)/, 2],
      ["-; ab ", /(,)|(;)/, 3],
    ];
    for (const [text, separator, limit] of cases) {
      expect(
        SecureString.of(text)
          .split(separator, limit)
          .map(part => part.toUnmaskedString()),
        `${JSON.stringify(text)}.split(${String(separator)})`
      ).to.deep.equal(text.split(separator as string, limit).filter(part => part !== undefined));
    }
    expect(forms(secure`a,${TOKEN},b`.split(/(,)/)[2])).to.deep.equal(["s3cret", "${ENV.TOKEN}"]);
  });

  it("shows nothing masked in an empty cut of a masked run", () => {
    const cut = secure`x${TOKEN}y`.slice(3, 3);
    expect(cut.isMasked()).to.equal(false);
    expect(forms(cut)).to.deep.equal(["", ""]);
  });

  it("replaces matches literally, a replacement's masked runs kept", () => {
    const text = SecureString.of("a-b-c");
    expect(forms(text.replace("-", TOKEN))).to.deep.equal(["as3cretb-c", "a${ENV.TOKEN}b-c"]);
    expect(forms(text.replaceAll("-", "$&"))).to.deep.equal(["a$&b$&c", "a$&b$&c"]);
    expect(forms(text.replace(/-/g, "+"))).to.deep.equal(["a+b+c", "a+b+c"]);
    expect(forms(secure`x${TOKEN}`.replace("cr", "CR"))).to.deep.equal(["xs3CRet", "x${ENV.TOKEN}CR${ENV.TOKEN}"]);
  });

  it("maps each run apart, a masked run's result masked", () => {
    const text = secure`a b/${SecureString.masked("c d", "${ENV.D}")}`;
    expect(forms(text.mapRuns(encodeURIComponent))).to.deep.equal(["a%20b%2Fc%20d", "a%20b%2F${ENV.D}"]);
    expect(forms(text.toUpperCase())).to.deep.equal(["A B/C D", "A B/${ENV.D}"]);
  });

  it("answers queries of its text", () => {
    const text = secure`id=${TOKEN}`;
    expect(text.indexOf("=")).to.equal(2);
    expect(text.lastIndexOf("e")).to.equal(text.length - 2);
    expect(text.includes("cre")).to.equal(true);
    expect(text.startsWith("id=")).to.equal(true);
    expect(text.endsWith("et")).to.equal(true);
    expect(text.search(/\d/)).to.equal(4);
    expect(text.test(/^id=s\d/g)).to.equal(true);
    expect(text.equals("id=s3cret")).to.equal(true);
    expect(text.equals(secure`id=${SecureString.of("s3cret")}`)).to.equal(true);
  });

  it("is shown as output shows it in an error's message and help", () => {
    const err = new FabrError(secure`cannot sign in with ${TOKEN}`).withHelp([secure`check ${TOKEN}`, "or ask"]);
    expect([err.message, err.help]).to.deep.equal(["cannot sign in with ${ENV.TOKEN}", ["check ${ENV.TOKEN}", "or ask"]]);
  });

  it("masks nothing for an empty masked value", () => {
    expect(SecureString.masked("", "${ENV.EMPTY}").isMasked()).to.equal(false);
  });
});
