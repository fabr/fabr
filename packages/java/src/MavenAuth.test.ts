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
import { MavenAuth, parseMavenSettings } from "./MavenAuth";

const SETTINGS = `<?xml version="1.0"?>
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">
  <servers>
    <server>
      <id>corp</id>
      <username>deploy</username>
      <password>\${env.FABR_TEST_MAVEN_PASSWORD}</password>
    </server>
    <server>
      <id>gitlab</id>
      <configuration>
        <httpHeaders>
          <property><name>Private-Token</name><value>abc123</value></property>
        </httpHeaders>
      </configuration>
    </server>
  </servers>
</settings>`;

describe("MavenAuth", () => {
  it("authenticates a repository with its server's username and password, from the environment where written so", () => {
    process.env.FABR_TEST_MAVEN_PASSWORD = "s3cret";
    try {
      const auth = new MavenAuth(parseMavenSettings(SETTINGS, "settings.xml"));
      expect(auth.headersFor("corp")).to.deep.equal({ authorization: `Basic ${Buffer.from("deploy:s3cret").toString("base64")}` });
    } finally {
      delete process.env.FABR_TEST_MAVEN_PASSWORD;
    }
  });

  it("sends a server's configured headers, and nothing for a repository with no server", () => {
    const auth = new MavenAuth(parseMavenSettings(SETTINGS, "settings.xml"));
    expect(auth.headersFor("gitlab")).to.deep.equal({ "Private-Token": "abc123" });
    expect(auth.headersFor("@mvn")).to.deep.equal({});
  });

  it("refuses a password encrypted with Maven's master password, and a document that is no settings", () => {
    const encrypted = "<settings><servers><server><id>corp</id><password>{COQLCE6DU6GtcS5P=}</password></server></servers></settings>";
    expect(() => parseMavenSettings(encrypted, "settings.xml")).to.throw(/encrypted with Maven's master password/);
    expect(() => parseMavenSettings("<project/>", "settings.xml")).to.throw(/is not Maven settings/);
  });
});
