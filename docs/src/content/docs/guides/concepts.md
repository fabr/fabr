---
title: Conceptual model
description: The ideas behind a fabr build file — file sets, properties, configuration and packages — and how one target is built in several configurations.
---

Almost everything in a fabr build file is one of two things: a **file set** or a **property**.
File sets are what a build makes and consumes: your sources, the packages you depend on, and the
output of every target. Properties are the named values that say how. This page explains both,
and then the two ideas built on them: configuration and packages.

## File sets

A file set is a set of named files. The simplest kind comes straight from your source tree:

| Reference | The files it names |
|---|---|
| `bin/script.ts` | One file. |
| `src` | Every file under the `src` directory. |
| `src/**/*.ts` | Every `.ts` file under `src`, at any depth. |
| `./src/*.[jt]s` | The `.js` and `.ts` files directly in `src`. |

These are shell glob patterns, with `**` matching across directories. Paths are relative to the
build file they are written in.

### A target is a file set

A target declares what a result is made from:

```
js_package hello {
  srcs = index.ts;
}
```

The built package is itself a file set, and you refer to it and to the files inside it as if it
were a directory:

| Reference | The files it names |
|---|---|
| `hello` | The whole package. |
| `hello/package.json` | The package's `package.json`. |
| `hello/**/*.js` | Every `.js` file in the package. |

The same references work on the command line (`fabr ls hello`, `fabr cat hello/package.json`) and
as another target's inputs. Using a target in a reference is what causes it to be built.

Target names are global to the project, whichever build file declares them, and a target takes
precedence over a directory of the same name. Write a directory as `./hello` to be unambiguous.

### So is a package from a registry

Packages from a registry are referred to the same way. The JavaScript plugin provides `@npm`, the
npm registry, which takes a package name and a version:

| Reference | The files it names |
|---|---|
| `@npm:picomatch:4.0.5` | The package. |
| `@npm:picomatch:4.0.5:package.json` | One file from it. |

The registry on its own, `@npm`, names no files, and using it as a reference is an error.

### Naming the files

A file set gives each file a name, and whatever consumes the set sees those names, not the paths
the files came from. A reference decides the names as well as the files.

Written with `/`, a reference keeps the path as written. Replacing a `/` with `:` drops everything
before it:

| Reference | Names |
|---|---|
| `./src/*.ts` | `src/a.ts`, `src/b.ts` |
| `./src:*.ts` | `a.ts`, `b.ts` |

This is why sources are usually written `srcs = src:**/*.ts`: the package then contains
`index.js`, not `src/index.js`. A leading `./` or `../` is never part of a name, so
`../scripts/run.ts` is named `scripts/run.ts`.

For anything else there is `->`, which renames by pattern. Each `*` or `**` on the right takes
what the corresponding one on the left matched:

| Reference | Result |
|---|---|
| `./src/**/*.cts -> **/*.ts` | `src/foo/bar.cts` is named `foo/bar.ts`. |
| `hello/*.js -> vendor/hello/*.js` | The package's `index.js` is named `vendor/hello/index.js`. |
| `@npm:picomatch:4.0.5:package.json -> pico.json` | That one file, named `pico.json`. |

The [language reference](/reference/syntax/#projection-and-renaming) has the full rules.

## Properties

A property is a named value. Inside a target, a property is one of the target's inputs (`srcs`,
`deps`). At the top level of a build file, it is a setting or a value you want to reuse:

```
VERSION = 4.0;
DESCRIPTION = 'Starter example';
TEST_DEPS = @npm:chai:4.3.6 @npm:@types/chai:4.3.1;
GREETING = "hello v${VERSION}";
```

`${NAME}` substitutes another property's value as text. A property that holds references, like
`TEST_DEPS` above, is used by its bare name: `test_deps = TEST_DEPS;`.

Two things differ from variables in a script:

- **A property is assigned once.** There is no reassignment, so a property means the same thing
  everywhere in the project.
- **Order doesn't matter.** A property can be used before the line that declares it, and its
  value is worked out only when something needs it.

Properties share one namespace with targets. A property name may contain letters, digits, `_`,
`@` and `-`; a target name may also contain `/` and `.`.

## Configuration

Some properties are settings that rules read to decide how to build: `BUILD_TYPE` (`debug`,
`relwithdebinfo` or `release`), `JS_TARGET` (which JavaScript to emit), `TARGET` (the platform).
Each has a default, and a build file sets its own value by declaring the property:

