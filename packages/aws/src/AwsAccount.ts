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
  Credential,
  FabrError,
  mapEntryError,
  NamespaceRef,
  onlyTo,
  Property,
  PropertyMap,
  Reference,
  RenewableToken,
  Repository,
  Namespace,
  sendRequest,
  TargetContext,
  RepositoryImplementation,
} from "@fabr-build/core";
import { CODEARTIFACT_SERVICE, codeArtifactToken, endpointUrl, formatCredential } from "./CodeArtifact";
import { ECR_SERVICE, EcrSignIn, registryUrl } from "./Ecr";
import { S3_SERVICE, S3Repository } from "./S3Repository";
import { SECRETS_MANAGER_SERVICE, SecretsManagerSecrets } from "./SecretsManager";
import { SSM_SERVICE, SsmParameters } from "./Ssm";
import { RequestSigner, requestUrl } from "./Signing";
import { identityRequest, parseCallerAccount, STS_SERVICE } from "./Sts";
import { DEFAULT_REGION, IAccountSettings } from "./Types";

/** The global naming the repository type each AWS service or CodeArtifact format is read and published as. */
const REPOSITORY_TYPES = "AWS_REPOSITORY_TYPES";

/**
 * An `aws_account` declaration, as the namespace of the account's
 * services, each a repository of its own (`s3`, `ecr`) or a namespace of them
 * (`codeartifact`), and of other accounts' resources, by their IDs
 * (`111122223333`), reached with this account's credentials. ECR's registry
 * and a CodeArtifact repository's endpoints are repositories of the types
 * {@link REPOSITORY_TYPES} names, which other plugins define: each made the
 * first time it is named, signed in with the account's credentials.
 */
export class AwsAccount extends Namespace {
  private readonly s3: S3Repository;
  private readonly ssm: SsmParameters;
  private readonly secretsManager: SecretsManagerSecrets;
  /** What signs in to every ECR registry the account reaches: one token serves each in its region. */
  private readonly ecrSignIn: EcrSignIn;
  /** Each ECR registry, by its owner's ID (empty for the account's own), once it is named. */
  private readonly registries = new Map<string, Computable<Repository>>();
  /** The CodeArtifact domains of each owner (empty for the account's own), once named. */
  private readonly codeArtifacts = new Map<string, CodeArtifactDomains>();
  /** Each other account's resources, by its ID, once it is named. */
  private readonly owners = new Map<string, OwnedResources>();
  /** The account's own ID, once it is asked for. */
  private ownId?: Computable<string>;

  constructor(private readonly settings: IAccountSettings) {
    super();
    this.s3 = new S3Repository(settings);
    this.ssm = new SsmParameters(settings);
    this.secretsManager = new SecretsManagerSecrets(settings);
    this.ecrSignIn = new EcrSignIn(settings);
  }

  /** The account's declared name (`@aws`). */
  public get name(): string {
    return this.settings.name;
  }

  /** The account's settings, for the services under it. */
  public get account(): IAccountSettings {
    return this.settings;
  }

  /**
   * Make the ECR registry `owner` owns, or the account's own where it is
   * undefined, the first time it is asked for: at the account's endpoint where
   * it has one, else where the owner's ID places it, else where ECR's token
   * says, which asks AWS.
   */
  public registry(owner?: string): Computable<Repository> {
    const key = owner ?? "";
    let made = this.registries.get(key);
    if (made === undefined) {
      const id = owner ?? this.settings.accountId;
      const known = this.settings.endpoint?.href ?? (id === undefined ? undefined : registryUrl(id, this.settings.region));
      const url = known === undefined ? this.ecrSignIn.current().then(token => token.proxyEndpoint) : Computable.resolve(known);
      made = this.makeMember(ECR_SERVICE, owner === undefined ? ECR_SERVICE : `${owner}:${ECR_SERVICE}`, url, this.ecrSignIn);
      this.registries.set(key, made);
    }
    return made;
  }

