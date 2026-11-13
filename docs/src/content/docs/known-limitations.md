---
title: Known limitations
description: What fabr doesn't support yet for JavaScript, TypeScript and Java projects, and the rough edges in what it does — shell scripts' programs, optional npm dependencies and cache concurrency.
---

Fabr builds, tests and runs real JavaScript, TypeScript and Java projects, itself included, but it
is under active development. Before you convert a project, check the features it relies on
against the first section of this page; each entry links to the page with the details. The
second section lists the places where fabr's present behaviour falls short of what it intends,
with a workaround for each.

## Features not supported yet

**Everywhere**

- **Editors other than VS Code.** There is no IntelliJ IDEA, WebStorm or other editor support;
  see [VS Code support](/guides/vscode/#not-supported).
- **A cache shared between machines.** Each machine, CI runner included, has its own cache; CI
  keeps it between runs as described in [Continuous integration](/guides/ci/#not-supported).
- **Platforms other than macOS and Linux are untested.** Fabr runs wherever Node.js does, but it
  is tested on macOS and Linux only.

**JavaScript and TypeScript**

- **Bundler features beyond esbuild's basics** in a `js_bundle`: hot module reload, live reload,
  plugins, an HTML entry point, `alias` and older-browser targets; see
  [Bundling](/reference/js/bundling/#not-supported). A bundler run as itself, such as Vite, has
  its own; see [Vite, Next.js and other frameworks](/guides/tools/#vite-nextjs-and-other-frameworks).
- **PostCSS plugins other than autoprefixer**, so no Tailwind CSS, and no Less or Stylus; see
  [Stylesheets](/reference/js/stylesheets/#not-supported).
- **`tsconfig.json` path aliases** (`baseUrl`, `paths`) **and `#` subpath imports.** Import your
  own files by the package's name instead; see
  [TypeScript compilation](/reference/js/typescript/#coming-from-tsconfigjson).
- **Dependencies that aren't from a registry**: `git+https://`, `file:` and tarball URLs, in your
  own requirements or a dependency's; see [Dependencies](/reference/js/dependencies/#not-supported).

**Java**

- **Kotlin, Groovy and Scala sources.** Fabr compiles Java only; see
  [Migrating a Maven or Gradle project](/guides/migrating-java/#not-supported).
- **Exclusions of your own**, and relocations; see
  [Dependencies](/reference/java/dependencies/#not-supported).
- **`-SNAPSHOT` versions and the local repository** (`~/.m2/repository`); see
  [Dependencies](/reference/java/dependencies/#coming-from-maven-or-gradle).
- **Options for `javac`**, such as `-Xlint`, `-Werror` or an annotation processor's `-A` options;
  see [Compiling](/reference/java/compiling/#not-supported).
- **Arguments and environment variables for the test JVM**, such as `-Xmx`, `--add-opens` or
  `DOCKER_HOST`; see [Testing](/reference/java/testing/#not-supported).
- **Publishing to Maven Central**; see [Publishing](/reference/java/publishing/#not-supported).

## Rough edges

| Limitation | Effect |
|---|---|
| [Programs a shell script starts are not tracked](#programs-a-shell-script-starts-are-not-tracked) | A different version of a program a script runs can change results without fabr noticing. |
| [Optional dependencies required as `*` are dropped](#optional-npm-dependencies-required-only-as--are-left-out-silently) | Such a dependency is missing, with no warning. |
| [No lock between fabr processes](#concurrent-fabr-processes-duplicate-work-rather-than-sharing-it) | Two builds at once may each do the same work; deleting the cache under `fabr run` removes the running program. |

### Programs a shell script starts are not tracked

Fabr intends a build to depend only on its
[declared inputs](/introduction/#the-same-result-every-time). A [`script`](/reference/standard-rules/#script)
target runs under your machine's `/bin/sh`, which fabr identifies by its contents, as it does any
[program on your machine](/guides/tools/#programs-on-your-machine). The programs the script starts
by name are the exception: fabr records nothing about them.

So **a different version of a program a script runs can change a result without invalidating the
cache.** Fabr reuses results built with the old one.

**Workaround:** write the step as a `js_script` where you can, so that it runs on the Node.js
release [`NODE`](/reference/js/dependencies/#the-nodejs-version) names, or name each program as a
command of its own (`@host:protoc`). Otherwise, keep the programs scripts use the same on machines
that should produce the same results, and delete the cache after changing them.

### Optional npm dependencies required only as `*` are left out silently

An optional dependency that packages require only as `*` (for example `fsevents: "*"`) has no
version that can be selected, so fabr leaves it out, currently without a warning.

**Workaround:** declare the dependency yourself with a version.

### Concurrent fabr processes duplicate work rather than sharing it

Within one `fabr` process, each piece of work is done once, however many targets need it. Between
processes there is no such coordination: two `fabr` runs at the same time that both need something
neither has built will each build it.

This costs time, not correctness. Each process works in a directory of its own and adds a result
to the cache in a single step, so two runs can't corrupt an entry between them.

**Workaround:** none is needed for correctness. To avoid the repeated work, don't start two
builds of the same unbuilt change at once, for example in two worktrees of one branch. Builds of
different changes, or of one already built, share the cache as usual.

Relatedly, `fabr run` installs the program it runs in the cache, and keeps the install there to
reuse on the next run, so deleting the cache while `fabr run` or `fabr run -w` is running deletes
the files of the program it is running. Stop the program first.
