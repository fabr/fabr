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
import { assetStubFor } from "./Assets";

/** The stub as a property bag, which is how the code under test reads it. */
function stub(request: string): Record<string, unknown> {
  return assetStubFor(request) as Record<string, unknown>;
}

describe("assetStubFor", () => {
  it("leaves ordinary JavaScript alone", () => {
    for (const request of ["./Card", "./Card.js", "react", "@scope/pkg", "./data.json"]) {
      expect(assetStubFor(request), request).to.equal(undefined);
    }
  });

  it("gives a stylesheet an identity map, whatever the dialect", () => {
    for (const request of ["./a.css", "./a.scss", "./a.sass", "./a.less", "./a.styl", "./a.module.scss"]) {
      expect(stub(request).cardTitle, request).to.equal("cardTitle");
    }
  });

  it("survives the compiled default-import interop", () => {
    /* `import styles from "./a.scss"` compiles to
     * `__importDefault(require(…)).default`, and the helper branches on
     * `__esModule` — a map answering every property with its own name would be
     * taken for an ES module and hand back the string "default". */
    const module = stub("./a.scss");
    expect(module.__esModule).to.equal(true);
    const styles = module.default as Record<string, unknown>;
    expect(styles.cardTitle).to.equal("cardTitle");
  });

  it("does not throw on coercion", () => {
    /* A template literal looks up toString/valueOf and needs functions there;
     * answering with their own names is "Cannot convert object to primitive". */
    const styles = stub("./a.scss");
    expect(() => `${styles}`).to.not.throw();
    expect(() => String(styles)).to.not.throw();
  });

  it("answers the runtime's symbol probing with undefined, not a string", () => {
    const styles = stub("./a.scss") as unknown as Record<symbol, unknown>;
    expect(styles[Symbol.iterator]).to.equal(undefined);
    expect(styles[Symbol.toPrimitive]).to.equal(undefined);
  });

  it("stubs a binary as its filename", () => {
    expect(assetStubFor("./assets/logo.png")).to.equal("logo.png");
    expect(assetStubFor("../fonts/Inter.woff2")).to.equal("Inter.woff2");
    expect(assetStubFor("icon.svg")).to.equal("icon.svg");
  });

  it("judges the request, not a resolved path", () => {
    /* A stylesheet outside the target's srcs does not resolve at all, and must
     * still be stubbed rather than becoming "cannot find module". */
    expect(stub("./nowhere/missing.scss").x).to.equal("x");
  });
});