  /**
   * Get the account's own ID: its `account_id` where it declares one, else
   * the one STS's `GetCallerIdentity` says the credentials sign in to, asked
   * once.
   */
  public id(): Computable<string> {
    if (this.ownId === undefined) {
      const { accountId, signer, endpoint, name } = this.settings;
      if (accountId !== undefined) {
        this.ownId = Computable.resolve(accountId);
      } else {
        const request = identityRequest(this.settings.region, endpoint);
        const url = requestUrl(request);
        this.ownId = signer
          .sign(request, STS_SERVICE, this.settings.region)
          .then(headers => sendRequest(url, { method: "POST", headers, body: request.body }))
          .then(response => {
            if (response.statusCode !== 200) {
              throw new FabrError(
                `STS refused to say which account ${name}'s credentials sign in to (${response.statusCode})`
              ).withHelp(`declare the account's ID as \`account_id\` on ${name}`);
            }
            return parseCallerAccount(response.body.toString("utf8"), `the answer from ${url}`);
          });
      }
    }
    return this.ownId;
  }

  /** Get the CodeArtifact domains `owner` owns, or the account's own where it is undefined. */
  public codeArtifact(owner?: string): CodeArtifactDomains {
    const key = owner ?? "";
    let domains = this.codeArtifacts.get(key);
    if (domains === undefined) {
      domains = new CodeArtifactDomains(this, owner);
      this.codeArtifacts.set(key, domains);
    }
    return domains;
  }

  /**
   * Make the repository `kind` (an AWS service, or a CodeArtifact format) is
   * read and published as, named `member` under the account, at `url`, signed
   * in by `credential` on requests to `url`'s origin alone: of the type
   * {@link REPOSITORY_TYPES} names for `kind`. Refused where it names none, or
   * one no plugin in use defines.
   */
  public makeMember(kind: string, member: string, url: Computable<string>, credential: Credential): Computable<Repository> {
    const { context, name, repositoryTypes } = this.settings;
    const type = repositoryTypes.get(kind);
    if (type === undefined) {
      return Computable.reject(
        new FabrError(`${REPOSITORY_TYPES} names no repository type for ${kind}, which '${name}:${member}' is`).withHelp(
          `name the type that reads ${kind} repositories, as in '${REPOSITORY_TYPES} = { …; ${kind} = <type>; }'`
        )
      );
    }
    if (!context.hasRepositoryType(type)) {
      return Computable.reject(
        new FabrError(`'${name}:${member}' needs the repository type ${type}, which no plugin in use defines`).withHelp(
          `add the plugin that defines ${type}, or name another type for ${kind} in ${REPOSITORY_TYPES}`
        )
      );
    }
    return url.then(at => context.makeRepository(type, { name: member, url: at, credential: onlyTo(new URL(at).origin, credential) }));
  }

  /** Get another account's resources, by its ID. */
  private ownedBy(owner: string): OwnedResources {
    let resources = this.owners.get(owner);
    if (resources === undefined) {
      resources = new OwnedResources(this, owner);
      this.owners.set(owner, resources);
    }
    return resources;
  }

  /** Get the service `name` names, or another account's resources by its ID, each made the first time it is asked for. */
  public get(name: string): Computable<Repository | Namespace> {
    if (name === S3_SERVICE) {
      return Computable.resolve<Repository>(this.s3);
    }
    if (name === SSM_SERVICE) {
      return Computable.resolve<Repository>(this.ssm);
    }
    if (name === SECRETS_MANAGER_SERVICE) {
      return Computable.resolve<Repository>(this.secretsManager);
    }
    if (name === ECR_SERVICE) {
      return this.registry();
    }
    if (name === CODEARTIFACT_SERVICE) {
      return Computable.resolve<Namespace>(this.codeArtifact());
    }
    if (isAccountId(name)) {
      return Computable.resolve<Namespace>(this.ownedBy(name));
    }
    return Computable.reject(
      new FabrError(`${this.settings.name} has no service '${name}'`).withHelp(
        `name a service first, as in '${this.settings.name}:${S3_SERVICE}:<bucket>:<key>'; its services are ${SERVICES.join(", ")}, and another account's resources are named by its ID`
      )
    );
  }

