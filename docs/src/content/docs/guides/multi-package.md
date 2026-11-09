---
title: Projects with several packages
description: How to lay out a fabr project that builds more than one package or module — in place of npm, Yarn or pnpm workspaces, a Maven multi-module build or a Gradle multi-project build — splitting the build file, depending on a sibling, sharing versions and settings, and building everything.
---

A fabr project can build any number of packages. There is no workspace feature to turn on: every
target in the project can refer to every other by name, wherever it is declared. This guide shows
the usual layout for a repository of several packages: JavaScript packages, which you'd otherwise
build with npm, Yarn or pnpm workspaces, or Java modules, which you'd otherwise build as a Maven
multi-module build or a Gradle multi-project build. The examples are mostly JavaScript; each
section that differs for Java shows the Java form too.

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

## Coming from workspaces or multi-module builds

| npm, Yarn or pnpm workspaces | Maven or Gradle | In fabr |
|---|---|---|
| A root `package.json` with `"workspaces"` | A parent POM with `<modules>`; `settings.gradle` with `include(…)` | A root `PROJECT.fabr` that includes each package's build file. |
| A `package.json` in each package | A `pom.xml` or `build.gradle` in each module | A target for each: a `js_package`, a `jar_package`. |
| `"@acme/core": "workspace:*"` | A `<dependency>` on `${project.version}`; `project(":core")` | `deps = @acme/core;`, `deps = com.acme/core;` |
| Packages linked into `node_modules` | `mvn install` into the local repository | Nothing to link or install. A dependency is built when needed and found by name. |
| A build script per package, run in dependency order | The reactor order; task dependencies | `fabr build @acme/app` builds what it depends on first. |
| Shared versions through a root `package.json`, `catalog:` or `resolutions` | `<properties>` and `<dependencyManagement>` in the parent POM; `libs.versions.toml` | Properties, and a [catalog](#share-versions-with-a-catalog). |
| Shared settings in a root `tsconfig.json` | Plugin configuration in the parent POM, a convention plugin | [Properties in `PROJECT.fabr`](#share-settings-and-lists). |
| `--filter`, `-w <workspace>` | `-pl`, `:app:build` | Name the targets you want. |

To convert a Maven or Gradle build, see [Migrating a Maven or Gradle project](/guides/migrating-java/).

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

A Java project has the same shape, with the Java plugin and a `jar_package` for each module:

```
# PROJECT.fabr
plugin @fabr-build/java;

JVM_TARGET = jvm17;
TEST_DEPS = @mvn:org.junit:junit-bom:5.11.4
            @mvn:org.junit.jupiter:junit-jupiter
            @mvn:org.junit.platform:junit-platform-launcher;

include ./*/BUILD.fabr;
```

```
# core/BUILD.fabr
jar_package com.acme/core {
  srcs = src/main/java:**/*.java;
  deps = @mvn:com.google.guava:guava:33.2.1-jre;
  tests = src/test/java:**/*.java;
  test_deps = TEST_DEPS;
}
```

The file name is up to you; `BUILD.fabr` is a convention. Three rules explain how an included
file behaves:

- **Paths are relative to the file they are written in.** `src:**/*.ts` in
  `packages/core/BUILD.fabr` means `packages/core/src`. A path can go up with `../` to reach files
  elsewhere in the project, such as a shared licence file: `srcs = src:**/*.ts ../../LICENSE;`.
- **Names are global.** A target or property declared in any file can be used in every other,
  including a catalog or setting from `PROJECT.fabr`. Declaring the same name twice, in any two
  files, is an error, unless one of them is [private](#keep-a-helper-to-its-own-file).
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

A Java module names its sibling the same way:

```
# app/BUILD.fabr
jar_package com.acme/app {
  srcs = src/main/java:**/*.java;
  deps = com.acme/core @mvn:org.slf4j:slf4j-api:2.0.13;
  main_class = com.acme.app.Main;
}
```

`com.acme/app` compiles against `core.jar` and everything `com.acme/core` depends on, and
`fabr run com.acme/app` runs with them on the classpath. When both are published by one `sync`, the
app's POM records the dependency with the coordinate and version the `sync` gives `com.acme/core`;
see [The generated POM](/reference/java/publishing/#the-generated-pom).

A package can use a sibling in other ways than as a dependency:

- **Files from it:** `resources = @acme/core:schema/*.json;`.
- **A different build of it:** `@acme/core<JS_TARGET=es2022-commonjs>`; see
  [Configuration](/guides/concepts/#configuration). Where two packages need different builds of
  one sibling, the one your target names directly is used; see
  [Packages built in your project](/reference/js/dependencies/#packages-built-in-your-project).
- **As a test-only dependency:** `test_deps = @acme/test-helpers;`. This is also what replaces a
  Maven `test-jar` dependency or Gradle's test fixtures: a target of its own for the shared test
  code, in the `test_deps` of the modules that use it.
- **Under another name:** `deps = @acme/core -> core;`, imported as `core`; see
  [Renaming a package](/reference/js/dependencies/#renaming-a-package).

`fabr deps @acme/app` prints what a package depends on, siblings and registry packages together,
with the versions selected; see
[Seeing which versions were chosen](/reference/js/dependencies/#seeing-which-versions-were-chosen).

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

A Maven package in a catalog is named by its group and artifact, `@pkg:org.slf4j/slf4j-api`. For
the other ways a Java project shares versions, and for what a catalog can't yet do for a jar you
publish, see [Shared versions](/guides/migrating-java/#shared-versions).

## Share settings and lists

A property in `PROJECT.fabr` is visible everywhere, which covers what a shared `tsconfig`, a root
script or a parent POM's plugin configuration usually does:

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

For Java, the same holds for `JVM_TARGET`, a list such as `TEST_DEPS` above, or a version used in
several references, `@mvn:org.slf4j:slf4j-api:${SLF4J_VERSION}`.

A package that needs something different sets the property on its own target (`test_framework`)
or asks for it with a constraint where it is used.

## Build what you ship

You don't need to build every package in the repository. Name the things the repository actually
produces, such as the application you deploy, the command-line tool you install or the `sync`
target that [publishes your packages](/reference/js/publishing/#publishing-with-sync), and fabr
builds whatever they depend on, in order:

```sh
fabr build @acme/app      # builds @acme/core too, because @acme/app depends on it
fabr build release        # every package the sync target publishes, uploading nothing
```

A package that nothing you ship depends on, such as a test helper or an internal tool, is built
when you ask for it or when something that uses it is built. Because results are cached, building
the same thing again costs nothing until its sources change.

### Testing

`fabr test` runs the tests of the targets you name, not of the packages they depend on.
`fabr test @acme/app` builds `@acme/core` but doesn't run `@acme/core`'s tests. To test a
package and the siblings it uses, name each:

```sh
fabr test @acme/app @acme/core
```

Each target gets its own line in the test summary. A test run is cached, passing or failing, so a
target whose tests and dependencies haven't changed reports its earlier result without running
again; `fabr test --retry-failed` runs a failed test again.

### Listing targets in a property

When the same set of targets is named often, in CI or by everyone on the team, list them in a
property and name that instead:

```
TESTED = @acme/core @acme/app @acme/cli;
```

```sh
fabr test TESTED
```

The summary then has one line for `TESTED`, totalling the tests of every target in it.

`fabr build` and `fabr test` take only declared names, not patterns, so a list like this is
maintained by hand: a new package isn't in it until you add it. `fabr list-targets` helps keep it
complete: it prints every target in the project with the operations each supports,
`fabr list-targets --operation test` only those that can be tested, `fabr list-targets '@acme/*'`
those whose names match a pattern, and `-l` adds the file that declares each.

## Keep a helper to its own file

A target that exists only to be used by the targets beside it, such as a patched copy of a
dependency or a code generator one package runs, can be declared
[`private`](/reference/syntax/#private-declarations). Only its own build file sees it, so it adds
nothing to the rest of the project's names, and two packages can each have a helper of the same
name:

```
# packages/app/BUILD.fabr
private generate routes {
  srcs = src:routes/*.json;
  run = route_gen *.json > routes.ts;
}

js_package @acme/app {
  srcs = src:**/*.ts routes:routes.ts;
  deps = @acme/core @pkg:@types/node;
}
```

`fabr build @acme/app` builds `routes`, but naming `routes` on the command line, or in another
build file, is an error.

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
- **Give a Java module's target its coordinate**, `<groupId>/<artifactId>`: `jar_package
  com.acme/core`. The jar is named after the last part, `core.jar`; the coordinate it is published
  under is the one its `sync` entry gives it.
- **Don't give a target the name of the directory beside its build file.** A target named `app`
  in a file next to an `app/` directory makes `app/src` mean "the `src` files of the target
  `app`". Scoped names avoid this; otherwise write the directory as `./app`.
