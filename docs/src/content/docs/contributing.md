---
title: Getting involved
description: How the fabr repository is laid out, how to build and test it, and how to contribute.
---

Fabr is free software (GPL-3.0-or-later) and under active development. Contributions, bug reports, and
design discussion are all welcome.

- **Source:** [github.com/fabr/fabr](https://github.com/fabr/fabr)
- **Issues:** [github.com/fabr/fabr/issues](https://github.com/fabr/fabr/issues)

## Repository layout

Fabr is a Yarn-workspaces monorepo. The bootstrap set is three packages:

- **`packages/core`** — the engine: the reactive evaluation graph, the file/repository model, the
  dependency resolver, the build cache, the model/parser, and the generic bootstrap rules
  (`flag`, `script`, `generate`, `serve`, `catalog`, `sync`) plus the `STD.fabr` standard library.
- **`packages/js`** — all JavaScript-ecosystem support (`js_package`, `js_test`, `js_bundle`,
  `css_compile`, `js_script`, the npm repository, and fabr's own test runner), loaded as a
  **plugin**. Fabr itself never refers to it directly — it declares `plugin @fabr-build/js;` in
  `PROJECT.fabr`, exactly as an end user would.
- **`packages/cli`** — the `fabr` command and its driver (progress rendering, the failure tree,
  the `build`/`test`/`run`/`ls`/`cat`/`cp`/`shell`/`sync` verbs).

Fabr **self-hosts**: it builds all three packages and runs their tests. Self-hosting is the lens the
project is developed through, not the product — the running fabr always loads the js rules through
the same plugin mechanism an installed copy would.

## Building and testing

**Fabr builds and tests itself — that is the primary workflow.** Once you have a working `fabr`, you
develop fabr the way any user builds a project:

```sh
fabr build @fabr-build/core @fabr-build/js @fabr-build/cli
fabr test  @fabr-build/core @fabr-build/js @fabr-build/cli e2e_tests
```

**`yarn bootstrap`** runs that whole self-hosting loop end to end: it compiles the bootstrap set with
the devchain, then has the *built fabr* rebuild all three packages and run their tests. A clean
second run reports "Already up to date". This is the canonical check that a change is
self-build-green, and the one to run before proposing a change. After bootstrap finishes, the `fabr`
script in the top-level directory can be used to drive fabr from the command line.

The **Yarn/TypeScript devchain exists only to bootstrap the very first `fabr` from source** — a
chicken-and-egg problem, since you need a fabr to build fabr. `yarn build` (`tsc -b` + copying the
`lib/` files) produces that initial CLI. `yarn dist` additionally runs the Jest tests and eslint:
tests are colocated `*.test.ts` files that **dual-run** — the same files run under Jest during the
bootstrap *and* under `fabr test` (fabr's own runner) — and lint has no fabr-native equivalent yet,
so `yarn dist` remains the pre-submit gate for those two checks. Lint *errors* block; a handful of
pre-existing warnings are tolerated.

The build cache lives at `~/Library/Caches/fabr` (or `$FABR_CACHE_DIR`) and is always safe to
delete — every result re-fetches or rebuilds identically.

## Conventions

- **Discuss design-touching changes first.** Larger or architecture-affecting work is reviewed for
  direction before implementation.
- **GPL header** on every new source file (copy the block from an existing file).
- **No `console.log` in rules or model code** — progress and diagnostics flow through the
  execution context's progress listener and the driver, never ad-hoc printing.
- Full bootstrap (`yarn bootstrap`) must be **gate-green**.

## The plugin model

Language and ecosystem support is added as **plugins**: an installed package that exports an
`activate()` function returning rules, repositories, and `.fabr` includes. Declaring
`plugin <name>;` in a build script loads it. The interface and contract are documented in
`PLUGINS.md` in the repository — start there if you want to add support for a new ecosystem.