  /** List the account's services, each named by a reference to the account written as the service: a service is made only when a name goes through it. */
  public children(ref: NamespaceRef): Computable<Map<string, Reference>> {
    return Computable.resolve(
      new Map(SERVICES.map((service): [string, Reference] => [service, new NamespaceRef(this, `${ref.name}:${service}`)]))
    );
  }
}

/** The services an account holds. */
const SERVICES = [S3_SERVICE, SSM_SERVICE, SECRETS_MANAGER_SERVICE, ECR_SERVICE, CODEARTIFACT_SERVICE];

/** @return true if `name` is an AWS account ID, otherwise false: 12 digits, which no service's name is. */
function isAccountId(name: string): boolean {
  return /^\d{12}$/.test(name);
}

/**
 * Another account's resources, reached with the account's credentials: a
 * namespace holding that account's ECR registry and CodeArtifact domains. S3's
 * bucket names are global, so it holds no S3 of its own.
 */
class OwnedResources extends Namespace {
  constructor(
    private readonly account: AwsAccount,
    /** The owning account's ID. */
    private readonly owner: string
  ) {
    super();
  }

  /** Get the service `name` names: the owner's ECR registry or CodeArtifact domains. */
  public get(name: string): Computable<Repository | Namespace> {
    if (name === ECR_SERVICE) {
      return this.account.registry(this.owner);
    }
    if (name === CODEARTIFACT_SERVICE) {
      return Computable.resolve<Namespace>(this.account.codeArtifact(this.owner));
    }
    const written = `${this.account.name}:${this.owner}`;
    return Computable.reject(
      new FabrError(`${written} has no service '${name}'`).withHelp(
        `another account's resources are reached through ${ECR_SERVICE} or ${CODEARTIFACT_SERVICE}, as in '${written}:${ECR_SERVICE}:<repository>:<tag>'; S3's buckets are named under ${this.account.name}:${S3_SERVICE}, whoever owns them`
      )
    );
  }

  /** List the services another account's resources are reached through, named as {@link AwsAccount.children} names them. */
  public children(ref: NamespaceRef): Computable<Map<string, Reference>> {
    return Computable.resolve(
      new Map<string, Reference>(
        [ECR_SERVICE, CODEARTIFACT_SERVICE].map((service): [string, Reference] => [
          service,
          new NamespaceRef(this, `${ref.name}:${service}`),
        ])
      )
    );
  }
}

/**
 * The CodeArtifact domains an owner owns: each a namespace of its
 * repositories, each of those a namespace of its endpoints by format
 * (`acme:shared:npm`), which is the repository the rest of a name goes to
 * (`lodash:4.17.21`), made the first time it is named. A domain's token serves
 * each of its repositories.
 */
class CodeArtifactDomains extends Namespace {
  /** Each repository's endpoint, by `domain:repository:format`, once named. */
  private readonly endpoints = new Map<string, Computable<Repository>>();
  /** Each domain's token, by domain. */
  private readonly tokens = new Map<string, RenewableToken<string>>();

  constructor(
    private readonly account: AwsAccount,
    /** The owner's ID, where it is not the account's own. */
    private readonly owner?: string
  ) {
    super();
  }

  /** Get the domain `domain`: a namespace of its repositories. */
  public get(domain: string): Computable<Namespace> {
    return Computable.resolve<Namespace>(
      new MemberNamespace(repository =>
        Computable.resolve<Namespace>(new MemberNamespace(format => this.endpoint(domain, repository, format)))
      )
    );
  }

