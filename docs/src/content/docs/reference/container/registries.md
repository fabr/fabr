---
title: Registries
description: How to name images in Docker Hub and other OCI registries, how fabr signs in to them, and how a sync target pushes images.
---

The container plugin reads images from any registry that speaks the [OCI distribution
API](https://github.com/opencontainers/distribution-spec): Docker Hub, GitHub Container Registry,
a self-hosted registry, or [Amazon ECR](/reference/aws/ecr/). An image named there can be the base
of a [`container_image`](/reference/container/images/), be [run](/reference/container/running/),
or be read file by file, and a `sync` target pushes your images to one.

```
plugin @fabr-build/container;

oci_repository @ghcr { url = https://ghcr.io; }

container_image app {
  base = @docker:node:22-alpine;
  files = ./dist:** -> app/**;
}

sync release {
  @ghcr:acme/app:1.4.2 = app;
}
```

```sh
fabr build app        # pulls node:22-alpine from Docker Hub
fabr sync release     # pushes the image to ghcr.io/acme/app:1.4.2
```

Docker Hub is declared for you as `@docker`; declare any other registry with an
[`oci_repository`](#declaring-a-registry).

## Coming from Docker

| With Docker | In fabr |
|---|---|
| `node:22-alpine` | `@docker:node:22-alpine` |
| `ghcr.io/acme/app:1.4.2` | `@ghcr:acme/app:1.4.2`, with `@ghcr` declared as an `oci_repository`. |
| `node@sha256:…` | `@docker:node:sha256:…`; see [Naming images](#naming-images). |
| `docker pull` | Nothing: fabr pulls an image when a build first needs it, and keeps it in its cache. |
| `docker pull --platform linux/amd64` | `-DOCI_TARGET=x86_64-unknown-linux`; see [The image's platform](/reference/container/images/#the-images-platform). |
| `docker login ghcr.io` | The same: fabr reads the credentials Docker and podman store; see [Signing in](#signing-in). |
| `docker tag` and `docker push` | A `sync` entry, then `fabr sync`; see [Pushing images](#pushing-images). |
| A registry mirror in `daemon.json` | Declare `@docker` with the mirror's URL; see [Declaring a registry](#declaring-a-registry). |

## Naming images

A name in a registry is the image's repository, then a tag or a digest, then, where you want files
of the image, a path inside it:

```
@docker:node:22-alpine                      # the image the tag names
@docker:node:sha256:3f1c…                   # the image the digest names
@docker:bitnami/redis:7.4                   # a repository with a namespace
@docker:node:22-alpine:etc/os-release       # a file of the image's filesystem
@docker:node:22-alpine:usr/local/bin/*      # the files a pattern selects
```

On Docker Hub, a repository named with one segment is in `library`, so `@docker:node` is
`library/node`, as `docker pull node` is. A digest is `sha256:` and 64 lowercase hex digits; any
other version is a tag.

Where the tag or digest names a multi-platform image, fabr picks the image for the [build's
platform](/reference/container/images/#the-images-platform). A digest of one platform's image must
be for that platform.

Read an image's files with `fabr ls` and `fabr cat`:

```sh
fabr cat @docker:debian:12-slim:etc/debian_version
fabr ls '@docker:node:22-alpine:usr/local/bin/*'
```

### Tags and digests

A tag can be moved to another image at any time, so fabr checks what a tag names again once its
answer is a day old, with a request that fetches nothing when the tag still names the same image.
A build that uses the image rebuilds only if the tag now names a different one. To check every tag
the run uses straight away, run with `--refresh`:

```sh
fabr build --refresh app
```

If the registry can't be reached when a tag is checked, fabr uses the image it already has, with a
warning. An image named by its digest never changes, so it is never checked again: name the base
by digest to build from exactly the same image wherever and whenever the build runs.

An image's layers are downloaded only when something needs its files, and each is kept by its
digest, so images that share layers download them once.

`fabr ls` of an image's name, with no tag, lists its tags, as the registry holds them now:

```sh
fabr ls @docker:alpine
```

A registry's whole list of images can't be listed, so `fabr ls @docker` is an error.

## Declaring a registry

An `oci_repository` declares a registry by its URL:

```
oci_repository @ghcr { url = https://ghcr.io; }
oci_repository @internal { url = https://registry.example.com:5000; }
```

| Property | Meaning |
|---|---|
| `url` | The registry's URL. Required. |
| `default_namespace` | The namespace a repository named with one segment is in (`library` on Docker Hub). None: the name is used as it is. |
| `login_url` | The name the registry's login is stored under, as `docker login` stores it. By default, the host of `url`. |

`@docker` is declared as a default, so a project can declare it again to read Docker Hub's images
through a mirror:

```
oci_repository @docker {
  url = https://mirror.gcr.io;
  default_namespace = library;
}
```

A registry served over plain HTTP, such as a local `registry:2` container, is declared with an
`http://` URL.

## Signing in

Fabr signs in to a registry with the credentials `docker login` and `podman login` store, so log in
with either tool as you would for Docker, and fabr uses the login:

```sh
docker login ghcr.io
```

Fabr reads these files, and takes a registry's credentials from the first that has them:

1. podman's: `$XDG_RUNTIME_DIR/containers/auth.json` on Linux,
   `~/.config/containers/auth.json` on macOS, and `$XDG_CONFIG_HOME/containers/auth.json`;
2. Docker's: `~/.docker/config.json`.

Where a file stores the login in a credential helper (`credHelpers` for the registry, or
`credsStore` for all of them, as Docker Desktop does), fabr runs the helper,
`docker-credential-<name>`, from your `PATH`, with your environment, as `docker` would. A registry
with no stored login is used anonymously, which is enough to pull public images.

The login is looked up under the host of the registry's `url`. Docker Hub's is stored under
`https://index.docker.io/v1/`, which the declared `@docker`'s `login_url` names. A registry whose
login you stored under another name needs `login_url` set to that name.

Fabr asks the registry for a token for each repository it reads or pushes, as Docker does. Signing in to Amazon ECR is
different: see [Amazon ECR](/reference/aws/ecr/#signing-in).

## Pushing images

A `sync` entry pushes an image to a registry, under a repository and tag:

```
sync release {
  @ghcr:acme/app:1.4.2 = app;
  @ghcr:acme/app:latest = app;
}
```

`fabr sync release` builds each image and pushes it:

1. If the tag already names the same image, the entry is reported as already synced and nothing is
   uploaded.
2. Each layer the repository lacks is uploaded. A layer of a base image pulled from the same
   registry is mounted from the repository it came from, so it isn't uploaded at all; one pulled
   from another registry is copied from there.
3. The image's manifest is pushed under the tag.

The image pushed is the one `fabr build` builds, for [one
platform](/reference/container/images/#the-images-platform), as an OCI image manifest with
gzip-compressed layers. Its digest is the same every time the same inputs are pushed, from any
machine; see [Reproducible images](/reference/container/images/#reproducible-images).

An entry names a tag: a digest is refused (`'acme/app:sha256:…' is no image and tag to publish
to`), because the registry assigns a digest. Only a `container_image` or an image from a
registry can be pushed. Pushing needs a login with permission to push to the repository; on
registries that create repositories on first push, such as Docker Hub and GitHub Container
Registry, nothing else is needed.

Any image can be pushed, including one from another registry, which copies it:

```
sync mirror {
  @internal:base/node:22-alpine = @docker:node:22-alpine;
}
```

## Troubleshooting

**`https://registry-1.docker.io has no image @docker:node:99`**: the registry has no image with
that tag. Check the tag, and the repository's namespace.

**`<image> has no image for linux/<cpu>`**: the image isn't published for the platform you're
building for. The error lists the platforms it has; set `OCI_TARGET` to one of them.

**`… refused a token for repository:acme/app:pull (401)`**: the registry wants a login fabr
doesn't have, or the one it has can't read the repository. Log in with `docker login <host>`; if
you did, check that the login is stored under the registry's host, or set `login_url` to the name
it is stored under.

**`the credential for ghcr.io is held by 'docker-credential-desktop', which is not on PATH`**: the
auth file names a credential helper fabr can't find. Put the helper's directory on `PATH`, or log
in again so the credentials are stored in the file.

**`'@docker:alpine' cannot be listed`**: a repository's tags can't be listed. Name a tag.

## Not supported

- A registry's tags can't be listed with `fabr ls`.
- Fabr pushes one platform's image under a tag; it doesn't push a multi-platform image index.
