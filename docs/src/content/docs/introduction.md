---
title: Introduction
description: What fabr is, what it does for a JavaScript or TypeScript project, how it differs from the tooling you already use, and the ideas you need to read a build file.
---

Fabr is a build tool for JavaScript and TypeScript projects. It replaces the configuration files
and scripts that accumulate around a project with one description of what the project produces,
and from that it builds, tests and runs everything.

A typical TypeScript repository has a `package.json`, a `tsconfig.json` and a test configuration
for each package, a bundler configuration, a lockfile, and scripts that have to be run in the
right order. None of these tools knows about the others. It is left to you to rebuild a library
before testing what depends on it, to keep the configurations agreeing with each other, and to
find out why CI disagrees with your machine.

With fabr you declare each package's sources and dependencies, and the rest follows from that:

- **One file, not a dozen.** A `PROJECT.fabr` describes every package in the repository. There is
  no `tsconfig.json`, test configuration or bundler configuration to write, each `package.json`
  is generated, and there is no install step.
- **Nothing is stale, and nothing runs twice.** Fabr knows exactly which files each step reads.
  Ask for a package's tests and whatever they depend on is brought up to date first; change one
  file and only the steps that read it run again. That includes tests: a test run whose inputs
  haven't changed isn't repeated, on your machine or in CI.
- **The same result everywhere, with no lockfile.** Dependency versions follow from the build
  file alone, so there is nothing to drift between machines and nothing to conflict in a merge.
- **Mistakes surface at build time.** Code can import only the packages its target declares, so
  an import that works by accident today, and breaks when something unrelated moves, is an error
  from the start.
- **Variants without a second configuration.** A release build, an ES-module build beside a
  CommonJS one, a build for another platform: each is the same targets with a different setting,
  asked for on the command line or by the package that needs it.

Fabr is under active development. It builds and tests real projects, itself among them, but it is
young: check [Known limitations](/known-limitations/) before you commit a project to it, and see
[Getting involved](/contributing/) if you'd like to help.

## What changes day to day

If you build a TypeScript project with npm scripts, `tsc`, a bundler and a test framework:

| You do this now | With fabr |
|---|---|
| `npm install` after every pull | Nothing. Dependencies are fetched as a build needs them. |
| Run scripts in the right order: build, then test | Name what you want: `fabr test mylib`. Fabr derives the order and runs steps in parallel. |
| Start each tool's watch mode | Add `-w` to any command: `fabr test -w mylib`. |
| Find output in `dist/` or `build/` | Output stays in fabr's cache, out of your tree. You list, print or copy it with `fabr ls`, `cat` and `cp`. |
| Switch configuration for a release build | `fabr build -DBUILD_TYPE=release app`. |

## The core idea

Most build tools mix three things together: what you want built, how it gets built, and the
settings for one particular build. Fabr keeps them apart.

- A **target** describes a result you want: its type (`js_package`, `js_bundle`, …) and the
  inputs it is made from. A target says nothing about how it is built.
- A **rule** is the knowledge of how to do something with a target of a given type: build it,
  test it, run it. Rules come with fabr and its plugins; you don't write them in a build file.
- **Configuration** is a set of named settings, such as `BUILD_TYPE` or the platform to build
  for, applied to a build from outside the targets.

Because a target only describes its inputs, the same declaration is built, tested, run or
cross-compiled depending on what you ask for, and you never rewrite a target to change how it is
built.

## What a build file looks like

A project has a `PROJECT.fabr` at its root. It loads plugins, sets configuration and declares
targets:

```
plugin @fabr-build/js;          # load the JavaScript and TypeScript rules

JS_TARGET = es2022-esm;         # configuration: what JavaScript to emit

js_package mylib {              # a target
  srcs = src:**/*.ts;
  deps = @npm:lodash:4.17.21;
  tests = src:**/*.test.ts;
}
```

```sh
fabr build mylib     # compile it and assemble the package
fabr test mylib      # compile and run its tests
```

Nothing here says how to compile TypeScript or assemble a package. That knowledge is in the
`@fabr-build/js` plugin's rules. The [quick start](/quickstart-js/) builds this example up step by
step.

## The same result every time

Fabr treats a build as a function of its inputs: the same sources, build file and settings always
produce the same output. Two things follow.

- **There are no lockfiles.** Dependency versions are chosen by
  [minimal version selection](/reference/js/dependencies/#how-versions-are-chosen), which depends
  only on the requirements written in your build file and in the packages you use. Nothing needs
  recording, so nothing can drift.
- **The cache is never an input.** Fabr keeps what it has built and downloaded in a cache, and
  reuses a result whenever the inputs that produced it are unchanged. Deleting the cache changes
  how long the next build takes and nothing else. It is at `~/Library/Caches/fabr` on macOS and
  `~/.cache/fabr` on Linux, or wherever `FABR_CACHE_DIR` says.

One gap remains: programs fabr finds on your machine, such as `node`, are not yet part of that
guarantee. See [Known limitations](/known-limitations/#host-tools-arent-hermetically-sealed-yet).

## Terms used in these docs

| Term | Meaning |
|---|---|
| **target** | Something that can be built, declared in a build file with a type, a name and its inputs: `js_package mylib { … }`. |
| **target type** | What kind of thing a target is, and which properties it takes. Core and plugins define the types (`js_package`, `generate`, `catalog`, …). The keyword that defines one is `targetdef`. |
| **property** | A named value. Inside a target it is one of the target's inputs (`srcs`, `deps`); at the top of a build file it is a configuration setting (`JS_TARGET`). |
| **rule** | How to carry out an operation on targets of one type. The most specific rule for the target's type and the current configuration is used. |
| **operation** | What is being done with a target: `build`, `test` or `run`. |
| **file set** | A set of named files. Source patterns, built targets and downloaded packages are all file sets, and are referred to the same way. |
| **plugin** | A package that adds target types and rules for an ecosystem, such as `@fabr-build/js`. |

[The conceptual model](/guides/concepts/) explains how these fit together.

## Where to go next

- **[Quick start (JS/TS)](/quickstart-js/)**: install fabr, then build, test and run a TypeScript
  package.
- **[Conceptual model](/guides/concepts/)**: file sets, properties, and building one target in
  several configurations.
- **Guides**: [projects with several packages](/guides/multi-package/),
  [watch mode and dev servers](/guides/watch/) and [continuous integration](/guides/ci/).
- **[Command line](/reference/command-line/)** and **[Language syntax](/reference/syntax/)**: the
  `fabr` command and the `.fabr` language in full.
- **[Core targets and configuration](/reference/standard-rules/)**: the target types and settings
  that are always available.
- **JavaScript reference**: [targets and configuration](/reference/js/targets/),
  [dependencies](/reference/js/dependencies/), [module resolution](/reference/js/module-resolution/),
  [TypeScript compilation](/reference/js/typescript/), [stylesheets](/reference/js/stylesheets/),
  [testing](/reference/js/testing/), [bundling](/reference/js/bundling/) and
  [publishing](/reference/js/publishing/).
