---
title: Introduction
description: What fabr is, the ideas behind it, and the vocabulary you need to read a build.
---

Fabr is a declarative, deterministic build orchestration tool. It aims to provide fast, accurate, and — above all —
**reliable** builds, while making the most complex build scenarios: multiple languages, cross-compilation, 
and multi-stage builds trivial to specify.

Fabr is currently under active development — it's fully self-hosting and has a solid baseline of support
for JavaScript and TypeScript, but there's obviously far more to do. If you're interested in getting
involved, please check the [Getting involved](/contributing/) page.

## The core idea

Most build tools tangle three separate things together: *what* you want built, *how* it gets built,
and the *configuration* of a particular build. Fabr keeps them strictly apart.

- A **target** describes a result you want — its type (`js_package`, `library`, …) and the inputs it
  needs. A target knows nothing about how to build itself.
- A **rule** carries the knowledge of how to perform an operation (build, test, run) on a target of
  a given type.
- **Configuration** (`BUILD_TYPE`, `TARGET` platform, and so on) is applied to a build as a separate
  set of constraints.

Because targets are pure descriptions and rules are pure knowledge, the same target definition
builds, tests, cross-compiles, or runs depending only on the operation and configuration you ask
for — you never rewrite the target to change how it's built.

## Determinism, and no lockfiles

Fabr treats a build as a function: **the same inputs always produce the same outputs.** Two
consequences follow directly:

- **No lockfiles, ever.** Dependency versions are chosen deterministically by
  [minimal version selection](/reference/js-rules/) from the requirements
  you actually wrote, plus any explicit overrides — not pinned in a side file that can drift.
- **The cache is a memo, not an input.** Fabr's on-disk build cache is purely an optimization: delete
  it and every build produces byte-identical results. Nothing is ever stored that isn't a pure
  function of the key it lives under. (The cache lives at `~/Library/Caches/fabr`, or
  `$FABR_CACHE_DIR`; it is always safe to delete.)

## Vocabulary

These terms are used precisely throughout the docs:

- **target** — a thing that can be built, described by its result *type* and its required inputs. A
  target has no knowledge of how to build itself.
- **target declaration** — a target as written in a build script (e.g. a `js_package { … }` block).
- **rule** — the knowledge of how to perform an operation on a target of a given type. Rules are
  selected by target type plus the operation and constraints; the most specific match wins.
- **targetdef** — the schema of a target type: which properties it accepts and their kinds. Core and
  plugins ship targetdefs (`js_package`, `run`, `catalog`, …); a build script instantiates them.
- **property** - a simple variable declaration (assigned exactly once)
- **operation** — the *verb* of a build, carried as the `BUILD_OPERATION` constraint. `fabr test x`
  is exactly `x` built with `BUILD_OPERATION=test`; likewise `build`, `run`, and `files`.

## How a build is described

A project has a `PROJECT.fabr` file at its root. It declares which rule **plugins** to load, sets
configuration, and declares targets. Here is the shape of one (see the
[Quick start](/quickstart-js/) for a working example):

```
plugin @fabr-build/js;          # load the JavaScript rules

JS_TARGET = es2021-commonjs;    # configuration

js_package mylib {              # a target declaration
  srcs = src:**/*.ts;
  deps = @npm:lodash:4.17.21;
}
```

Nothing here says *how* to compile TypeScript or assemble a package — that knowledge lives in the
`@fabr-build/js` plugin's rules. The script only states the target and its inputs.

## Where to go next

- **[Quick start (JS/TS)](/quickstart-js/)** — install fabr and build, test, and run a TypeScript
  package.
- **[Language syntax](/reference/syntax/)** — the full `.fabr` language.
- **[Core reference](/reference/standard-rules/)** — the core target types, configuration properties,
  and flags.
- **[JavaScript reference](/reference/js-rules/)** — the `@fabr-build/js` plugin.
- **[Getting involved](/contributing/)** — the repository and how to contribute.
