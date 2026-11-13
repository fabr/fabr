---
title: Building images
description: How a container_image builds an OCI image from a base image, files and settings, how build commands add a layer, and which platform an image is built for.
---

A `container_image` target builds an OCI image: the layers of a base image, a layer holding files
from your project, and the image's settings (entrypoint, environment, ports and so on) applied over
the base's. Fabr writes the image itself, so building one needs no Docker daemon unless the image
runs a [build command](#build-commands). The result can be [pushed to a
registry](/reference/container/registries/#pushing-images), [run](/reference/container/running/)
with Docker or podman, or read file by file.

```
plugin @fabr-build/container;

container_image web {
  base = @docker:nginx:1.27-alpine;
  files = ./site:** -> usr/share/nginx/html/**;
}
```

```sh
fabr build web
fabr run web            # starts it with Docker, port 80 published
```

The target types come from the container plugin, a package of its own installed beside fabr
(`npm install -g @fabr-build/cli @fabr-build/container`), so a project that builds images declares
`plugin @fabr-build/container;`. Every property is listed in [Container targets and
configuration](/reference/container/targets/).

## Coming from Docker

| In a Dockerfile | In a `container_image` |
|---|---|
| `FROM node:22-alpine` | `base = @docker:node:22-alpine;`, or another `container_image`; see [The base image](#the-base-image). |
| `FROM scratch` | No `base`. |
| `COPY dist/ /app/` | `files = ./dist:** -> app/**;`; see [Adding files](#adding-files). |
| `RUN apt-get install -y curl` | `build = apt-get install -y curl;`; see [Build commands](#build-commands). |
| `ENTRYPOINT ["node", "main.js"]` | `entry = node; args = main.js;`; see [Entrypoint and arguments](#entrypoint-and-arguments). |
| `CMD […]` | No equivalent: `args` are part of the entrypoint, and arguments given at run time follow them. |
| `WORKDIR /app` | `workdir = /app;` |
| `USER 1000:1000` | `user = 1000:1000;` |
| `ENV NODE_ENV=production` | `env = { NODE_ENV = production; }` |
| `EXPOSE 8080 53/udp` | `ports = 8080 53/udp;` |
| `LABEL org.opencontainers.image.source=…` | `metadata = { source = …; }`; see [Labels](#labels). |
| A multi-stage build | Build the artifacts as fabr targets, and list them in `files`; see [Putting a program in an image](#putting-a-program-in-an-image). |
| `docker build --platform linux/amd64` | `-DOCI_TARGET=x86_64-unknown-linux`; see [The image's platform](#the-images-platform). |
| `docker build -t app .` | `fabr build app`. The image is kept in fabr's cache, not in Docker. |
| `docker run --rm app cat /etc/os-release` | `fabr cat app:etc/os-release`; see [Looking inside an image](#looking-inside-an-image). |

`ARG`, `VOLUME`, `HEALTHCHECK`, `STOPSIGNAL`, `SHELL` and `ONBUILD` have no property. A base
image's own settings for them are kept in the image built on it.

## The base image

`base` is the image the target builds on: an image from a registry, or another `container_image`
in your project.

```
container_image runtime {
  base = @docker:debian:12-slim;
  build = apt-get update && apt-get install -y --no-install-recommends ca-certificates;
}

container_image app {
  base = runtime;
  files = ./dist:** -> app/**;
}
```

The base's layers are reused as they are, so an image pushed to the registry its base came from
shares those layers rather than uploading them again. How to name images in a registry, pin a
digest, and use registries other than Docker Hub is on the [Registries](/reference/container/registries/)
page.

With no `base`, the image holds only the target's own layer, like an image built `FROM scratch`.

## Adding files

`files` are placed in the image under their own names, starting at `/`. A
[rename](/reference/syntax/) places them somewhere else:

```
container_image site {
  base = @docker:nginx:1.27-alpine;
  files = ./public:** -> usr/share/nginx/html/**
          ./nginx.conf -> etc/nginx/conf.d/default.conf;
}
```

All of `files` goes into one layer, above every layer of the base. In that layer:

- every file is owned by `root` (uid and gid 0), and keeps its own permission bits, so an
  executable script stays executable;
- every directory above a file has its own entry, mode `0755`;
- every timestamp is the Unix epoch.

A file from `files` can't be given another owner or mode in the image: a [build
command](#build-commands) runs before they are added. A program that runs as another
[`user`](#the-images-settings) can read them, and should write to a directory a build command
created for it (`build = mkdir -p /var/lib/app && chown 1000 /var/lib/app;`).

### Putting a program in an image

Build the program with fabr and list what it needs to run in `files`, where a multi-stage
Dockerfile would build it in one stage and copy it into the next. For a Node.js program, a
[`js_installation`](/reference/js/dependencies/) is a `node_modules` holding the package and
everything it requires:

```
js_package server {
  srcs = ./server/src:**;
  deps = @npm:pino:9.4.0;
}

js_installation server_files {
  deps = server;
}

container_image server_image {
  base = @docker:node:22-alpine;
  files = server_files:** -> opt/server/**;
  workdir = /opt/server;
  entry = node;
  args = node_modules/server/main.js;
}
```

The package's own files are at `node_modules/server/` in the installation, so `server`'s compiled
`main.js` is `/opt/server/node_modules/server/main.js` in the image. For a Java program, a
[`java_installation`](/reference/java/packaging/#the-jars-a-program-needs) is the jars of
everything it requires, which you place in a directory of the image and name on `java`'s
classpath in `args`.

### Native packages

`files` are resolved for the image's platform rather than for your machine, so a package with
platform-specific variants gets the variant that runs in the image. Building on an Apple silicon
Mac, `@npm:esbuild:0.25.0` in an image built on `node:22-alpine` brings `@esbuild/linux-arm64`,
not `@esbuild/darwin-arm64`.

The C library is the base image's: fabr reads it from the base (its dynamic loader, `ld-musl-*`
for musl or `ld-linux-*` for glibc) and resolves `files` for it, so an Alpine base gets musl
builds of native packages and a Debian base gets glibc builds. A base with neither, such as
`scratch` or a static distroless image, gets musl, the usual form for static binaries.

## The image's settings

Each setting is applied over the base image's; anything the target doesn't set is the base's.

| Property | Sets | Example |
|---|---|---|
| `entry` | The program the container runs; see [Entrypoint and arguments](#entrypoint-and-arguments). | `entry = node;` |
| `args` | The arguments after `entry`. | `args = main.js --port 8080;` |
| `workdir` | The directory the process starts in. | `workdir = /app;` |
| `user` | The user the process runs as: a name, a uid, or `uid:gid`. | `user = 1000:1000;` |
| `env` | Environment variables, set over the base's. | `env = { NODE_ENV = production; }` |
| `ports` | The ports the image exposes: a number for TCP, or with its protocol. | `ports = 8080 53/udp;` |
| `metadata` | The image's labels; see [Labels](#labels). | `metadata = { licenses = MIT; }` |

### Entrypoint and arguments

`entry` and `args` are written together as the image's entrypoint, in exec form, and the base's
`CMD` is cleared:

```
container_image tool {
  base = @docker:alpine:3.20;
  files = ./bin:hello.sh -> usr/local/bin/hello;
  entry = hello;
  args = --verbose;
}
```

is the image a Dockerfile would build with `ENTRYPOINT ["hello", "--verbose"]`. Arguments given
when the image is run follow them: `fabr run tool world` runs `hello --verbose world`.

`entry` is the one program, a path or a command found on the image's `PATH`; its arguments go in
`args`. Setting `args` without `entry` is an error, `'args' is set without 'entry'`. With neither
set, the image keeps the base's entrypoint and `CMD`, as an image built `FROM` it with no
`ENTRYPOINT` or `CMD` of its own would.

### Labels

`metadata` writes the image's labels. The keys the [OCI image
spec](https://github.com/opencontainers/image-spec/blob/main/annotations.md) defines are written
under its prefix, and any other key as you write it:

```
container_image app {
  base = runtime;
  metadata = {
    description = The order service;
    source = https://github.com/acme/orders;
    licenses = Apache-2.0;
    team = payments;
  };
}
```

writes `org.opencontainers.image.description`, `org.opencontainers.image.source`,
`org.opencontainers.image.licenses` and `team`. The keys written with the prefix are
`title`, `description`, `url`, `source`, `documentation`, `licenses`, `vendor` and `authors`.

## Build commands

`build` is a shell command run in the base image, like a Dockerfile's `RUN`. What it changes in
the image's filesystem becomes a layer of its own, between the base's layers and the layer of
`files`:

```
container_image runtime {
  base = @docker:debian:12-slim;
  build = apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*;
  env = { DEBIAN_FRONTEND = noninteractive; }
}
```

A build command needs a container engine: fabr runs it with [`CONTAINER_ENGINE`](/reference/container/running/#choosing-the-container-engine),
Docker unless you say otherwise. It runs as `/bin/sh -c` in a container of the base image for the
image's platform, with the target's `env` set and the engine's default network, so it can download
packages. The `env` is the image's environment too. Its output is shown as the build's. The base must have `/bin/sh`, and a target with a
`build` must have a `base`: `<target>'s build command has no image to run in`.

One `container_image` runs one command. To run several in separate layers, as a Dockerfile's
`RUN` lines are, chain images through `base`; to run them in one layer, join them with `&&`.

The layer holds every file and directory the command added or changed, with its owner, mode and
extended attributes kept and its timestamps set to the epoch, and a whiteout for each one it
deleted.

### When a build command runs again

A command's layer is kept, and the command runs again only when the base image, the command, the
target's `env` or the platform changes. Changing the target's `files` or its other settings
doesn't run it again. Because a command such as `apt-get install` reads the network, running it
again can give a different layer; to pick up new package versions, change the command (pin the
versions in it) or the base image.

## The image's platform

An image is built for one platform, which `OCI_TARGET` names as a target triple. It is your build's
CPU on Linux by default (`TARGET`'s CPU with `-unknown-linux`), so on an Apple silicon Mac images
are built for `linux/arm64`, and on an x86-64 machine for `linux/amd64`. The base image is pulled
for that platform, `files` are [resolved](#native-packages) for it, and a build command runs on it.

To build for a server with another CPU, set `OCI_TARGET`, for one build or for the project:

```sh
fabr build -DOCI_TARGET=x86_64-unknown-linux app
```

```
OCI_TARGET = x86_64-unknown-linux;
```

| `OCI_TARGET` | Platform |
|---|---|
| `x86_64-unknown-linux` | `linux/amd64` |
| `aarch64-unknown-linux` | `linux/arm64` |
| `armv7-unknown-linux` | `linux/arm/v7` |
| `armv6-unknown-linux` | `linux/arm/v6` |
| `i686-unknown-linux` | `linux/386` |
| `riscv64-unknown-linux` | `linux/riscv64` |
| `s390x-unknown-linux` | `linux/s390x` |
| `powerpc64le-unknown-linux` | `linux/ppc64le` |

Leave the C library out of `OCI_TARGET`, so that it is the base image's. A triple that names one
(`x86_64-unknown-linux-gnu`) must match the base's.

A build command for another CPU runs under the engine's emulation, which Docker Desktop provides;
on a Linux host, install QEMU's `binfmt` handlers for Docker to use.

## Looking inside an image

`fabr ls`, `fabr cat` and `fabr cp` read an image's filesystem, as its layers make it: a file a
later layer deletes isn't there.

```sh
fabr ls 'app:opt/server/**'          # the files under /opt/server
fabr cat app:etc/os-release          # one file's content
fabr cp app ./rootfs                 # the whole filesystem, copied to ./rootfs/app/
```

Regular files and symbolic links are listed, each as owned by `root`; directories, device nodes,
FIFOs and sockets are not. The same works for an image in a registry; see [Naming
images](/reference/container/registries/#naming-images).

## Reproducible images

The same inputs build the same image, byte for byte, on any machine: layers are written with fixed
owners and timestamps, the image's creation time is the epoch, and a layer is compressed the same
way wherever it is pushed from. The image's digest changes only when its base, its files or its
settings do. A [build command's](#build-commands) layer is the exception: it is whatever the
command produced when it ran.

## Troubleshooting

**`<target>'s base must be one image`**: `base` names more than one thing, or something that is
not an image. Name one image, such as `@docker:debian:12-slim`, or one `container_image`.

**`OCI_TARGET 'x86_64-unknown-linux-gnu' states glibc, but the base image has musl`**: the
triple's C library is not the base's. Leave the C library out (`x86_64-unknown-linux`), or choose
a base built with it.

**`'x86_64-apple-darwin' is not a Linux platform, which is all an image can be built for`**:
`OCI_TARGET` was set to a triple for another OS. Set it to a Linux triple, such as
`x86_64-unknown-linux`.

**`<image> has no image for linux/<cpu>`**: the base isn't published for the platform you're
building for. The error lists the platforms it has; set `OCI_TARGET` to one of them, or choose
another base.

**`Unable to find 'docker' in PATH`**: a build command, or `fabr run`, needs a container engine.
Install Docker, or [use podman](/reference/container/running/#choosing-the-container-engine).

## Not supported

- A file from `files` is always owned by `root`; there is no equivalent of `COPY --chown`.
- An image is built for one platform at a time; fabr doesn't build or push a multi-platform image
  index. Build and push each platform under its own tag.
