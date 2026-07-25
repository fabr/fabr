# Fabr

Fabr is a declarative, deterministic build orchestration tool. It aims at fast, accurate, and — above
all — **reliable** builds, while keeping even complex build scenarios (multiple languages, multi-stage
pipelines) simple to specify.

The ideas it's built on:

- **Every build step is a pure transform** from its declared inputs to its outputs — a compile, a
  bundle, or an arbitrary command all have the same shape — so every step lands in one dependency
  graph, cached by its inputs, with nothing running blind on the side.
- **Reproducible, with no lockfiles.** A build is a pure function of its inputs: the same inputs always
  produce the same outputs. Dependency versions are chosen deterministically (Go-style minimal version
  selection) from the requirements you actually wrote — nothing is pinned in a side file that can
  drift.
- **Target, rule, and configuration are kept strictly apart.** A target says *what* you want and what
  it needs; a rule knows *how*; configuration (build type, target platform, …) is separate. The same
  target builds, tests, or runs depending only on the operation you ask for.
- **Each build step runs sandboxed** in an isolated view of just its declared inputs, so a step can't
  depend on anything it didn't ask for.

## Status

Fabr is in **active development**, but it is already **fully self-hosting** — fabr builds fabr and runs its own tests —
and has a solid baseline of support for **JavaScript and TypeScript** (compile, bundle, test, run,
publish). Other ecosystems, and some of the broader ambitions above, are still to come. Expect rough
edges; see [Known limitations](https://fabr.build/known-limitations/) for the ones worth knowing up front.

## Install

Fabr ships as two npm packages — the CLI and the JavaScript/TypeScript rules — installed together:

```sh
npm install -g @fabr-build/cli @fabr-build/js
```

## A minimal example

Create a `PROJECT.fabr` at your project root:

```
plugin @fabr-build/js;          # load the JavaScript/TypeScript rules

JS_TARGET = es2021-commonjs;    # configuration

js_package mylib {              # a target: what to build and what it needs
  srcs  = src:**/*.ts;
  tests = src:**/*.test.ts;
}
```

and a source file, `src/index.ts`:

```ts
export const greet = (name: string): string => `Hello, ${name}!`;
```

Then build, test, and inspect it — targets can be inspected as if they were plain directories:

```sh
fabr build mylib         # compile and package
fabr test  mylib         # compile and run the tests
fabr ls    mylib         # list the built files
fabr cat   mylib/index.js  # print a built file to stdout
```

Nothing here says *how* to compile TypeScript or lay out a package — that knowledge lives in the
`@fabr-build/js` plugin's rules. The script only states the target and its inputs. See the
[Quick start](https://fabr.build/quickstart-js/) for dependencies, catalogs, and running programs.

## Documentation

Full documentation lives at **[fabr.build](https://fabr.build)** — the [introduction](https://fabr.build/introduction/),
[language syntax](https://fabr.build/reference/syntax/), the [command-line](https://fabr.build/reference/command-line/)
and [target-type](https://fabr.build/reference/standard-rules/) references, and guides.

## Building fabr

Fabr builds and tests itself — that's the primary workflow once you have a working `fabr`. A
Yarn/TypeScript devchain exists only to bootstrap the very first `fabr` from source:

```sh
yarn bootstrap   # devchain-build fabr, then have the built fabr rebuild + test all packages
yarn dist        # devchain build + Jest tests + lint (the pre-submit gate)
```

Contributions are welcome — see [PLUGINS.md](PLUGINS.md) to add support for a new ecosystem, and the
[Getting involved](https://fabr.build/contributing/) page. Please discuss design-touching changes
before implementing.

## License

Fabr is free software, licensed under the [GNU General Public License v3.0 or later](https://www.gnu.org/licenses/gpl-3.0.html)
(GPL-3.0-or-later).
