---
title: Projects with several packages
description: How to lay out a fabr project that builds more than one package — splitting the build file, depending on a sibling package, sharing versions and settings, and building everything.
---

A fabr project can build any number of packages. There is no workspace feature to turn on: every
target in the project can refer to every other by name, wherever it is declared. This guide shows
the usual layout for a repository of several JavaScript packages, which is what you'd otherwise
use npm, Yarn or pnpm workspaces for.

```
PROJECT.fabr
packages/
  core/
    BUILD.fabr
    src/
  app/
    BUILD.fabr
    src/
```

## Coming from workspaces

| With npm, Yarn or pnpm workspaces | In fabr |
|---|---|
| A root `package.json` with `"workspaces"` | A root `PROJECT.fabr` that includes each package's build file. |
| A `package.json` in each package | A `js_package` target for each. |
| `"@acme/core": "workspace:*"` | `deps = @acme/core;` |
| Packages linked into `node_modules` | Nothing to link. A dependency is built when needed and found by name. |
| A build script per package, run in dependency order | `fabr build @acme/app` builds what it depends on first. |
| Shared versions through a root `package.json`, `catalog:` or `resolutions` | A [catalog](#share-versions-with-a-catalog). |
| `--filter`, `-w <workspace>` | Name the targets you want. |

## Split the build file

`PROJECT.fabr` marks the root of the project. Keep the project-wide settings there, and include a
build file from each package:

```
# PROJECT.fabr
plugin @fabr-build/js;

JS_TARGET = es2022-esm;
VERSION = 1.2.0;

catalog @pkg {
  deps = @npm:typescript:5.6.3 @npm:@types/node:22.15.3;
}
TYPESCRIPT = @pkg:typescript;

include ./packages/*/BUILD.fabr;
```

```
# packages/core/BUILD.fabr
js_package @acme/core {
  srcs = src:**/*.ts;
  tests = src:**/*.test.ts;
  deps = @pkg:@types/node;
}
```

The file name is up to you; `BUILD.fabr` is a convention. Three rules explain how an included
file behaves:

- **Paths are relative to the file they are written in.** `src:**/*.ts` in
  `packages/core/BUILD.fabr` means `packages/core/src`. A path can go up with `../` to reach files
  elsewhere in the project, such as a shared licence file: `srcs = src:**/*.ts ../../LICENSE;`.
- **Names are global.** A target or property declared in any file can be used in every other,
  including a catalog or setting from `PROJECT.fabr`. Declaring the same name twice, in any two
  files, is an error.
- **The pattern is re-read as the project changes.** A new `packages/*/BUILD.fabr` is picked up
  without editing `PROJECT.fabr`.

## Depend on a sibling package

Name the target:

```
# packages/app/BUILD.fabr
js_package @acme/app {
  srcs = src:**/*.ts;
  deps = @acme/core @pkg:@types/node;
}
```

```ts
// packages/app/src/index.ts
import { core } from "@acme/core";
```

The import uses the package's name, which is the target's name, exactly as it would for a
published package. Building `@acme/app` builds `@acme/core` first, and rebuilds it when its
sources change; nothing has to be built or linked by hand.

The dependency goes into the generated `package.json` too. When the packages are
[published together](/reference/js/publishing/#dependencies-between-the-packages), it is written
with the version being published.

A package can use a sibling in other ways than as a dependency:

- **Files from it:** `resources = @acme/core:schema/*.json;`.
- **A different build of it:** `@acme/core<JS_TARGET=es2022-commonjs>`; see
  [Configuration](/guides/concepts/#configuration).
- **As a test-only dependency:** `test_deps = @acme/test-helpers;`.

Dependencies can't form a cycle. If two packages depend on each other, fabr reports
`Circular dependency: '@acme/app' depends on itself` and shows the references that make the loop.

## Share versions with a catalog

Each target chooses versions for its own dependencies, so two packages that both use `react`
could get different versions of it. A [catalog](/reference/js/dependencies/#catalogs) in
`PROJECT.fabr` settles the versions once, and every package refers to its members:

```
catalog @pkg {
  deps = @npm:react:^19.1.0 @npm:react-dom:^19.1.0 @npm:@types/react:^19.1.0
         @npm:typescript:5.6.3 @npm:@types/node:22.15.3;
}
```

```
deps = @pkg:react @pkg:@types/react;
```

Updating a dependency for the whole repository is then one edit.

## Share settings and lists

A property in `PROJECT.fabr` is visible everywhere, which covers what a shared `tsconfig` or a
root script usually does:

```
JS_TARGET = es2022-esm;                               # one output format for every package
VERSION = 1.2.0;
TEST_LIBS = @pkg:chai @pkg:@types/chai;               # a list to reuse
COMMON_META = { license = MIT; author = Acme Ltd; }   # shared package.json fields
```

```
js_package @acme/core {
  srcs = src:**/*.ts;
  tests = src:**/*.test.ts;
  test_deps = TEST_LIBS;
  metadata = { COMMON_META; description = The core library; }
}
```

A package that needs something different sets the property on its own target (`test_framework`)
or asks for it with a constraint where it is used.

## Build everything

`fabr` builds the targets you name, and there is no wildcard for "all of them". Declare a property
that lists them, and build that:

```
ALL = @acme/core @acme/app @acme/cli;
```

```sh
fabr build ALL
fabr test ALL
```

Naming the targets on the command line works equally well (`fabr test @acme/core @acme/app`), and
gives each target its own line in the test summary.

`fabr list-targets` prints every target in the project, and `fabr list-targets -l` says which file
declares each.

## Work in one package

Run `fabr` from any directory in the project. Target names are the same everywhere, and paths on
the command line are relative to where you are:

```sh
cd packages/app
fabr test @acme/app
fabr ls ./src
fabr build -w @acme/app     # rebuilds when app or anything it depends on changes
```

## Naming

- **Give a package target the package's name**, scope included: `js_package @acme/core`. It is
  the name in the generated `package.json` and the name other packages import.
- **Don't give a target the name of the directory beside its build file.** A target named `app`
  in a file next to an `app/` directory makes `app/src` mean "the `src` files of the target
  `app`". Scoped names avoid this; otherwise write the directory as `./app`.
