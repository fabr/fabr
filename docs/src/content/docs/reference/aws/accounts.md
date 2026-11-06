---
title: Accounts and credentials
description: How a fabr project names an AWS account, finds its credentials, reaches another account's resources, and points it at an S3-compatible store.
---

The `@fabr-build/aws` plugin lets a build read from and publish to AWS services. Everything it
does goes through an **AWS account**, a declaration that says whose credentials requests are
signed with and where they are sent. Every name that reaches AWS starts with the account and then
the service: `@aws:s3:acme-models:v3/model.bin` is an object in the S3 bucket `acme-models`, read
with the `@aws` account's credentials.

The plugin is installed with fabr. A project uses it by declaring it:

```
plugin @fabr-build/aws;
```

That alone gives you `@aws`, an account whose credentials are found the way the AWS CLI finds
them. The plugin supports three services:

| Service | Named as | Read and written by |
|---|---|---|
| [Amazon S3](/reference/aws/s3/) | `@aws:s3:<bucket>:<key>` | the AWS plugin |
| [Amazon ECR](/reference/aws/ecr/) | `@aws:ecr:<repository>:<tag>` | the container plugin |
| [AWS CodeArtifact](/reference/aws/codeartifact/) | `@aws:codeartifact:<domain>:<repository>:<format>:…` | the plugin for the format's packages |

