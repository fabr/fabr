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

/**
 * Signing what a `maven_repository` publishes, as maven-gpg-plugin's `bc`
 * signer does: a detached, armored OpenPGP signature of each file, made with
 * the private key in `MAVEN_GPG_KEY`, else in `~/maven-signing-key.key`,
 * unlocked with the passphrase in `MAVEN_GPG_PASSPHRASE`.
 * The key is read only when something is signed, and held in memory alone.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as openpgp from "openpgp";
import { Computable, FabrError, TargetContext } from "@fabr-build/core";

/** The environment variable maven-gpg-plugin reads a signing key from. */
export const KEY_VARIABLE = "MAVEN_GPG_KEY";
/** The environment variable maven-gpg-plugin reads a signing key's passphrase from. */
export const PASSPHRASE_VARIABLE = "MAVEN_GPG_PASSPHRASE";

/** Makes the detached, armored OpenPGP signature of a file's bytes. */
export type Signer = (bytes: Buffer) => Computable<string>;

/** @return the absolute path of the key file maven-gpg-plugin reads by default, `~/maven-signing-key.key`. */
export function defaultKeyPath(): string {
  return path.join(os.homedir(), "maven-signing-key.key");
}

/** @return `promise` as a Computable. */
function fromPromise<T>(promise: () => Promise<T>): Computable<T> {
  return Computable.from<T>((resolve, reject) => {
    promise().then(resolve, reject);
  });
}

/**
 * Read the private key in `key` (armored, or as `gpg --export-secret-keys`
 * writes it), unlocked with `passphrase` where it is encrypted, and make the
 * signer that signs with it. `what` names where the key came from in errors.
 * Rejects where the key cannot be read, is encrypted and no passphrase is
 * given, or the passphrase does not unlock it.
 */
export function signerFor(key: Buffer, passphrase: string | undefined, what: string): Computable<Signer> {
  return fromPromise(async (): Promise<Signer> => {
    const text = key.toString("utf8").trim();
    let privateKey: openpgp.PrivateKey;
    try {
      privateKey = text.startsWith("-----BEGIN PGP")
        ? await openpgp.readPrivateKey({ armoredKey: text })
        : await openpgp.readPrivateKey({ binaryKey: new Uint8Array(key) });
    } catch (err) {
      throw new FabrError(`the signing key in ${what} could not be read: ${(err as Error).message}`).withHelp(
        "export it with `gpg --export-secret-keys --armor <key id>`"
      );
    }
    if (!privateKey.isDecrypted()) {
      if (passphrase === undefined) {
        throw new FabrError(`the signing key in ${what} is encrypted, and no passphrase is given`).withHelp(
          `give the passphrase in ${PASSPHRASE_VARIABLE}`
        );
      }
      try {
        privateKey = await openpgp.decryptKey({ privateKey, passphrase });
      } catch (err) {
        throw new FabrError(`the passphrase given does not unlock the signing key in ${what}: ${(err as Error).message}`);
      }
    }
    const signingKey = privateKey;
    return (bytes: Buffer) =>
      fromPromise(async () =>
        openpgp.sign({
          message: await openpgp.createMessage({ binary: new Uint8Array(bytes) }),
          signingKeys: signingKey,
          detached: true,
          format: "armored",
        })
      );
  });
}

/**
 * Make the signer a repository that signs what it publishes signs with: the
 * key in `MAVEN_GPG_KEY`, else in `~/maven-signing-key.key`, unlocked with the
 * passphrase in `MAVEN_GPG_PASSPHRASE`. Rejects where no key is found, or
 * {@link signerFor} rejects.
 */
export function loadSigner(context: TargetContext): Computable<Signer> {
  const passphrase = process.env[PASSPHRASE_VARIABLE] || undefined;
  const variable = process.env[KEY_VARIABLE];
  if (variable !== undefined && variable !== "") {
    return signerFor(Buffer.from(variable, "utf8"), passphrase, KEY_VARIABLE);
  }
  const file = defaultKeyPath();
  return context.execution.absFileSource
    .get(file)
    .then(found => found?.getBuffer())
    .then(bytes => {
      if (bytes === undefined) {
        throw new FabrError(`${context.name} signs what it publishes, and no signing key is given`).withHelp(
          `give the key in ${KEY_VARIABLE}, or in ${file}`
        );
      }
      return signerFor(bytes, passphrase, file);
    });
}
