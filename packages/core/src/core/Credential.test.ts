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
import { Computable } from "./Computable";
import { onlyTo, RenewableToken } from "./Credential";

/** A token whose fetches are answered by the test: each is held until `answer` or `refuse`. */
function scripted(): {
  token: RenewableToken<string>;
  fetches: () => number;
  answer: (value: string) => void;
  refuse: (message: string) => void;
} {
  const pending: Array<{ resolve: (value: string) => void; reject: (err: Error) => void }> = [];
  let count = 0;
  const token = new RenewableToken<string>(() => {
    count++;
    return Computable.from<string>((resolve, reject) => pending.push({ resolve, reject }));
  });
  return {
    token,
    fetches: () => count,
    answer: value => pending.shift()!.resolve(value),
    refuse: message => pending.shift()!.reject(new Error(message)),
  };
}

function outcome(token: Computable<string>): Promise<string> {
  return new Promise(resolve => token.then(resolve, (err: Error) => resolve(`refused: ${err.message}`)));
}

const CHALLENGE = { challenges: ['Bearer realm="x"'] };

describe("RenewableToken", () => {
  it("fetches once, sharing the fetch with every request made while it is under way, and holds the token", async () => {
    const { token, fetches, answer } = scripted();
    const first = token.forRequest();
    const second = token.forRequest();
    answer("t1");
    expect(await outcome(first)).to.equal("t1");
    expect(await outcome(second)).to.equal("t1");
    expect(await outcome(token.current())).to.equal("t1");
    expect(fetches()).to.equal(1);
  });

  it("fetches again answering a challenge, once for requests challenged together", async () => {
    const { token, fetches, answer } = scripted();
    const held = token.forRequest();
    answer("t1");
    await outcome(held);
    const first = token.forRequest(CHALLENGE);
    const second = token.forRequest(CHALLENGE);
    answer("t2");
    expect([await outcome(first), await outcome(second)]).to.deep.equal(["t2", "t2"]);
    expect(await outcome(token.forRequest())).to.equal("t2");
    expect(fetches()).to.equal(2);
  });

  it("fetches again on next use where its fetch failed", async () => {
    const { token, fetches, answer, refuse } = scripted();
    const failed = token.forRequest();
    refuse("down");
    expect(await outcome(failed)).to.equal("refused: down");
    const retried = token.forRequest();
    answer("t1");
    expect(await outcome(retried)).to.equal("t1");
    expect(await outcome(token.forRequest())).to.equal("t1");
    expect(fetches()).to.equal(2);
  });

  it("holds no fetch that failed before it returned", async () => {
    let count = 0;
    const token = new RenewableToken<string>(() =>
      ++count === 1 ? Computable.reject<string>(new Error("no credentials")) : Computable.resolve("t2")
    );
    expect(await outcome(token.current())).to.equal("refused: no credentials");
    expect(await outcome(token.current())).to.equal("t2");
    expect(count).to.equal(2);
  });
});

describe("onlyTo", () => {
  it("signs in requests to the origin alone, and answers no challenge from another", async () => {
    const credential = onlyTo("https://acme-1.d.codeartifact.us-east-1.amazonaws.com", {
      authorize: () => Computable.resolve(new Map([["authorization", "Bearer t"]])),
    });
    const at = (url: string): { method: string; url: string; headers: Map<string, string> } => ({
      method: "GET",
      url,
      headers: new Map(),
    });
    expect(await credential.authorize(at("https://acme-1.d.codeartifact.us-east-1.amazonaws.com/npm/shared/lodash"))).to.deep.equal(
      new Map([["authorization", "Bearer t"]])
    );
    expect(await credential.authorize(at("https://cdn.example/lodash.tgz"))).to.deep.equal(new Map());
    expect(await credential.authorize(at("https://cdn.example/lodash.tgz"), { challenges: [] })).to.equal(undefined);
  });
});