  /** Get `repository`'s endpoint for `format` in `domain`, made the first time it is asked for. */
  private endpoint(domain: string, repository: string, format: string): Computable<Repository> {
    const key = `${domain}:${repository}:${format}`;
    let endpoint = this.endpoints.get(key);
    if (endpoint === undefined) {
      endpoint = this.makeEndpoint(domain, repository, format);
      this.endpoints.set(key, endpoint);
    }
    return endpoint;
  }

  /**
   * Make `repository`'s endpoint for `format` in `domain`, signed in with the
   * domain's token: in the owner's domain, or the account's own, whose ID is
   * asked of AWS where the account does not declare it.
   */
  private makeEndpoint(domain: string, repository: string, format: string): Computable<Repository> {
    const settings = this.account.account;
    const owner = this.owner === undefined ? this.account.id() : Computable.resolve(this.owner);
    const member = `${this.owner === undefined ? "" : `${this.owner}:`}${CODEARTIFACT_SERVICE}:${domain}:${repository}:${format}`;
    return owner.then(id => {
      let token = this.tokens.get(domain);
      if (token === undefined) {
        token = codeArtifactToken(settings, domain, id);
        this.tokens.set(domain, token);
      }
      const url = endpointUrl(domain, id, settings.region, format, repository, settings.endpoint);
      return this.account.makeMember(format, member, Computable.resolve(url), formatCredential(token, format));
    });
  }
}

/** Make the account an `aws_account` declaration declares. */
function createAccount(context: TargetContext): Computable<Namespace> {
  return Computable.forAll(
    [
      context.getProperty("profile"),
      context.getProperty("region"),
      context.getProperty("endpoint"),
      context.getProperty("account_id"),
      context.getGlobalMap(REPOSITORY_TYPES),
    ],
    (
      profile: Property | undefined,
      region: Property | undefined,
      endpoint: Property | undefined,
      accountId: Property | undefined,
      types: PropertyMap
    ) =>
      new AwsAccount({
        name: context.name,
        context,
        signer: new RequestSigner(profile?.toString()),
        credentials: credentialsOf(profile?.toString()),
        region: region?.toString() ?? DEFAULT_REGION,
        endpoint: endpoint === undefined ? undefined : endpointOf(endpoint.toString(), context.name),
        accountId: accountId === undefined ? undefined : accountIdOf(accountId.toString(), context.name),
        repositoryTypes: repositoryTypesOf(types),
      })
  );
}

/** Name the credentials an account with `profile` signs with, as the AWS CLI finds them: the access key's ID the environment gives, or the profile. */
function credentialsOf(profile: string | undefined): string {
  const key = process.env.AWS_ACCESS_KEY_ID;
  return key !== undefined && key !== "" ? `key:${key}` : `profile:${profile ?? process.env.AWS_PROFILE ?? "default"}`;
}

/** Read {@link REPOSITORY_TYPES}: each AWS service's or CodeArtifact format's repository type, one word. */
function repositoryTypesOf(map: PropertyMap): ReadonlyMap<string, string> {
  const types = new Map<string, string>();
  for (const [kind, value] of map) {
    if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== "string") {
      throw mapEntryError(map, kind, `${REPOSITORY_TYPES}'s ${kind} must name one repository type`);
    }
    types.set(kind, value[0]);
  }
  return types;
}

/** Read an account's `account_id`, refusing anything but 12 digits. */
function accountIdOf(text: string, account: string): string {
  if (!/^\d{12}$/.test(text)) {
    throw new FabrError(`${account}'s account_id '${text}' is not an AWS account ID`).withHelp(
      "an account ID is 12 digits, as in 123456789012"
    );
  }
  return text;
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

/** The implementation AWS.fabr's `repository` declaration names. */
export default { provider: createAccount } satisfies RepositoryImplementation;

/** A namespace whose members `member` gets. */
class MemberNamespace extends Namespace {
  constructor(private readonly member: (name: string) => Computable<Repository | Namespace>) {
    super();
  }

  public get(name: string): Computable<Repository | Namespace> {
    return this.member(name);
  }
}
