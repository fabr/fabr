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
import { Computable } from "../core/Computable";
import { provenanceStatement } from "./Slsa";

describe("provenanceStatement", () => {
  it("states that the build built the subject", () => {
    const build = {
      statementType: "https://in-toto.io/Statement/v1",
      predicateType: "https://slsa.dev/provenance/v1",
      predicate: { buildDefinition: { buildType: "example" } },
      sourceRepository: "https://example.com/acme/widgets",
      isPublicSource: () => Computable.resolve(true),
    };
    expect(provenanceStatement({ name: "pkg:npm/widgets@1.0.0", digest: { sha512: "ab12" } }, build)).to.deep.equal({
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: "pkg:npm/widgets@1.0.0", digest: { sha512: "ab12" } }],
      predicateType: "https://slsa.dev/provenance/v1",
      predicate: { buildDefinition: { buildType: "example" } },
    });
  });
});
