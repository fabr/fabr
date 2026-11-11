---
title: AWS Secrets Manager
description: How to use secrets from AWS Secrets Manager as build inputs, kept out of the build cache and never published.
---

With the `@fabr-build/aws` plugin, a secret in AWS Secrets Manager is a build input like a file in
your project. fabr keeps it out of its build cache, stages it readable only by you, and refuses to
publish it.

```
plugin @fabr-build/aws;

generate encrypted {
  srcs = ./data.bin @aws:secretsmanager:prod/data-key -> data-key;
  run = @host:openssl enc -aes-256-cbc -pbkdf2 -pass file:data-key -in data.bin -out data.enc;
  output = data.enc;
}
```

`@aws` is the AWS account the requests are signed with; see [Accounts and
credentials](/reference/aws/accounts/) for choosing a profile, a region, or an endpoint such as
LocalStack or ministack.

## Coming from the AWS CLI

| With the AWS CLI | In fabr |
|---|---|
| `aws secretsmanager get-secret-value --secret-id prod/db/password` | A reference to the secret, `@aws:secretsmanager:prod/db/password`, as a build input; or `fabr cat @aws:secretsmanager:prod/db/password`. |
| `--version-id`, `--version-stage AWSPREVIOUS` | Not supported: fabr reads the secret's current version (`AWSCURRENT`). |
| `aws secretsmanager list-secrets` | Not supported: name each secret. |

## Naming secrets

A reference to Secrets Manager is the account, the service, then the secret's name:

```
@aws:secretsmanager:prod/db/password             # the file prod/db/password
@aws:secretsmanager:prod/db/password -> db.pw    # the file db.pw
@aws:secretsmanager:'region=eu'                  # a name with =, quoted
```

The secret is read as one file, named as the secret is (without a leading `/`, where it has one).
Write `-> name` to give it another name, as for any
[projection](/reference/syntax/#projection-and-renaming). A secret's name is written literally: a
pattern such as `@aws:secretsmanager:prod/*` is refused. Secrets Manager allows `=` in a name,
which means something else in a fabr name, so a name containing it is written in quotes.

The file holds the secret's current value: its text for a secret stored as text, or its bytes for a
binary secret. A secret stored as JSON key/value pairs is the whole JSON document; fabr doesn't pick
out a single key.

## How secrets are handled

Every value read from Secrets Manager is a secret, handled as a
[`SecureString` parameter](/reference/aws/ssm/#secrets) is:

- A step that takes it as an input finds it as a file readable only by your user (mode `0400`).
- It is never stored in the build cache. A step that reads it is cached keyed by the secret's ARN
  and version, so the step runs again when the secret is rotated or updated.
- What a step produces from it is ordinary content: if a step's output contains the secret, that
  output is stored in the build cache.
- A `sync` target refuses to publish it.
- Messages name it by its reference and never show its value.
- `fabr cat` prints it; `fabr cp` writes it readable and writable only by your user (mode `0600`).

## How secrets are cached

fabr keeps each secret it reads for a day, in a directory of its cache that only your user can read,
and reads it again after that. Secrets are kept per account, profile and region.

When Secrets Manager rotates a secret, the previous version normally stays valid until the next
rotation, so a value up to a day old still works unless the secret rotates more often than daily.
To read every secret again now, run with `--refresh`:

```sh
fabr build --refresh encrypted
```

If Secrets Manager can't be reached when a secret is read again, fabr uses the value it already
has, with a warning. A missing secret or a refused request is never answered from the cache.

In [watch mode](/guides/watch/), nothing tells fabr that a secret changed; restart with `--refresh`
to pick the change up.

## Permissions

The account's credentials need `secretsmanager:GetSecretValue` on each secret, and `kms:Decrypt` on
the key a secret is encrypted with where that is your own key rather than the account's default
(`aws/secretsmanager`). Replace the region, account ID and names with your own:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadSecrets",
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:eu-west-2:123456789012:secret:prod/*"
    },
    {
      "Sid": "DecryptWithOwnKey",
      "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "arn:aws:kms:eu-west-2:123456789012:key/<key-id>"
    }
  ]
}
```

## Troubleshooting

**`Secrets Manager has no secret 'prod/db/pasword' in @aws's account and region`**: no secret has
that name in the account's region. Check the name, and the account's `region`; see [Accounts and
credentials](/reference/aws/accounts/).

**`Secrets Manager refused to read 'prod/db/password' (AccessDeniedException: …)`**: the
credentials may not read the secret, or may not decrypt it; see [Permissions](#permissions).

**`'@aws:secretsmanager:prod/*' does not name a Secrets Manager secret`**: a secret is named
literally, without a pattern.

**`'data-key' is a secret (@aws:secretsmanager:prod/data-key), so it cannot be published (sync member '…')`**:
a `sync` target's content includes a secret. Remove it from the member's content.

**`'data-key' is a secret (@aws:secretsmanager:prod/data-key), so it cannot be stored in the build cache`**:
the secret was used somewhere fabr stores its inputs in the cache, such as a package's files or a
command's standard input (`< data-key`). Pass it to the command as a file argument instead.

## Not supported

- Reading a particular version or stage of a secret.
- Reading one key of a JSON secret.
- Listing secrets with `fabr ls`.
- Creating or updating secrets with `sync`.
