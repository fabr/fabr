---
title: SSM Parameter Store
description: How to use parameters from AWS Systems Manager Parameter Store as build inputs, with SecureString parameters kept out of the build cache.
---

With the `@fabr-build/aws` plugin, a parameter in AWS Systems Manager Parameter Store is a build
input like a file in your project. A `SecureString` parameter is treated as a secret: fabr keeps
it out of its build cache, stages it readable only by you, and refuses to publish it.

```
plugin @fabr-build/aws;

generate certificates {
  srcs = ./site.csr @aws:ssm:/app/ssl/ca.key -> ca.key @aws:ssm:/app/ssl/ca.crt -> ca.crt;
  run = @host:openssl x509 -req -in site.csr -CA ca.crt -CAkey ca.key -days 365 -out site.crt;
  output = site.crt;
}
```

```sh
fabr build certificates    # reads the two parameters, then runs openssl
```

`@aws` is the AWS account the requests are signed with; see [Accounts and
credentials](/reference/aws/accounts/) for choosing a profile, a region, or an endpoint such as
LocalStack or ministack.

## Coming from the AWS CLI

| With the AWS CLI | In fabr |
|---|---|
| `aws ssm get-parameter --name /app/region` | A reference to the parameter, `@aws:ssm:/app/region`, as a build input; or `fabr cat @aws:ssm:/app/region`. |
| `aws ssm get-parameter --name /app/db/password --with-decryption` | The same reference: fabr always decrypts a `SecureString`. |
| `aws ssm get-parameter --name /app/region:3` | Not supported: fabr reads the parameter's latest version. |
| `aws ssm get-parameters-by-path --path /app/` | Not supported: name each parameter. |

## Naming parameters

A reference to SSM is the account, the service, then the parameter's name as SSM writes it:

```
@aws:ssm:/app/ssl/ca.key               # the file app/ssl/ca.key
@aws:ssm:/app/ssl/ca.key -> ca.key     # the file ca.key
@aws:ssm:legacy-token                  # the file legacy-token
```

The parameter is read as one file, named as the parameter is without its leading `/`. Write
`-> name` to give it another name, as for any [projection](/reference/syntax/#projection-and-renaming).
A parameter's name is written literally: a pattern such as `@aws:ssm:/app/*` is refused.

The file holds the parameter's value as SSM stores it. A `StringList` is its comma-separated text.

## Secrets

A `SecureString` parameter is a secret. A `String` or `StringList` parameter is ordinary content,
handled like any other file.

What fabr does with a secret:

- **Staging.** A step that takes the secret as an input finds it as a file readable only by your
  user (mode `0400`) in its working directory. It is written there from memory, never linked from
  the cache.
- **Caching.** The secret itself is never stored in the build cache. A step that reads it is
  cached as usual, keyed by the parameter's ARN and version rather than its value, so the step runs
  again when the parameter gets a new version.
- **Step outputs.** What a step produces from a secret is ordinary content, cached and publishable
  like any other output. If a step's output contains the secret (a tool that copies it into a
  config file, for example), that output is stored in the build cache.
- **Publishing.** A `sync` target refuses to publish a secret.
- **Messages.** Progress lines, errors and provenance name a secret by its reference
  (`@aws:ssm:/app/ssl/ca.key`) and never show its value.
- **Reading it yourself.** `fabr cat @aws:ssm:/app/db/password` prints the value, as
  `aws ssm get-parameter --with-decryption` does. `fabr cp` writes it readable and writable only by
  your user (mode `0600`).

## How parameters are cached

SSM returns a parameter's value and version together, so fabr keeps each parameter it reads for a
day and reads it again after that. Parameters are kept in a directory of fabr's cache that only
your user can read, apart from the build cache, and are deleted once they are a day old. They are
kept per account, profile and region, so two profiles that read the same name don't share a value.

To pick up a new version sooner, run with `--refresh`, which reads every parameter the run uses
again, however recently fabr last read it:

```sh
fabr build --refresh certificates
```

If SSM can't be reached when a parameter is read again, fabr uses the value it already has, with
a warning:

```
warn:cannot refresh ssm:/app/ssl/ca.key (…); serving the cached copy
```

A missing parameter or a refused request is never answered from the cache.

In [watch mode](/guides/watch/), nothing tells fabr that a parameter changed; restart with
`--refresh` to pick the change up.

## Permissions

The account's credentials need `ssm:GetParameter` on each parameter, and `kms:Decrypt` on the key a
`SecureString` is encrypted with. Replace the region, account ID and path with your own:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadParameters",
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:eu-west-2:123456789012:parameter/app/*"
    },
    {
      "Sid": "DecryptSecureStrings",
      "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "arn:aws:kms:eu-west-2:123456789012:key/<key-id>"
    }
  ]
}
```

## Troubleshooting

**`SSM has no parameter '/app/ssl/ca.kye' in @aws's account and region`**: no parameter has that
name in the account's region. Check the name, and the account's `region`; see [Accounts and
credentials](/reference/aws/accounts/).

**`SSM refused to read '/app/db/password' (AccessDeniedException: …)`**: the credentials may not
read the parameter, or may not decrypt it; see [Permissions](#permissions).

**`'@aws:ssm:/app/*' does not name an SSM parameter`**: a parameter is named literally, without a
pattern.

**`'ca.key' is a secret (@aws:ssm:/app/ssl/ca.key), so it cannot be published (sync member '…')`**:
a `sync` target's content includes a secret. Remove it from the member's content.

**`'ca.key' is a secret (@aws:ssm:/app/ssl/ca.key), so it cannot be stored in the build cache`**:
the secret was used somewhere fabr stores its inputs in the cache, such as a package's files or a
command's standard input (`< ca.key`). Pass it to the command as a file argument instead.

## Not supported

- Reading a particular version or label of a parameter (`/app/key:3`, `/app/key:prod`).
- Reading every parameter under a path, and listing parameters with `fabr ls`.
- Publishing parameters with `sync`.
