---
title: Migrating an npm, Yarn or pnpm project
description: Convert an existing JavaScript project to fabr with fabr-migrate, an experimental, best-effort tool — what it writes from your package.json files and lockfile, the version pins it adds, and what is left for you to do.
---

`fabr-migrate` writes the fabr build files for an existing JavaScript project. It reads your
`package.json` files, your workspace configuration and your lockfile, and writes a `js_package`
target for each package, plus a [catalog](/reference/js/dependencies/#catalogs) holding every
registry dependency. It also adds the version pins fabr needs to select the versions your lockfile
was tested with. It converts your dependencies, not your build: whatever your `package.json`
scripts and tool configurations do is left for you to write as fabr targets.

:::caution[Experimental]
`fabr-migrate` is a best-effort starting point, not a complete conversion. Expect to review what it
writes and to finish the build yourself; the rest of this page says what that involves.
:::

Run it from your project's root directory:

```sh
npx @fabr-build/migration
```

or give it the directory as an argument (`npx @fabr-build/migration path/to/project`). It
resolves your dependencies the same way `fabr deps` does, reading registry metadata but not
downloading any packages, and prints a report of everything it couldn't convert.

## What it converts

| | |
|---|---|
| **Converted** | Every dependency your `package.json` files declare, with its version, as described [below](#how-your-dependencies-are-converted): workspaces (npm, Yarn and pnpm), links between workspace packages, pnpm catalogs, aliases, overrides, private registries, and the version pins your lockfile calls for. |
| **Guessed, for you to check** | Each package's `srcs` and `tests`, from the TypeScript and JavaScript files it finds (`src/**/*.ts`, `src/**/*.test.ts`), leaving out stylesheets, JSON and other assets; `TYPESCRIPT`, where you use TypeScript 5 or 6; `JS_TEST_FRAMEWORK`, where you use Jest or Vitest. |
| **Not converted** | Your `package.json` scripts, and the configuration of every tool they run: `tsconfig.json` compiler options, Jest and Vitest configuration, bundler, Babel and PostCSS configuration, and the `package.json` fields a published package needs (`exports`, `bin`, `files`). |

So how far it gets you depends on how your packages build:

- **Compiled with `tsc`, tested with Jest, Vitest or `node:test`.** The generated `js_package` is
  close to complete. Add the [source-mode flags](/reference/js/typescript/#coming-from-tsconfigjson)
  your `tsconfig.json` relies on, such as `ts/no_strict_null_checks` for `"strictNullChecks": false`.
  Where your Jest configuration says `testEnvironment: "jsdom"`, add the `dom` flag and `jsdom` to
  `test_deps` (see [DOM tests](/reference/js/testing/#dom-tests)). Your Jest or Vitest
  configuration isn't read, so a `setupFilesAfterEnv` file must be named `src/setupTests.ts` (see
  [a setup file](/reference/js/testing/#a-setup-file)). A `moduleNameMapper` entry that stubs
  stylesheets or images isn't needed, since fabr's test runners
  [stub them](/reference/js/testing/#stylesheets-and-other-assets); one that redirects a module to
  another becomes a dependency or a [rename](/reference/js/dependencies/#renaming-a-package).
- **Bundled** with webpack, Vite, esbuild, Rollup or tsup. The `js_package` compiles the sources;
  write a [`js_bundle`](/reference/js/bundling/) target for the bundle, from your bundler's
  configuration (its entry points, externals and aliases).
- **Stylesheets** compiled with Sass or PostCSS. See [stylesheets](/reference/js/stylesheets/).
- **Code generation, or any other script.** Write a [`generate`](/reference/standard-rules/#generate)
  target that runs the tool. A framework that owns its build (Next.js, Astro) is run the same way,
  its CLI in a `generate` target, as [fabr's own documentation site](/guides/watch/#an-example) is.
- **Published.** Check the `package.json` fabr generates against the one you publish now. See
  [publishing packages](/reference/js/publishing/).

## What it writes

| File | Contents |
|---|---|
| `PROJECT.fabr` | The JavaScript plugin, an `include` of `CATALOG.fabr` and of each package's build file, and `TYPESCRIPT` and `JS_TEST_FRAMEWORK` where your project uses a TypeScript 5 or 6 compiler, Jest or Vitest. |
| `<package>/BUILD.fabr` | A `js_package` for the package: its sources, tests and dependencies. |
| `CATALOG.fabr` | The `@dep` catalog, with the pins it adds, and an `npm_repository` for each private registry. |

From then on the files are your project's to edit. `fabr-migrate` never overwrites a file that
exists: run it again and it writes only the files that are missing, and lists the rest in its
report. To have the catalog worked out afresh, after a change to a `package.json` or your lockfile
while your project still builds with its package manager, delete `CATALOG.fabr` and run the tool
again.

A project with no workspaces gets one `js_package`, for the root `package.json`, in a
`BUILD.fabr` beside it.

## How your dependencies are converted

| In `package.json` | In the generated files |
|---|---|
| `"chalk": "^4.1.0"` in `dependencies`, `devDependencies` or `optionalDependencies` | A catalog entry `@npm:chalk:^4.1.0`, and `@dep:chalk` in the package's `deps`. |
| `"react": ">=17"` in `peerDependencies` | `@dep:react` in `provided_deps`, or in `optional_provided_deps` where `peerDependenciesMeta` marks it optional. |
| `"@acme/core": "workspace:*"`, or any spec naming a package of the workspace | `@acme/core` in `deps`: the other package's target. |
| `"ts6": "npm:typescript@^6.0.0"` (an alias) | `@npm:typescript:^6.0.0 -> ts6`, so your code still imports `ts6`. See [renaming a package](/reference/js/dependencies/#renaming-a-package). |
| `"react": "catalog:"` (a pnpm catalog) | The catalog's version, as an ordinary entry. A named catalog (`catalog:legacy`) whose version differs from the default catalog's becomes an entry named `react-legacy`, which the package writes as `@dep:react-legacy -> react`. |
| `"lodash": "latest"` (a dist-tag) | The version your lockfile installs, as `^4.17.21`. fabr doesn't read dist-tags. |
| `file:`, `link:`, git and tarball URLs | Not converted. Listed in the report. |

Development dependencies go in `deps`, the same list as runtime ones. That is correct for an
application. A library you publish would then declare its development dependencies as runtime
dependencies in the `package.json` fabr writes for it, so move them to `test_deps` (packages only
the tests use) or `compile_deps` (packages compiled against but not shipped). See
[declaring a dependency](/reference/js/dependencies/#declaring-a-dependency).

Where two packages ask for different versions of one package, the catalog keeps the higher
minimum version within a major. Two different majors can't share one catalog entry, so the
catalog keeps the first and the report lists the other.

### Dependencies of the root package

npm, Yarn and pnpm hoist the root `package.json`'s dependencies, so a workspace package can import
one it never declares. Under fabr a package can only import what it declares. To keep those
imports working, `fabr-migrate` scans each package's sources for the packages they import. For
each one the root declares and the package doesn't, it adds the dependency to that package's
`deps`, along with the root's `@types` package for it.

Global type packages like `@types/node` are imported by no file. A package gets the ones its
`tsconfig.json` names in `compilerOptions.types` (including through `extends`, and adding those of
any other `tsconfig.*.json` beside it). Where `tsconfig.json` sets no `types`, TypeScript includes
every `@types` package it can see, so the package gets every root `@types` package that isn't the
types of a package the root declares.

An import of a path your `tsconfig.json` maps to your own files, through `baseUrl` or `paths`, is
not treated as a package. Any other import that nothing declares is listed in the report, under
**Imports nothing declares**: add the dependency to the package's `package.json`, or to its
`BUILD.fabr`.

### Overrides

pnpm's `overrides`, Yarn's `resolutions` and npm's `overrides` replace a package's version wherever
it's required. fabr's equivalent is a [forced version](/reference/js/dependencies/#when-versions-conflict),
written `!`, which takes an exact version and applies everywhere.

| Override | In the catalog |
|---|---|
| `"semver": "7.5.4"`: the only override of its package, an exact version, not scoped | `@npm:semver:7.5.4!` |
| `"aws-sdk": "^2.1585.0"`: a range | A minimum version: the entry is raised to `^2.1585.0`. |
| `"a>b": "2.0.0"` or `"b@<2": "2.1.0"`: scoped to a path or a range | An entry `@npm:b:2.0.0`, where the catalog has none for `b`. |
| `"p-queue": "file:…"`, `"x": "-"`, an alias | Not converted. |

A minimum version raises the version selected, but it doesn't change a package that asks for a
version below it. That package then gets a version of its own, which the report lists as a
conflict. Every override that isn't written as `!` is listed in the report.

### Private registries

A scope installed from another registry, by `@scope:registry=` in `.npmrc`, `registries` in
`pnpm-workspace.yaml` or `npmScopes` in `.yarnrc.yml`, gets an `npm_repository` named
`@<scope>-registry` in `CATALOG.fabr`, and its packages are resolved from it:

```
npm_repository @fortawesome-registry {
  url = https://npm.fontawesome.com/;
}
```

Credentials still come from `.npmrc`. See [private registries](/reference/js/dependencies/#private-registries).
A default registry other than npm's becomes `NPM_REPOSITORY_URL`.

## The pins it adds

fabr chooses versions differently from npm, Yarn and pnpm. A package manager installs the newest
version each requirement allows, and records it in the lockfile. fabr has no lockfile: it selects
the *lowest* version that satisfies every requirement, so the result depends only on your
requirements and never changes on its own (see
[how versions are chosen](/reference/js/dependencies/#how-versions-are-chosen)). The two give the
same answer only where every package states its true minimum. Some don't: a package declaring
`"@lezer/lr": "^1.0.0"` while using an API added in 1.3 works under npm, which installs 1.4, and
fails under fabr, which selects 1.0.0.

Your lockfile records what your project was tested with, so `fabr-migrate` resolves the project as
fabr would and compares the result with it. It adds three kinds of pin, each in its own section
of `CATALOG.fabr`:

```
catalog @dep {
  deps =
    @npm:@codemirror/lang-javascript:^6.2.1
    # raised: the declared floor gives 4.0.0, where pnpm-lock.yaml installs 4.1.2
    @npm:chalk:^4.1.2

    # Raised to the versions pnpm-lock.yaml installs, where the declared floors give lower ones.
    @npm:@lezer/lr:^1.4.5

    # Required only without a lower bound: the versions pnpm-lock.yaml installs.
    @npm:@types/d3-array:^3.2.2

    # Packages that ship at several versions, as pnpm-lock.yaml installs them.
    @npm:ms:2.0.0? @npm:ms:2.1.3?;
}
```

- **Raised versions.** Where fabr would select a version lower than every version your lockfile
  installs in the same major, the catalog asks for the lowest of those instead. A raised entry your
  `package.json` declared keeps its place in the list with a comment saying what changed. A package
  no `package.json` names gets an entry of its own in the raised section. Where the lockfile installs
  a package at one version only, the raise may cross a major, because that one version satisfied
  every package that requires it.
- **Packages required without a minimum version.** A package that is only ever required as `*`,
  common among `@types` packages, has no version fabr can select (see
  [packages required without a minimum version](/reference/js/dependencies/#packages-required-without-a-minimum-version)).
  It's pinned at the version your lockfile installs, or at the newest version published where the
  lockfile doesn't install it.
- **Versions allowed to coexist.** Where fabr would ship a package at two versions and your
  lockfile installs it at two versions too, each version is marked with `?`, which allows it (see
  [when versions conflict](/reference/js/dependencies/#when-versions-conflict)).

The tool resolves, pins and resolves again until a round adds nothing; this usually takes three to
six rounds. These are the only pins it adds. A package fabr already selects at or above your
lockfile's version is left alone, so the catalog asks for no more than your project needs.

To write the catalog from your `package.json` files alone, without resolving anything, run
`fabr-migrate --no-pins`.

## Reading the report

The report groups everything `fabr-migrate` couldn't decide for you under a heading each. The ones
to act on:

| Heading | What to do |
|---|---|
| Imports nothing declares | Declare the dependency. A name that is really one of your own directories means a module alias the tool didn't recognise: map it in your sources, or ignore the line. |
| Majors the manifests disagree on | Choose one version for the project. Where a package needs the other major, add it to the catalog under another name with a [rename](/reference/js/dependencies/#renaming-a-package). |
| Version conflicts the lockfile does not share | fabr would ship two versions of a package your lockfile installs once, usually because an override forced one. Raise the requirement that asks for the lower version, force a version with `!`, or allow both with `?`. |
| Versions selected below what the lockfile installs, which a catalog entry cannot raise | A second version of a package is selected lower than the lockfile's. A catalog entry raises only the highest version, so add a `!` if one version must be used everywhere. |
| Overrides written as a floor, Overrides not converted | Check that the pinned versions are what the override was for. A scoped override has no fabr equivalent. |
| Targets that did not resolve | The resolution failed, so nothing that target reaches was pinned. The failure is shown under **Resolution failures**. Fix it, delete `CATALOG.fabr` and run the tool again. |
| Test files outside src/ | Add them to the target's `tests`. |

## After migrating

Build a package to see what's left:

```sh
fabr build @acme/core
```

and work through what's left as [What it converts](#what-it-converts) describes for the way the
package builds. For a library you publish, also move test-only dependencies to `test_deps`.

## Not supported

- A Yarn `patch:` dependency is converted as the package unpatched, and listed in the report. To
  patch it, write a [`patched` target](/reference/js/dependencies/#patching-a-package).
- An import whose module isn't a string literal, such as `require(name)` or `` import(`./${x}`) ``,
  can't be read, so a package imported only that way isn't added from the root's dependencies.
- An override scoped to a path or a range has no fabr equivalent, and is written as a minimum
  version (see [overrides](#overrides)).
- A TypeScript compiler other than 5 or 6 is not used for `TYPESCRIPT`, and fabr's default compiler
  is used instead.
