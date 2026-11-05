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

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { expect } from "chai";
import { Semaphore } from "@fabr-build/core";
import { parseAuthFile, RegistryAuth } from "./RegistryAuth";

const basic = (user: string, password: string): string => Buffer.from(`${user}:${password}`).toString("base64");

describe("parseAuthFile", () => {
  it("reads credentials by host, the helper holding a host's, and the store holding the rest", () => {
    const file = parseAuthFile(
      JSON.stringify({
        auths: { "https://index.docker.io/v1/": { auth: basic("me", "pw") }, "ghcr.io": {} },
        credHelpers: { "123.dkr.ecr.us-east-1.amazonaws.com": "ecr-login" },
        credsStore: "desktop",
      }),
      "config.json"
    );
    expect([...file.credentials]).to.deep.equal([["index.docker.io", { username: "me", password: "pw" }]]);
    expect([...file.helpers]).to.deep.equal([["123.dkr.ecr.us-east-1.amazonaws.com", "ecr-login"]]);
    expect(file.store).to.equal("desktop");
  });
});

describe("RegistryAuth", () => {
  let dir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-registry-auth-"));
    /* A helper holding one credential, for Docker Hub's key, and saying it holds none for anything else. */
    fs.writeFileSync(
      path.join(dir, "docker-credential-fake"),
      `#!${process.execPath}\n` +
        "let input = ''; process.stdin.on('data', d => (input += d)); process.stdin.on('end', () => {\n" +
        "  if (process.argv[2] === 'get' && input === 'https://index.docker.io/v1/') { process.stdout.write(JSON.stringify({ ServerURL: input, Username: 'hub', Secret: 'tok' })); }\n" +
        "  else { process.stdout.write('credentials not found in native keychain'); process.exit(1); }\n" +
        "});\n",
      { mode: 0o755 }
    );
    savedPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("asks the store for a registry no file names, by the server it is filed under", async () => {
    const auth = new RegistryAuth([parseAuthFile(JSON.stringify({ credsStore: "fake" }), "config.json")], new Semaphore(1));
    expect(await Promise.resolve(auth.credentialFor("https://index.docker.io/v1/"))).to.deep.equal({ username: "hub", password: "tok" });
    expect(await Promise.resolve(auth.credentialFor("ghcr.io"))).to.equal(undefined);
  });

  it("takes a credential written in the first file that names its host over any helper", async () => {
    const auth = new RegistryAuth(
      [
        parseAuthFile(JSON.stringify({ auths: { "ghcr.io": { auth: basic("me", "pw") } } }), "auth.json"),
        parseAuthFile(JSON.stringify({ credHelpers: { "ghcr.io": "fake" } }), "config.json"),
      ],
      new Semaphore(1)
    );
    expect(await Promise.resolve(auth.credentialFor("ghcr.io"))).to.deep.equal({ username: "me", password: "pw" });
  });

  it("names a helper that is not on PATH", async () => {
    const auth = new RegistryAuth([parseAuthFile(JSON.stringify({ credsStore: "absent" }), "config.json")], new Semaphore(1));
    const failure = await Promise.resolve(auth.credentialFor("ghcr.io")).catch((err: Error) => err);
    expect((failure as Error).message).to.match(/'docker-credential-absent', which is not on PATH/);
  });
});
