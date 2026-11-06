---
title: Amazon ECR
description: How to pull container images from an ECR registry and push images to it, signed in with an AWS account's own credentials.
---

An image in an Amazon ECR repository can be the base of a `container_image`, or read like any
image, and a `sync` target can push images to ECR. The registry is signed in to with your AWS
account's credentials, so there is no `docker login` step, and nothing for Docker to keep.

```
plugin @fabr-build/container;
plugin @fabr-build/aws;

aws_account @aws { account_id = 123456789012; region = eu-west-2; }

container_image app {
  base = @aws:ecr:base-images/node:22;
  files = ./dist:**;
}

sync release {
  @aws:ecr:my-app:1.4.2 = app;
}
```

```sh
fabr build app        # pulls the base image from ECR
fabr sync release     # pushes the image to ECR
```

ECR registries are read and written by the container plugin, so a project using ECR declares both
`@fabr-build/container` and `@fabr-build/aws`. `@aws` is the AWS account requests are signed in
with; see [Accounts and credentials](/reference/aws/accounts/).

## Coming from the AWS CLI and Docker

| With the AWS CLI and Docker | In fabr |
|---|---|
| `aws ecr get-login-password \| docker login …` | Nothing: fabr signs in with the account's credentials when it first needs to. |
| `123456789012.dkr.ecr.eu-west-2.amazonaws.com/my-app:1.4.2` | `@aws:ecr:my-app:1.4.2`, where `@aws`'s `account_id` and `region` are the account's. |
| Another account's registry (`111122223333.dkr.ecr…`) | `@aws:111122223333:ecr:my-app:1.4.2`; see [Another account's registry](#another-accounts-registry). |
| `docker push` | A `sync` entry, then `fabr sync`. |
| `docker pull` and reading a file of the image | `fabr cat @aws:ecr:my-app:1.4.2:etc/os-release`. |

## Naming images

A name in ECR is the repository, then a tag or a digest, then, where you want files of the image,
a path inside it:

```
@aws:ecr:my-app:1.4.2                         # the image the tag names
@aws:ecr:my-app:sha256:3f1c…                  # the image the digest names
@aws:ecr:base-images/node:22:etc/os-release   # a file of the image's filesystem
```

The image is chosen for the build's target platform, as for any registry the container plugin reads.

### The registry's address

ECR gives each account one registry in each region, so the same repository name in two accounts, or
in two regions of one account, is two repositories. fabr finds the account's registry from the
account's `account_id` and `region`:

- **With `account_id`** (recommended), the registry's address is known without asking AWS, so a
  build whose images are already cached needs no network at all.
- **Without it**, fabr asks ECR for the address when an image is first named, which needs the
  network and credentials even when the image is cached.

The registry is in the account's `region`, `us-east-1` where it isn't set. Set `region` to the
region your registry is in.

### Another account's registry

A shared account often holds base images that other accounts pull. Name the owning account's ID
after `@aws`:

```
container_image app {
  base = @aws:111122223333:ecr:base-images/node:22;
}
```

The request is still signed in with `@aws`'s credentials, so the owning account's repository policy
must allow your account to pull. The registry is in `@aws`'s `region`.

## Pushing images

A `sync` entry pushes a `container_image` to a repository and tag:

```
sync release {
  @aws:ecr:my-app:1.4.2 = app;
}
```

`fabr sync release` uploads the layers the repository lacks, then the manifest. An entry whose tag
already names the same manifest is reported as already synced. The ECR repository must exist
before you push to it, as with `docker push`: create it with `aws ecr create-repository`, or
let your account's settings create it on push.

## Signing in

fabr gets a sign-in token for the registry with the account's credentials the first time it needs
one, and gets a new one when it expires, so a long session in [watch mode](/guides/watch/) keeps
working. The token is sent only to the registry itself.

## Permissions

The account's credentials need permission to sign in, and to pull or push each repository the build
uses. Start from this policy, keep the statements for what your build does, and replace the region,
the account ID and the repository names with yours:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SignIn",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "Pull",
      "Effect": "Allow",
      "Action": ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
      "Resource": "arn:aws:ecr:eu-west-2:123456789012:repository/base-images/*"
    },
    {
      "Sid": "Push",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchGetImage",
        "ecr:BatchCheckLayerAvailability",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage"
      ],
      "Resource": "arn:aws:ecr:eu-west-2:123456789012:repository/my-app"
    }
  ]
}
```

What each statement is for:

- **`SignIn`**: every use of ECR. Signing in covers the account's whole registry, so this statement
  can't name a repository: its `Resource` is always `*`.
- **`Pull`**: pulling images, such as a `container_image`'s base, or reading an image's files with
  `fabr cat`. List the repositories you pull from; here, everything under `base-images/`.
- **`Push`**: pushing images with `sync`, here to `my-app`. It includes `ecr:BatchGetImage` because
  fabr first checks whether the tag already names the image.

When the image you push is built on one from another repository in the same registry, fabr shares
that image's layers instead of uploading them again. That uses the `Pull` permissions on the other
repository, which a build that pulled its base from there already has.

To pull from another account's registry, that registry's repository policy must also allow your
account to pull.

## Troubleshooting

**`'@aws:ecr' needs the repository type oci_repository, which no plugin in use defines`**: ECR's
registry is read by the container plugin. Add `plugin @fabr-build/container;`.

**`ECR refused a registry token (403: …)`**: the credentials can't sign in to ECR. They need
`ecr:GetAuthorizationToken`.

**`… has no image my-app:1.4.2`**: no image has that tag in the registry fabr reached. Check the
tag, and that `@aws`'s `region` (and `account_id`, or the owner's ID in the name) are the
registry's.

## Known issues

- Tested against the ministack emulator and stand-ins, not yet against AWS itself. Signing in to the
  registry and following a layer's redirect to S3 are tested only against stand-ins.
