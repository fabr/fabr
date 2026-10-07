# Fabr

Fabr is a build tool for JavaScript and TypeScript projects. A typical repository accumulates a
`package.json`, a `tsconfig.json` and a test configuration for each package, a bundler
configuration, a lockfile, and scripts that have to run in the right order. Fabr replaces all of
that with one description of what the project produces, and from it builds, tests and runs
everything.

- **One file, not a dozen.** A `PROJECT.fabr` describes every package in the repository. Each
  `package.json` is generated, and there is no install step.
- **Nothing is stale, and nothing runs twice.** Fabr knows which files each step reads. Ask for a
  package's tests and whatever they depend on is brought up to date first; change one file and only
  the steps that read it run again, tests included.
- **The same result everywhere, with no lockfile.** Dependency versions follow from the build file
  alone, so there is nothing to drift between machines or conflict in a merge.
- **Mistakes surface at build time.** Code can import only the packages its target declares, and
  each build step sees only its declared inputs, in a directory and environment of its own.
- **Variants without a second configuration.** A release build, an ES-module build beside a
  CommonJS one, a build for another platform: the same targets with a different setting.

The [introduction](https://fabr.build/introduction/) explains the ideas behind it.

## Status

Fabr is under active development. It builds, bundles, tests, runs and publishes JavaScript and
TypeScript projects, and it builds and tests itself. It is young: other languages are still to
come, and some things you may rely on aren't there yet. Read
[Known limitations](https://fabr.build/known-limitations/) before you commit a project to it.

## Install

Fabr needs Node.js 22.19 or later. Install the CLI globally; it brings the JavaScript and
TypeScript rules (`@fabr-build/js`) with it:

```sh
npm install -g @fabr-build/cli
```

Install `@fabr-build/cli` only. Adding `@fabr-build/js` to the command makes npm give it a second
copy of `@fabr-build/core`, and fabr can only work with one.

## A minimal example

Create a `PROJECT.fabr` at your project root:

```
plugin @fabr-build/js;          # load the JavaScript/TypeScript rules

JS_TARGET = es2021-commonjs;    # configuration

js_package mylib {              # a target: what to build, and from what
  srcs  = src:**/*.ts;
  tests = src:**/*.test.ts;
}
```

and a source file, `src/index.ts`:

```ts
export const greet = (name: string): string => `Hello, ${name}!`;
```

Then build it, test it, and look at the result. The package is kept in fabr's cache, not written
into your project, and you inspect it as if it were a directory:

```sh
fabr build mylib           # compile and assemble the package
fabr test  mylib           # compile and run the tests
fabr ls    mylib           # list the built files
fabr cat   mylib/index.js  # print one of them
```

Nothing here says how to compile TypeScript or lay out a package. That knowledge is in the
`@fabr-build/js` plugin; the build file only states what the package is made from. The
[quick start](https://fabr.build/quickstart-js/) carries this example on to dependencies, tests
and runnable programs.

## Documentation

The documentation is at **[fabr.build](https://fabr.build)**.

- **Start here:** the [introduction](https://fabr.build/introduction/), the
  [quick start](https://fabr.build/quickstart-js/) and the
  [conceptual model](https://fabr.build/guides/concepts/).
- **JavaScript and TypeScript:**
  [dependencies](https://fabr.build/reference/js/dependencies/),
  [module resolution](https://fabr.build/reference/js/module-resolution/),
  [TypeScript compilation](https://fabr.build/reference/js/typescript/),
  [stylesheets](https://fabr.build/reference/js/stylesheets/),
  [testing](https://fabr.build/reference/js/testing/) with `node:test`, jest or vitest,
  [bundling](https://fabr.build/reference/js/bundling/) and
  [publishing](https://fabr.build/reference/js/publishing/).
- **Guides:** [projects with several packages](https://fabr.build/guides/multi-package/),
  [watch mode and dev servers](https://fabr.build/guides/watch/) and
  [continuous integration](https://fabr.build/guides/ci/).
- **Reference:** the [command line](https://fabr.build/reference/command-line/), the
  [language syntax](https://fabr.build/reference/syntax/), and the target types and properties of
  [core](https://fabr.build/reference/standard-rules/) and
  [JavaScript](https://fabr.build/reference/js/targets/).

## Building fabr

Fabr builds and tests itself. The Yarn scripts exist to build a first `fabr` from source, and to
run the checks fabr has no step of its own for yet:

```sh
yarn bootstrap   # build fabr with tsc, then have that fabr rebuild and test every package
yarn dist        # build with tsc, run the tests under jest, and lint
```

Run both before proposing a change. Contributions are welcome: see
[Getting involved](https://fabr.build/contributing/) for the repository layout and conventions, and
[PLUGINS.md](PLUGINS.md) to add support for a new ecosystem. Please discuss a change to the design
before implementing it.

## License

Fabr is free software, licensed under the [GNU General Public License v3.0 or later](https://www.gnu.org/licenses/gpl-3.0.html)
(GPL-3.0-or-later).
