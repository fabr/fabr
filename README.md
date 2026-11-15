# Fabr

Fabr is a build tool. You describe what your project produces — packages, programs, tests, images
— and what each is made from, and fabr builds, tests and runs it. Support for each ecosystem comes
from a plugin. Fabr ships plugins for JavaScript and TypeScript, Java, OCI container images and AWS,
and one project can use any number of them together.

Most repositories accumulate a configuration file per tool per package, a lockfile, and scripts
that have to run in the right order. Fabr replaces them with one description of the project:

- **One file, not a dozen.** A `PROJECT.fabr` describes every package in the repository. You
  write no `tsconfig.json`, `pom.xml` or test configuration, generated manifests such as
  `package.json` are written for you, and there is no install step.
- **Nothing is stale, and nothing runs twice.** Fabr knows which files each step reads. Ask for a
  package's tests and whatever they depend on is brought up to date first; change one file and only
  the steps that read it run again, tests included.
- **The same result everywhere, with no lockfile.** Dependency versions follow from the build file
  alone, so there is nothing to drift between machines or conflict in a merge. Fabr downloads the
  Node.js and JDK your build runs on, too.
- **Mistakes surface at build time.** Each build step sees only its declared inputs, in a
  directory and environment of its own, so a dependency that works by accident is an error from
  the start.
- **Variants without a second configuration.** A release build, an ES-module build beside a
  CommonJS one, classes for an older Java release, a build for another platform: the same targets
  with a different setting.

The [introduction](https://fabr.build/introduction/) explains the ideas behind it.

## Status

Fabr is under active development. It builds, tests, runs and publishes JavaScript, TypeScript and
Java projects, builds and pushes container images, and reads from and publishes to AWS. It is
tested on macOS, Linux and Windows, and it builds and tests itself. It is young, and some things
you may rely on aren't there yet: read [Known limitations](https://fabr.build/known-limitations/)
before you commit a project to it.

## Install

Fabr needs Node.js 22.19 or later to run. Install the CLI globally, with any plugins you use
besides the JavaScript one, which comes with it:

```sh
npm install -g @fabr-build/cli                      # JavaScript and TypeScript
npm install -g @fabr-build/cli @fabr-build/java     # and Java
```

The container and AWS plugins are `@fabr-build/container` and `@fabr-build/aws`, installed the
same way.

## A minimal example

Create a `PROJECT.fabr` at your project root. It loads a plugin and declares a target: what to
build, and what from.

```
plugin @fabr-build/js;

js_package mylib {
  srcs  = src:**/*.ts;
  tests = src:**/*.test.ts;
}
```

A Java jar is declared the same way, with the Java plugin's target type:

```
plugin @fabr-build/java;

jar_package greeter {
  srcs = src/main/java:**/*.java;
  deps = @mvn:org.apache.commons:commons-text:1.11.0;
  main_class = com.example.Greeter;
}
```

Then build, test and inspect it. The result is kept in fabr's cache rather than written into your
project, and you look at it as if it were a directory:

```sh
fabr build mylib           # compile and assemble the package
fabr test  mylib           # compile and run the tests
fabr ls    mylib           # list the built files
fabr cat   mylib/index.js  # print one of them
```

Nothing here says how to compile TypeScript or Java or how to lay out a package. That knowledge is
in the plugins; the build file states only what each target is made from. The quick starts for
[JavaScript and TypeScript](https://fabr.build/quickstart-js/) and
[Java](https://fabr.build/quickstart-java/) carry these examples on to dependencies, tests and
runnable programs.

To convert an existing npm, Yarn or pnpm project, `fabr-migrate` writes a first set of build files
from your `package.json` files and lockfile; see
[Migrating an npm, Yarn or pnpm project](https://fabr.build/guides/migrating-js/). A Maven or
Gradle build is converted by hand, as
[Migrating a Maven or Gradle project](https://fabr.build/guides/migrating-java/) describes.

## Documentation

The documentation is at **[fabr.build](https://fabr.build)**.

- **Start here:** the [introduction](https://fabr.build/introduction/), the quick starts for
  [JavaScript and TypeScript](https://fabr.build/quickstart-js/) and
  [Java](https://fabr.build/quickstart-java/), and the
  [conceptual model](https://fabr.build/guides/concepts/).
- **Guides:** [projects with several packages](https://fabr.build/guides/multi-package/),
  [running your own tools](https://fabr.build/guides/tools/),
  [watch mode and dev servers](https://fabr.build/guides/watch/),
  [VS Code support](https://fabr.build/guides/vscode/),
  [continuous integration](https://fabr.build/guides/ci/),
  [auditing dependencies](https://fabr.build/guides/auditing/) and
  [writing your own rules](https://fabr.build/guides/rules/).
- **Reference:** the [command line](https://fabr.build/reference/command-line/), the
  [language syntax](https://fabr.build/reference/syntax/), and the
  [core targets and configuration](https://fabr.build/reference/standard-rules/).
- **Plugins:** [JavaScript and TypeScript](https://fabr.build/reference/js/dependencies/),
  [Java](https://fabr.build/reference/java/dependencies/),
  [container images](https://fabr.build/reference/container/images/) and
  [AWS](https://fabr.build/reference/aws/accounts/).

## Building fabr

Fabr builds and tests itself. The Yarn scripts exist to build a first `fabr` from source, and to
run the checks fabr has no step of its own for yet:

```sh
yarn bootstrap   # build fabr with tsc, then have that fabr rebuild and test every package
yarn dist        # build with tsc, run the tests under jest, and lint
```

Run both before proposing a change. Contributions are welcome: see
[Getting involved](https://fabr.build/contributing/) for the repository layout and conventions, and
[Writing a plugin](https://fabr.build/developer/writing-a-plugin/) to add support for a new
ecosystem. Please discuss a change to the design before implementing it.

## License

Fabr is free software, licensed under the [GNU General Public License v3.0 or later](https://www.gnu.org/licenses/gpl-3.0.html)
(GPL-3.0-or-later).
