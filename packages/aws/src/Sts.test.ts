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
import { identityRequest, parseCallerAccount } from "./Sts";
import { requestUrl } from "./Signing";

describe("STS's GetCallerIdentity", () => {
  it("is asked of STS in the account's region, or at its endpoint", () => {
    expect(requestUrl(identityRequest("eu-west-2"))).to.equal("https://sts.eu-west-2.amazonaws.com/");
    expect(requestUrl(identityRequest("us-east-1", new URL("http://localhost:4566")))).to.equal("http://localhost:4566/");
  });

  it("gives the account's ID", () => {
    const answer =
      '<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult>' +
      "<Arn>arn:aws:iam::123456789012:user/ci</Arn><UserId>AIDA</UserId><Account>123456789012</Account>" +
      "</GetCallerIdentityResult></GetCallerIdentityResponse>";
    expect(parseCallerAccount(answer, "the answer")).to.equal("123456789012");
  });

  it("is refused where the answer gives no account ID", () => {
    expect(() => parseCallerAccount("<GetCallerIdentityResponse/>", "the answer")).to.throw("the answer gives no account ID");
    expect(() => parseCallerAccount("<x", "the answer")).to.throw("the answer");
  });
});
