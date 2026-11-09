---
title: Running containers
description: How fabr run starts an image with Docker or podman, how a container_program sets its ports, environment, network and host names, and how fabr removes the containers it starts.
---

`fabr run` starts an image as a container, with Docker or podman, attached to your terminal: a
`container_image` you build, an image from a registry, or a `container_program`, which is an image
with the options to run it with. The container is removed when it stops.

```
plugin @fabr-build/container;

container_image web {
  base = @docker:nginx:1.27-alpine;
  files = ./site:** -> usr/share/nginx/html/**;
}

container_program web_dev {
  image = web;
  ports = 8081:80;
}
```

```sh
fabr run web_dev              # http://localhost:8081
fabr run -w web_dev           # restarts it when the site changes
fabr run @docker:alpine:3.20 cat /etc/alpine-release
```

## Coming from Docker

| With Docker | In fabr |
|---|---|
| `docker run --rm -it app` | `fabr run app`. |
| `docker run --rm app arg1 arg2` | `fabr run app arg1 arg2`. |
| `docker run -p 80:80 app`, for each port the image exposes | `fabr run app`: each exposed port is published on the same port of the host. |
| `docker run -p 8081:80 app` | A `container_program` with `ports = 8081:80;`. |
| `docker run -e LOG_LEVEL=debug app` | A `container_program` with `env = { LOG_LEVEL = debug; }`. |
| `docker run --network host app` | A `container_program` with `network = host;`. |
| `docker run --add-host db:host-gateway app` | A `container_program` with `hosts = { db = host-gateway; }`. |
| Rebuilding and restarting by hand after a change | `fabr run -w app`; see [Restarting on change](#restarting-on-change). |
| `docker load` of an image you built | Nothing: `fabr run` loads the image into the engine when it lacks it. |

## Running an image

`fabr run <image> [args…]` builds a `container_image`, or pulls an image from a
[registry](/reference/container/registries/), and runs it. Everything after the image's name is
passed to the container; options for fabr go before it.

The image runs as `docker run` would run it:

- **Arguments** follow the image's entrypoint. For a `container_image` with an
  [`entry`](/reference/container/images/#entrypoint-and-arguments), they come after its `args`; for
  an image with a `CMD`, they replace the `CMD`, so `fabr run @docker:alpine:3.20 cat
  /etc/alpine-release` runs `cat` in place of Alpine's shell.
- **Ports**: each port the image exposes is published on the same port of the host, so an image
  exposing `80/tcp` is reached at `localhost:80`. To publish on other ports, or none, use a
  [`container_program`](#container_program).
- **Terminal**: the container's standard input is attached, and where it is a terminal so is the
  container's, so an interactive program works as with `docker run -it`. Ctrl-C reaches the
  program, which runs under a minimal init (`docker run --init`) that passes signals on.
- **Exit status**: `fabr run` exits with the container's exit status.

Before it runs, the image is loaded into the engine where the engine doesn't have it, under the
name `localhost/fabr/<target>:<id>`, where `<id>` is the start of the image's config digest. Each
build of an image that changed is loaded under a new name; see [Cleaning up](#cleaning-up).

The image is built for the [build's platform](/reference/container/images/#the-images-platform),
which by default is your machine's CPU, so it runs without emulation.

## container_program

A `container_program` is an image and the options to run it with, the part of a `docker run`
command line you would otherwise type each time:

```
container_program api_dev {
  image = api;
  args = --log-level debug;
  env = {
    DATABASE_URL = postgres://app@db:5432/app;
    PORT = 8080;
  };
  ports = 8080:8080 9229:9229;
  hosts = { db = host-gateway; }
}
```

| Property | Meaning |
|---|---|
| `image` | The image: a `container_image`, or an image from a registry (`@docker:redis:7-alpine`). Required. |
| `args` | Arguments given the image's entrypoint, before any given to `fabr run`. |
| `env` | Environment variables, set over the image's (`docker run -e`). |
| `ports` | Ports published on the host, `<host port>:<container port>`, with a protocol where it isn't TCP (`5353:53/udp`). Setting `ports` replaces the default of publishing each port the image exposes. |
| `network` | The network the container joins: `host`, or the name of a network the engine has (`docker network create`). |
| `hosts` | Names added to the container's `/etc/hosts`, each with an address, or `host-gateway` for your machine (`docker run --add-host`). |

A `container_program` of an image from a registry runs a service your project needs without
building anything:

```
container_program redis {
  image = @docker:redis:7-alpine;
  ports = 6380:6379;
}
```

## Restarting on change

`fabr run -w` runs the container and watches its inputs: when a change gives a different image or
different options to run it with, fabr stops the container, removes it, and starts a new one from
the new image. A change that leaves the image the same, such as an edit to a file the image doesn't
include, leaves the container running. See [Watch mode](/guides/watch/#restart-a-program-on-change).

## Images in a build

An image, or a `container_program`, can be a command in a
[`generate`](/reference/standard-rules/#generate) target, to run a tool packaged as an image on
files during the build:

```
generate upper {
  srcs = ./in.txt;
  run = @docker:alpine:3.20 tr a-z A-Z < in.txt > out.txt;
}
```

The container sees none of the build's files: give it its input on standard input (`<`), and
capture what it writes to standard output (`>`), as here. Like any `generate` command, it runs
again only when the image, its arguments or its input change. The command runs with the
`generate` target's `env` and no other environment, so an engine that needs `DOCKER_HOST` or
another variable to find its daemon needs it set there.

## Choosing the container engine

`CONTAINER_ENGINE` is the program fabr runs containers and [build
commands](/reference/container/images/#build-commands) with. It is Docker, found on your `PATH`
(`@host:docker`). To use podman, set it for the project:

```
CONTAINER_ENGINE = @host:podman;
```

or for one run, with `fabr run -DCONTAINER_ENGINE=@host:podman web_dev`. The engine runs with your
environment, so `DOCKER_HOST`, a Docker context, or a podman machine apply as they do to the
command itself.

## Cleaning up

Each container fabr starts is named `fabr-<host>-<pid>-<n>`, and is removed when it stops, when you
press Ctrl-C, and when fabr exits. A container left behind because fabr was killed (`kill -9`, a
crash) is removed by the next fabr run on the same machine that runs a container or a build
command.

The images fabr loads stay in the engine, as `docker run` leaves the images it pulls. To list and
remove them:

```sh
docker image ls 'localhost/fabr/*'
docker image rm $(docker image ls -q 'localhost/fabr/*')
```

A removed image is loaded again the next time it runs.

## Troubleshooting

**`Bind for 0.0.0.0:6379 failed: port is already allocated`**: the image exposes a port that
something on your machine already uses, and `fabr run` publishes each exposed port on the same
port of the host. Declare a `container_program` whose `ports` publish it on another
(`ports = 6380:6379;`).

**`Unable to find 'docker' in PATH`**: fabr can't find the container engine. Install Docker, put
it on `PATH`, or [choose another engine](#choosing-the-container-engine).

**`Cannot connect to the Docker daemon`**: the engine is installed but not running. Start Docker
Desktop, the Docker service, or `podman machine start`.

**`<target>'s image is not one image`**: a `container_program`'s `image` names more than one
thing, or something that is not an image. Name one `container_image`, or one image such as
`@docker:redis:7-alpine`.

## Not supported

- A container can't be started as a service beside tests or another program, such as a database
  a test suite connects to.
- A container run in a [build](#images-in-a-build) can't be given the build's files except on
  its standard input.

## Known issues

- The images `fabr run` loads into the engine are not removed; see [Cleaning up](#cleaning-up).
