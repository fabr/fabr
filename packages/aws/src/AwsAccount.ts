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

import {
  Computable,
  FabrError,
  Name,
  NamespaceRef,
  Property,
  Reference,
  Repository,
  RepositoryPublishRef,
  RepositoryRef,
  RepositoryRegistration,
  TargetContext,
} from "@fabr-build/core";
import { IAccountSettings, S3_SERVICE, S3Repository } from "./S3Repository";
import { RequestSigner } from "./Signing";

/**
 * The repository an `aws_account` declaration is: a namespace of the
 * account's services, each a repository of its own. A name in it begins with
 * the service (`s3:acme:v3/model.bin`), and the service answers for the whole
 * name; the account itself is read from and published to only through one.
 */
export class AwsAccount implements Repository {
  private readonly services: ReadonlyMap<string, Repository>;

  constructor(private readonly settings: IAccountSettings) {
    this.services = new Map([[S3_SERVICE, new S3Repository(settings)]]);
  }

  public getRepositoryRef(name: Name): RepositoryRef | NamespaceRef {
    return this.serviceOf(name).getRepositoryRef(name);
  }

  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    return this.serviceOf(name).getRepositoryPublishRef(name);
  }

  /** List the account's services. */
  public children(): Computable<Map<string, Reference>> {
    return Computable.resolve(new Map([...this.services].map(([name, service]): [string, Reference] => [name, new NamespaceRef(service, name)])));
  }

  /** Look up the service `name` begins with. Throws, naming the services there are, where it is none of them. */
  private serviceOf(name: Name): Repository {
    const literal = name.getLiteralPrefix();
    const end = literal.search(/[:/]/);
    const service = this.services.get(end === -1 ? literal : literal.substring(0, end));
    if (service === undefined || (end === -1 && !name.isSimpleName())) {
      throw new FabrError(`${this.settings.name} has no service '${name.toString()}'`).withHelp(
        `name a service first, as in '${this.settings.name}:${S3_SERVICE}:<bucket>:<key>'; its services are ${[...this.services.keys()].join(", ")}`
      );
    }
    return service;
  }
}

/** Make the account an `aws_account` declaration declares. */
function createAccount(context: TargetContext): Computable<Repository> {
  return Computable.forAll(
    [context.getProperty("profile"), context.getProperty("region"), context.getProperty("endpoint")],
    (profile: Property | undefined, region: Property | undefined, endpoint: Property | undefined) =>
      new AwsAccount({
        name: context.name,
        context,
        signer: new RequestSigner(profile?.toString()),
        region: region?.toString(),
        endpoint: endpoint === undefined ? undefined : endpointOf(endpoint.toString(), context.name),
      })
  );
}

/** Read an account's `endpoint`, refusing anything but an HTTP(S) URL. */
function endpointOf(text: string, account: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new FabrError(`${account}'s endpoint '${text}' is not a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new FabrError(`${account}'s endpoint '${text}' is not an HTTP or HTTPS URL`);
  }
  return url;
}

export const awsAccountRegistration: RepositoryRegistration = { type: "aws_account", provider: createAccount };

/** The implementation AWS.fabr's `repository` declaration names. */
export default createAccount;
