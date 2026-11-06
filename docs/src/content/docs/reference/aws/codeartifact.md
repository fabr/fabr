---
title: AWS CodeArtifact
description: How to use npm and Maven packages from an AWS CodeArtifact repository, signed in with an AWS account's own credentials.
---

An AWS CodeArtifact repository can serve a project's npm and Maven dependencies, signed in with
your AWS account's credentials, so there is no `aws codeartifact login` step and no token to keep
in `.npmrc` or `settings.xml`.

```
plugin @fabr-build/js;
plugin @fabr-build/aws;

aws_account @aws { account_id = 123456789012; region = eu-west-2; }

js_package app {
  srcs = src:**/*.ts;
  deps = @aws:codeartifact:acme:shared:npm:lodash:4.17.21;
}
```

Usually a project names its CodeArtifact repository once, in place of the public registry:

```
@npm = @aws:codeartifact:acme:shared:npm;

js_package app {
  deps = @npm:lodash:4.17.21;
}
```

Declare the plugin for your packages (`@fabr-build/js` or `@fabr-build/java`) beside
`@fabr-build/aws`. `@aws` is your AWS account; see [Accounts and credentials](/reference/aws/accounts/).

## Coming from the AWS CLI

| With the AWS CLI | In fabr |
|---|---|
| `aws codeartifact login --tool npm --domain acme --repository shared` | Nothing: fabr signs in with the account's credentials when it first needs to. |
| The repository's npm endpoint as `registry` in `.npmrc` | `@aws:codeartifact:acme:shared:npm`, or `@npm` aliased to it. |
| The repository's Maven endpoint in `settings.xml` or `build.gradle` | `@aws:codeartifact:acme:shared:maven`. |
| `--domain-owner 111122223333` | `@aws:111122223333:codeartifact:acme:shared:npm`; see [A domain another account owns](#a-domain-another-account-owns). |

## Naming packages

A name in CodeArtifact is the domain, the repository, the package format, then what that format
names:

```
@aws:codeartifact:acme:shared:npm:lodash:4.17.21
@aws:codeartifact:acme:shared:maven:org.slf4j:slf4j-api:2.0.13
```

After the format, a name means what it does in that ecosystem's own registry: an npm package and
version, as after `@npm:`, or a Maven group, artifact and version, as after `@mvn:`. See
[JavaScript dependencies](/reference/js/dependencies/) and [Java
dependencies](/reference/java/dependencies/).

fabr reads the `npm` and `maven` formats. CodeArtifact also serves PyPI, NuGet, Cargo, Ruby, Swift
and generic packages, which fabr can't read yet; see
[Repository types](/reference/aws/accounts/#repository-types).

### The domain's owner

A domain's address includes the ID of the account that owns it. Set `account_id` on the account
so fabr knows yours. Without it, fabr asks AWS the first time you use a domain, so a build needs the
network even when its packages are already cached.

### A domain another account owns

Domains are often owned by a shared account and used from others. Name the owning account's ID after
`@aws`:

```
@npm = @aws:111122223333:codeartifact:acme:shared:npm;
```

The requests are still signed in with `@aws`'s credentials, so the domain's policy must allow your
account. The domain is in `@aws`'s `region`.

## Signing in

fabr gets a sign-in token for the domain with the account's credentials the first time it needs
one, and gets a new one when it expires, so long sessions keep working. The token is sent only to
the repository itself.

## Permissions

The account's credentials need permission to sign in to the domain, and to read from or publish to
each repository the build uses. Start from this policy, keep the statements for what your build
does, and replace the region, the domain owner's account ID, the domain (`acme`) and the repository
(`shared`) with yours:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SignIn",
      "Effect": "Allow",
      "Action": "codeartifact:GetAuthorizationToken",
      "Resource": "arn:aws:codeartifact:eu-west-2:123456789012:domain/acme"
    },
    {
      "Sid": "SignInToken",
      "Effect": "Allow",
      "Action": "sts:GetServiceBearerToken",
      "Resource": "*",
      "Condition": { "StringEquals": { "sts:AWSServiceName": "codeartifact.amazonaws.com" } }
    },
    {
      "Sid": "Read",
      "Effect": "Allow",
      "Action": "codeartifact:ReadFromRepository",
      "Resource": "arn:aws:codeartifact:eu-west-2:123456789012:repository/acme/shared"
    },
    {
      "Sid": "Publish",
      "Effect": "Allow",
      "Action": ["codeartifact:PublishPackageVersion", "codeartifact:PutPackageMetadata"],
      "Resource": "arn:aws:codeartifact:eu-west-2:123456789012:package/acme/shared/*"
    }
  ]
}
```

What each statement is for:

- **`SignIn`** and **`SignInToken`**: every use of the domain. CodeArtifact makes the sign-in token
  through AWS STS, acting as you, so your credentials need both. The condition limits
  `SignInToken` to CodeArtifact's tokens; STS has no resource to name, so its `Resource` is `*`.
- **`Read`**: reading packages from the repository, including those it fetches from the public
  registry for you.
- **`Publish`**: publishing packages with `sync`. Maven needs `codeartifact:PutPackageMetadata` to
  finish publishing a version; npm doesn't use it.

A build that only reads needs the first three. To use a domain another account owns, that
account's domain and repository policies must also allow yours.

## Troubleshooting

**`STS refused to say which account @aws's credentials sign in to (403)`**: fabr couldn't find out
your account's ID. Set `account_id` on the account.

**`AWS_REPOSITORY_TYPES names no repository type for pypi, which '@aws:codeartifact:acme:shared:pypi' is`**:
fabr has no repository type for that format. See [Repository types](/reference/aws/accounts/#repository-types).

**`'@aws:codeartifact:acme:shared' names a namespace, not a package or files`**: the name stops
short of a package. Give the domain, the repository and the format, then the package, as in
`@aws:codeartifact:acme:shared:npm:lodash:4.17.21`.

**`CodeArtifact refused a token for the domain acme (403)`**: the credentials can't sign in to the
domain. They need `codeartifact:GetAuthorizationToken` and `sts:GetServiceBearerToken`, and the
domain's policy must allow them.

## Known issues

- Tested only against stand-ins, not yet against AWS itself: no local emulator serves CodeArtifact.
  Publishing to CodeArtifact is untested.
