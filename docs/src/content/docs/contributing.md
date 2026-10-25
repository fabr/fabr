---
title: Getting involved
description: Where fabr's source lives, how the repository is laid out, how to build and test it, and how to contribute.
---

Fabr is free software, licensed under GPL-3.0-or-later, and under active development. Bug reports,
design discussion and contributions are all welcome.

- **Source:** [github.com/fabr/fabr](https://github.com/fabr/fabr)
- **Issues:** [github.com/fabr/fabr/issues](https://github.com/fabr/fabr/issues)

## Repository layout

The repository holds five packages, under `packages/`:

| Package | What it contains |
|---|---|
| `core` (`@fabr-build/core`) | The engine: the build-file parser and model, the evaluation graph, dependency version selection, the cache, and the target types that aren't specific to a language (`generate`, `script`, `serve`, `catalog`, `patched`, `sync` and others). |
| `js` (`@fabr-build/js`) | The rules for JavaScript and TypeScript: `js_package`, `js_test`, `js_bundle`, `js_script`, the Sass and css-module steps, and the npm registry. It is a plugin, loaded with `plugin @fabr-build/js;`, and core never refers to it. |
| `js-tools` (`@fabr-build/js-tools`) | The programs those rules run, each a separate process: the TypeScript compiler driver, the bundler, Sass and PostCSS drivers, the coverage driver, and the three test runners. |
| `cli` (`@fabr-build/cli`) | The `fabr` command: argument handling, progress display and error reporting. |
| `sass-pnp-importer` (`@fabr-build/sass-pnp-importer`) | A standalone Sass importer that finds package stylesheets without a `node_modules` directory. |

The top-level `PROJECT.fabr` is fabr's own build file, and a good example of a larger one.
End-to-end tests, which run the built `fabr` command against small projects, are in `test/e2e/`.

## Building and testing

Fabr builds and tests itself, with the same `fabr` command and the same plugin mechanism a user's
project has:

```sh
fabr build all
fabr test  all e2e_tests
```

`all` is a property in `PROJECT.fabr` listing the five packages.

To get a `fabr` to do that with, you need to build one from source first, which is what the Yarn
scripts are for:

| Command | What it does |
|---|---|
| `yarn build` | Compiles the packages with `tsc`, giving a first `fabr`, which `yarn fabr` runs. |
| `yarn bootstrap` | Runs `yarn build`, uses the result to build the packages with fabr and copy them into `bootstrap/`, and then has *that* fabr run every package's tests and the end-to-end tests. The `fabr` script at the top of the repository runs the fabr in `bootstrap/`. |
| `yarn dist` | Runs `yarn build`, the tests under jest, and eslint. |

Before proposing a change, run both `yarn bootstrap` and `yarn dist`. The first shows that fabr
still builds and tests itself. The second is still needed because fabr has no lint step of its
own yet. Lint errors fail it; the existing warnings are tolerated.

Tests are `*.test.ts` files beside the code they test, written with `describe`/`it` and chai
assertions so that the same files run under jest in `yarn dist` and under `fabr test`.

The cache is at `~/Library/Caches/fabr` on macOS and `~/.cache/fabr` on Linux, or wherever
`FABR_CACHE_DIR` says. Deleting it is always safe.

## Conventions

- **Discuss a change to the design before making it.** Open an issue first for anything that
  changes how fabr behaves or how its parts fit together.
- **New source files carry the GPL header.** Copy it from an existing file.
- **Rules and the model don't print.** Progress and diagnostics go through build events and the
  command-line driver, never `console.log`.
- **Changes come with tests,** added to the existing test file for the area.

## Writing a plugin

Support for a language or ecosystem is a plugin: an npm package that exports an `activate()`
function returning its rules, repository types and `.fabr` files. A build file loads it with
`plugin <package>;`. [Writing a plugin](/developer/writing-a-plugin/) walks through building one, and
[Plugin reference](/developer/plugins/) documents the interface.
