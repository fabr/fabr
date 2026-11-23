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
import * as os from "os";
import * as path from "path";
import { takeProcessSlot, withProcessSlot } from "./ProcessSlot";

/** A stand-in for `@playwright/test`, whose module is itself `test`, with `extend` making a new `test` that records its calls. */
function playwrightModule(): {
  module: { test: { extend(fixtures: Record<string, unknown>): unknown }; expect: string };
  calls: string[];
} {
  const calls: string[] = [];
  const make = (name: string): ((title: string) => void) & { extend(fixtures: Record<string, unknown>): unknown; describe: string } =>
    Object.assign((title: string) => void calls.push(`${name}: ${title}`), {
      extend: (fixtures: Record<string, unknown>) => make(`${name} + ${Object.keys(fixtures).join(",")}`),
      describe: `${name}.describe`,
    });
  const original = make("original");
  const module = Object.assign(original, { test: original, expect: "the module's expect" });
  return { module, calls };
}

describe("withProcessSlot", () => {
  it("makes the module's test, its default and calling the module itself reach the test with the slot fixture", () => {
    const { module, calls } = playwrightModule();
    const wrapped = withProcessSlot(module, "/nowhere#token") as unknown as ((title: string) => void) & {
      test: (title: string) => void;
      default: (title: string) => void;
      describe: string;
      expect: string;
    };
    wrapped.test("named import");
    wrapped.default("default import");
    wrapped("the module called");
    expect(calls).to.deep.equal([
      "original + fabrProcessSlot: named import",
      "original + fabrProcessSlot: default import",
      "original + fabrProcessSlot: the module called",
    ]);
    expect(wrapped.describe, "what test carries comes from the extended test").to.equal("original + fabrProcessSlot.describe");
    expect(wrapped.expect, "the module's other exports stay its own").to.equal("the module's expect");
  });
});

describe("takeProcessSlot", () => {
  it("resolves no slot where the socket cannot be reached, so the worker runs without one", async () => {
    expect(await takeProcessSlot(`${path.join(os.tmpdir(), "fabr-no-such-socket")}#token`)).to.equal(undefined);
  });
});