`fabr ls @aws` lists them. ECR's registry and CodeArtifact's endpoints are ordinary repositories of
the container, JavaScript and Java plugins, made and signed in by the account: see [Repository
types](#repository-types).

Each service's page lists the permissions the account's credentials need for it, and gives them as
an IAM policy to start from: [S3](/reference/aws/s3/#permissions),
[ECR](/reference/aws/ecr/#permissions), [CodeArtifact](/reference/aws/codeartifact/#permissions).

## Coming from the AWS CLI or SDKs

| With the AWS CLI or an SDK | In fabr |
|---|---|
| `AWS_PROFILE=build aws …` | `aws_account @aws { profile = build; }`, or `AWS_PROFILE` in the environment. |
| `--endpoint-url http://localhost:4566` | `aws_account @aws { endpoint = http://localhost:4566; }`. |
| Two profiles in one script | Two `aws_account` declarations, each named in its own references. |
| `aws s3 cp s3://bucket/key .` | A reference to the object, `@aws:s3:bucket:key`; see [Amazon S3](/reference/aws/s3/). |
| `--region` | The account's `region`, for regional services. S3 finds each bucket's region for itself. |
| `docker login` to ECR, `aws codeartifact login` | Nothing: the account signs in to ECR and CodeArtifact when it first needs to. |

## Declaring an account

fabr declares `@aws` for you, with no properties. Declare it yourself to change how it signs in:

```
aws_account @aws {
  profile = build;
}
```

Your declaration replaces fabr's. A project that reads from one account and deploys to another
declares both, and each reference names the one it means:

```
aws_account @aws  { profile = build; }
aws_account @prod { profile = prod-deploy; }

generate site_config {
  srcs = @aws:s3:acme-config:site.json;
  …
}

sync release {
  @prod:s3:acme-site:v3/ = site;
}
```

An `aws_account` is an AWS account as one role and region, so two declarations can be the same AWS
account signed in as two different roles.

| Property | What it is |
|---|---|
| `profile` | The profile in `~/.aws/config` whose credentials are used. By default, `AWS_PROFILE`, else `default`. |
| `region` | The region of the account's regional services, `us-east-1` where it isn't set. S3 finds each bucket's region for itself, so an S3-only project rarely needs it. |
| `endpoint` | A URL every request goes to in place of AWS's own endpoints: an S3-compatible store such as LocalStack, ministack or MinIO. |
| `account_id` | The account's 12-digit ID. Optional: where it is set, the account's ECR registry and CodeArtifact endpoints are found without asking AWS, so a build whose images or packages are already cached needs no network. |

## Another account's resources

ECR registries and CodeArtifact domains belong to one account each, and are often shared from one
account to others. Name the owning account's ID after the account to reach its resources, signed in
with your own account's credentials:

```
@aws:111122223333:ecr:base-images/node:22
@aws:111122223333:codeartifact:acme:shared:npm:lodash:4.17.21
```

The owner's resources are in your account's `region`. S3 bucket names are the same in every
account, so a bucket another account owns is named as any other, `@aws:s3:<bucket>:<key>`.

## Repository types

ECR's registry and CodeArtifact's npm and Maven endpoints are repositories of other plugins' types,
which the account makes when they are first named. Which type each is comes from the global map
`AWS_REPOSITORY_TYPES`, keyed by AWS's name for the service or CodeArtifact format:

```
default AWS_REPOSITORY_TYPES = {
    ecr = oci_repository;
    npm = npm_repository;
    maven = maven_repository;
}
```

The plugin that defines a type must be in use: `@aws:ecr` needs `plugin @fabr-build/container;`,
and a CodeArtifact npm repository `plugin @fabr-build/js;`. To read a format fabr has no entry for,
declare the map yourself with an entry naming a repository type a plugin of yours defines:

```
AWS_REPOSITORY_TYPES = {
    ecr = oci_repository;
    npm = npm_repository;
    maven = maven_repository;
    pypi = pypi_repository;
}
```

Your declaration replaces fabr's, so it lists every entry you use. The account gives a repository it
makes the address and the sign-in; everything else about the repository is its type's.

## Credentials

fabr uses the AWS SDK's own credential chain, so it finds credentials wherever the AWS CLI and SDKs
would, trying each source in this order:

1. **Environment variables:** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and, for temporary
   credentials, `AWS_SESSION_TOKEN`. These are skipped when a profile is chosen, by the account's
   `profile` or by `AWS_PROFILE`, and the SDK prints a warning when both are set.
2. **The profile** in `~/.aws/config` and `~/.aws/credentials`: static keys, an IAM Identity
   Center (SSO) session, a role assumed from another profile (`role_arn` with `source_profile`), or
   a `credential_process`.
3. **A web identity token:** `AWS_WEB_IDENTITY_TOKEN_FILE` with `AWS_ROLE_ARN`, which is how CI
   systems that sign in to AWS over OpenID Connect pass credentials, and how EKS pods get them.
4. **The machine's role:** an ECS task's role, or an EC2 instance's.

Credentials are read when the account first signs a request, and reused after that. They are never
part of what fabr caches: an object fetched with one profile is the same object to every other.

For an SSO profile, sign in first, as you would before using the AWS CLI:

```sh
aws sso login --profile build
```

## S3-compatible stores

Set `endpoint` to send every request to another store instead of AWS:

```
aws_account @aws {
  endpoint = http://localhost:4566;
}
```

Buckets are then addressed by path (`http://localhost:4566/<bucket>/<key>`), which every
S3-compatible store accepts, and requests are signed for the account's `region`, `us-east-1` where
it isn't set. The store still needs credentials, which come from the chain above as for AWS; a
local test store usually accepts any, such as `AWS_ACCESS_KEY_ID=test` and
`AWS_SECRET_ACCESS_KEY=test`.

fabr reads the endpoint only from the declaration, never from `AWS_ENDPOINT_URL`, because where
content comes from is part of what fabr caches it under. To point the same project at a local store
only when you ask, [guard](/reference/syntax/#guarded-properties) the endpoint on a property of
your own and set it with `-D`:

```
LOCAL_STORE = off;

aws_account @aws {
  endpoint<LOCAL_STORE=on> = http://localhost:4566;
}
```

```sh
fabr build -DLOCAL_STORE=on site   # read from the local store
fabr build site                    # read from AWS
```

## Troubleshooting

**`cannot sign a request to s3 (Could not load credentials from any providers)`**: none of the
sources above gave credentials. A profile that doesn't exist gives the same message, so check the
name in `profile` or `AWS_PROFILE` against `~/.aws/config` (`[profile build]`) and
`~/.aws/credentials` (`[build]`). Otherwise sign in (`aws sso login --profile <profile>`) or set
the access-key variables.

**`@aws has no service 'ec2'`**: a name under an account starts with the service: `s3`, `ecr` or
`codeartifact`, or another account's ID.

**`'@aws:ecr' needs the repository type oci_repository, which no plugin in use defines`**: add the
plugin that defines the type, here `plugin @fabr-build/container;`. See [Repository
types](#repository-types).