```
JS_TARGET = es2021-commonjs;
```

A setting can also be changed for one build or for one reference, without editing any target.

- **For a whole run**, with `-D` on the command line: `fabr build -DBUILD_TYPE=release app`.
- **For one reference**, with `<NAME=value>` after it. The reference then means "this target,
  built with this setting". This is a **constraint**.

A constraint doesn't replace the target's ordinary build; it asks for another one alongside it.
In this project, `third` is a CommonJS package that also ships an ES-module build of `second`:

```
JS_TARGET = es2021-commonjs;

js_package base {
  srcs = ./base:*.ts;
}

js_package second {
  srcs = ./second:*.ts;
  deps = base;
}

js_package third {
  srcs = index.ts;
  deps = base;
  resources = second<JS_TARGET=es2021-esm>:*.js -> esm/*.js;
}
```

```
$ fabr build third
info:✓ Compiling base (required by third) (486ms)
info:✓ Compiling base [JS_TARGET=es2021-esm] (required by second < third) (620ms)
info:✓ Compiling second [JS_TARGET=es2021-esm] (required by third) (431ms)
info:✓ Compiling third (549ms)
info:Built third
```

`base` is compiled twice: once as CommonJS because `third` depends on it, and once as ES modules
because the ES-module `second` does. A constraint carries through to everything the constrained
target depends on. Nothing in `base` or `second` mentions either format.

A constraint and `-D` combine. `fabr build -DBUILD_TYPE=release third` builds all of the above as
release builds, the ES-module ones included.

## Rules and operations

A rule is what does the building. Each rule applies to one target type and one **operation**:
`build`, `test` or `run`. The command you give chooses the operation, so `fabr test mylib` and
`fabr build mylib` apply different rules to the same target.

Rules are written in TypeScript and ship with fabr's core and its plugins; a build file can't
define one. When a target type has several rules for an operation, the one that matches the
current settings and the target's own properties most specifically is used. That is how, for example, a `js_package` with
`test_framework = jest` is tested differently from one with `vitest`.

## Packages

A package is a file set that also has a name, a version and dependencies on other packages. A
`js_package` produces one, and so does a reference to a registry such as `@npm:lodash:4.17.21`.

The difference shows in how a package is used:

- **Listed whole in a property that takes packages** (`deps = hello;`), it is made available to
  imports under its own name, together with the packages it depends on.
- **With files selected from it** (`hello:*.js`, `hello/package.json`), or listed in a property
  that takes files (`resources = hello;`), you get its files and nothing more: no name, no
  dependencies.

Which properties take packages is part of each target type's definition; the
[language reference](/reference/syntax/#property-kinds) explains the difference.

Each target chooses the versions of its dependencies, and of their dependencies, for itself. A
package built in your project, such as `hello`, takes part in that choice in the same way as a
package from the registry, so it can conflict with a registry package of the same name and be
settled the same way; see
[Packages built in your project](/reference/js/dependencies/#packages-built-in-your-project). Two
targets can end up with different versions of the same package. A **catalog** chooses versions
once for every target that uses it:

```
catalog @pkg {
  deps = @npm:esbuild:0.28.1 @npm:react:^19.1.0;
}

js_package ui {
  srcs = src:**/*.tsx;
  deps = @pkg:react;
}
```

[Dependencies](/reference/js/dependencies/) covers how versions are chosen and what catalogs do.

:::note
Catalogs and registries don't have to be named with a leading `@`. It is a convention that makes
them easy to tell from targets.
:::

### Choosing versions comes before building

A build happens in two steps. First fabr **resolves** what a target depends on: it reads the
declarations, chooses a version for every package in the tree, and finds any version conflict,
using only the registry's metadata. Then it builds the target, downloading the chosen packages and
building the targets they include. So a conflict fails the build before anything is downloaded,
and a target is built only when something being built needs it.

`fabr deps` stops after the first step. It prints the tree a build would use, without downloading
any package or building any target:

```
$ fabr deps app
app
deps
├── hello
│   ├── picomatch:4.0.2
│   └── chalk:^5.0.0 -> 5.0.0
└── debug:4.3.4
    ├── ms:2.1.2
    └── supports-color:* (p) (n)
```

`hello` is a target in the project, shown by name: it has no version until it is built. The
[`deps` command](/reference/command-line/#deps) explains the rest of the notation.
