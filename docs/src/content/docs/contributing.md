---
title: Getting involved
description: Where fabr's source lives, how the repository is laid out, how to build and test it, and how to contribute.
---

Fabr is free software, licensed under GPL-3.0-or-later, and under active development. Bug reports,
design discussion and contributions are all welcome.

- **Source:** [github.com/fabr/fabr](https://github.com/fabr/fabr)
- **Issues:** [github.com/fabr/fabr/issues](https://github.com/fabr/fabr/issues)

## Repository layout

The packages are under `packages/`. Five of them make up fabr itself, the command and the
JavaScript support it needs to build itself:

| Package | What it contains |
|---|---|
| `core` (`@fabr-build/core`) | The engine: the build-file parser and model, the evaluation graph, dependency version selection, the cache, and the target types that aren't specific to a language (`generate`, `script`, `serve`, `catalog`, `patched`, `sync` and others). |
| `js` (`@fabr-build/js`) | The rules for JavaScript and TypeScript: `js_package`, `js_test`, `js_bundle`, `js_script`, the Sass and css-module steps, and the npm registry. It is a plugin, loaded with `plugin @fabr-build/js;`, and core never refers to it. |
| `js-tools` (`@fabr-build/js-tools`) | The programs those rules run, each a separate process: the TypeScript compiler driver, the bundler, Sass and PostCSS drivers, the coverage driver, and the three test runners. |
| `cli` (`@fabr-build/cli`) | The `fabr` command: argument handling, progress display and error reporting. |
| `sass-pnp-importer` (`@fabr-build/sass-pnp-importer`) | A standalone Sass importer that finds package stylesheets without a `node_modules` directory. |

The others are built only by fabr:

| Package | What it contains |
|---|---|
| `java` (`@fabr-build/java`) | The Java plugin: `jar_package`, `java_program`, Maven repositories and JDK distributions. |
| `aws` (`@fabr-build/aws`) | The AWS plugin: AWS accounts, S3, and the sign-in for ECR and CodeArtifact. |
| `container` (`@fabr-build/container`) | The container plugin: OCI images and registries. |
| `migration` (`@fabr-build/migration`) | `fabr-migrate`, which converts an npm, Yarn or pnpm project to fabr. |
| `vscode-ext` | The VS Code extension. |

Each of these has a `BUILD.fabr` and no `package.json` or `tsconfig.json` of its own: Yarn and
jest don't see it, and `fabr test <package>` (for example `./fabr test @fabr-build/java`) builds
and tests it. A new package is set up the same way.

The top-level `PROJECT.fabr` is fabr's own build file, and a good example of a larger one.
End-to-end tests, which run the built `fabr` command against small projects, are in `test/e2e/`.

## Building and testing

Fabr builds and tests itself, with the same `fabr` command and the same plugin mechanism a user's
project has:

```sh
fabr build all
fabr test  all e2e_tests
```

`all` is a property in `PROJECT.fabr` listing every package.

To get a `fabr` to do that with, you need to build one from source first, which is what the Yarn
scripts are for:

| Command | What it does |
|---|---|
| `yarn build` | Compiles the five packages of fabr itself with `tsc`, giving a first `fabr`, which `yarn fabr` runs. |
| `yarn bootstrap` | Runs `yarn build` and uses the result to build fabr's installation (`fabr_install`: the CLI and the plugins installed with it) and copy it into `bootstrap/`. *That* fabr then runs `fabr test all e2e_tests`: every package's tests and the end-to-end tests. The `./fabr` script at the top of the repository runs the fabr in `bootstrap/`. |
| `yarn dist` | Runs `yarn build`, those five packages' tests and the end-to-end tests under jest, and eslint. |

Once `yarn bootstrap` has run, use `./fabr` for everyday work (`./fabr build all`, `./fabr test
@fabr-build/core`). Before proposing a change, run both `yarn bootstrap` and `yarn dist`. The first shows that fabr
still builds and tests itself. The second is still needed because fabr has no lint step of its
own yet. Lint errors fail it; the existing warnings are tolerated.

Tests are `*.test.ts` files beside the code they test, written with `describe`/`it` and chai
assertions so that the same files run under jest in `yarn dist` and under `fabr test`.

The cache is at `~/Library/Caches/fabr` on macOS, `$XDG_CACHE_HOME/fabr` (`~/.cache/fabr` by
default) on Linux and `%LOCALAPPDATA%\fabr` on Windows, or wherever `FABR_CACHE_DIR` says. Deleting
it is always safe.

## Conventions

- **Discuss a change to the design before making it.** Open an issue first for anything that
  changes how fabr behaves or how its parts fit together.
- **New source files carry the GPL header.** Copy it from an existing file.
- **Rules and the model don't print.** Progress and diagnostics go through build events and the
  command-line driver, never `console.log`.
- **Changes come with tests,** added to the existing test file for the area.

## Writing a plugin

Support for a language or ecosystem is a plugin: an npm package whose `.fabr` files declare its
target types and rules, implemented by modules the package exports. A build file loads it with
`plugin <package>;`. [Writing a plugin](/developer/writing-a-plugin/) walks through building one, and
[Plugin reference](/developer/plugins/) documents the interface.
