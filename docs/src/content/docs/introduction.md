---
title: Introduction
description: What fabr is, what it does for a JavaScript, TypeScript or Java project, how it differs from the tooling you already use, and the ideas you need to read a build file.
---

Fabr is a build tool for JavaScript, TypeScript and Java projects. It replaces the configuration
files and scripts that accumulate around a project with one description of what the project
produces, and from that it builds, tests and runs everything.

A typical TypeScript repository has a `package.json`, a `tsconfig.json` and a test configuration
for each package, a bundler configuration, a lockfile, and scripts that have to be run in the
right order. A Java one has a `pom.xml` or `build.gradle` per module, each configuring its own
plugins, and a wrapper script pinning the build tool itself. Either way, it is left to you to keep
the configurations agreeing with each other, to rebuild what a change affects before testing it,
and to find out why CI disagrees with your machine.

With fabr you declare each package's sources and dependencies, and the rest follows from that:

- **One file, not a dozen.** A `PROJECT.fabr` describes every package in the repository. There is
  no `tsconfig.json`, `pom.xml`, test configuration or bundler configuration to write, each
  `package.json` is generated, and there is no install step.
- **Nothing is stale, and nothing runs twice.** Fabr knows exactly which files each step reads.
  Ask for a package's tests and whatever they depend on is brought up to date first; change one
  file and only the steps that read it run again. That includes tests: a test run whose inputs
  haven't changed isn't repeated, on your machine or in CI.
- **The same result everywhere, with no lockfile.** Dependency versions follow from the build
  file alone, so there is nothing to drift between machines and nothing to conflict in a merge.
- **Mistakes surface at build time.** JavaScript code can import only the packages its target
  declares, so an import that works by accident today, and breaks when something unrelated moves,
  is an error from the start.
- **Variants without a second configuration.** A release build, an ES-module build beside a
  CommonJS one, classes for an older Java release, a build for another platform: each is the same
  targets with a different setting, asked for on the command line or by the package that needs it.

Fabr is under active development. It builds and tests real projects, itself among them, but it is
young: check [Known limitations](/known-limitations/) before you commit a project to it, and see
[Getting involved](/contributing/) if you'd like to help.

## What changes day to day

If you build a TypeScript project with npm scripts, `tsc`, a bundler and a test framework, or a
Java project with Maven or Gradle:

| You do this now | With fabr |
|---|---|
| `npm install` after every pull | Nothing. Dependencies are fetched as a build needs them. |
| Install and build again in each new clone or git worktree | Nothing to install, and only what differs to build: every checkout on your machine shares [one cache](#the-same-result-every-time). |
| Run scripts in the right order: build, then test; or `mvn install` a module so the next one sees it | Name what you want: `fabr test mylib`. Fabr derives the order, builds what the target depends on, and runs steps in parallel. |
| Start each tool's watch mode | Add `-w` to any command: `fabr test -w mylib`. |
| `npm ls` or `mvn dependency:tree` to see which versions you got | `fabr deps mylib` prints the dependency tree a target resolves to, without downloading the packages. |
| Find output in `dist/`, `build/` or `target/` | Output stays in fabr's cache, out of your tree. You list, print or copy it with `fabr ls`, `cat` and `cp`. |
| Switch configuration for a release build | `fabr build -DBUILD_TYPE=release app`. |

## The core idea

Most build tools mix three things together: what you want built, how it gets built, and the
settings for one particular build. Fabr keeps them apart.

- A **target** describes a result you want: its type (`js_package`, `jar_package`, …) and the
  inputs it is made from. A target says nothing about how it is built.
- A **rule** is the knowledge of how to do something with a target of a given type: build it,
  test it, run it. Rules come with fabr and its plugins, and you can
  [write your own](/guides/rules/) for a layout or a step of your project's.
- **Configuration** is a set of named settings, such as `BUILD_TYPE` or the platform to build
  for, applied to a build from outside the targets.

Because a target only describes its inputs, the same declaration is built, tested, run or
cross-compiled depending on what you ask for, and you never rewrite a target to change how it is
built.

## What a build file looks like

A project has a `PROJECT.fabr` at its root. It loads plugins, sets configuration and declares
targets:

```
plugin @fabr-build/js;          # load the JavaScript and TypeScript rules

JS_TARGET = es2022-esm;         # configuration: what JavaScript to emit

js_package mylib {              # a target
  srcs = src:**/*.ts;
  deps = @npm:lodash:4.17.21;
  tests = src:**/*.test.ts;
}
```

```sh
fabr build mylib     # compile it and assemble the package
fabr test mylib      # compile and run its tests
```

Nothing here says how to compile TypeScript or assemble a package. That knowledge is in the
`@fabr-build/js` plugin's rules. The [quick start](/quickstart-js/) builds this example up step by
step.

A Java project looks the same, with the `@fabr-build/java` plugin's target types:

```
plugin @fabr-build/java;        # load the Java rules

JVM_TARGET = jvm17;             # configuration: the Java release to compile for

jar_package greeter {           # a target
  srcs = src/main/java:**/*.java;
  deps = @mvn:org.apache.commons:commons-text:1.11.0;
  main_class = com.example.Greeter;
}
```

The [Java quick start](/quickstart-java/) builds that one up.

## The same result every time

Fabr treats a build as a function of its inputs: the same sources, build file and settings always
produce the same output. Three things follow.

- **There are no lockfiles.** Dependency versions are chosen by minimal version selection
  ([npm](/reference/js/dependencies/#how-versions-are-chosen),
  [Maven](/reference/java/dependencies/#how-versions-are-chosen)), which depends only on the
  requirements written in your build file and in the packages you use. Nothing needs recording,
  so nothing can drift.
- **The cache is never an input.** Fabr keeps what it has built and downloaded in a cache, and
  reuses a result whenever the inputs that produced it are unchanged. Deleting the cache changes
  how long the next build takes and nothing else. It is at `~/Library/Caches/fabr` on macOS and
  `~/.cache/fabr` on Linux, or wherever `FABR_CACHE_DIR` says; keep it on a local disk rather than
  a network filesystem.

  Results are found by what went into them, not by where the project is, so every checkout on
  your machine shares them. A new clone or `git worktree` starts with the dependency versions
  already chosen, the packages already downloaded and everything unchanged already built: its first
  `fabr test` reads each source file once and builds only what differs from what any checkout has
  built before. Keeping several worktrees, one per branch or task, costs almost nothing. (Two
  builds of the same new change running at once each do the work; see
  [Known limitations](/known-limitations/#concurrent-fabr-processes-duplicate-work-rather-than-sharing-it).)
- **The runtime is an input too.** Fabr downloads the Node.js release that your tools and tests
  run on, named by the [`NODE` setting](/reference/js/dependencies/#the-nodejs-version), and the
  JDK that compiles and runs Java, named by the [`JDK` setting](/reference/java/compiling/#the-jdk),
  rather than using the `node` or `java` on your `PATH`, so switching what your machine has
  installed doesn't change a build.

One gap remains: the `sh` that runs `script` targets, and the programs a script starts, are found
on your machine and aren't part of that guarantee. See
[Known limitations](/known-limitations/#shell-scripts-run-on-the-sh-on-your-machine).

## Terms used in these docs

| Term | Meaning |
|---|---|
| **target** | Something that can be built, declared in a build file with a type, a name and its inputs: `js_package mylib { … }`. |
| **target type** | What kind of thing a target is, and which properties it takes. Core and plugins define the types (`js_package`, `jar_package`, `generate`, `catalog`, …). The keyword that defines one is `targetdef`. |
| **property** | A named value. Inside a target it is one of the target's inputs (`srcs`, `deps`); at the top of a build file it is a configuration setting (`JS_TARGET`). |
| **rule** | How to carry out an operation on targets of one type. The most specific rule for the target's type and the current configuration is used. |
| **operation** | What is being done with a target: `build`, `test` or `run`. |
| **file set** | A set of named files. Source patterns, built targets and downloaded packages are all file sets, and are referred to the same way. |
| **plugin** | A package that adds target types and rules for an ecosystem, such as `@fabr-build/js` or `@fabr-build/java`. |

[The conceptual model](/guides/concepts/) explains how these fit together.

## Where to go next

- **[Quick start (JS/TS)](/quickstart-js/)**: install fabr, then build, test and run a TypeScript
  package.
- **[Quick start (Java)](/quickstart-java/)**: the same for a Java jar, with Maven dependencies and
  JUnit tests.
- **[Conceptual model](/guides/concepts/)**: file sets, properties, and building one target in
  several configurations.
- **Guides**: [projects with several packages](/guides/multi-package/),
  [watch mode and dev servers](/guides/watch/), [continuous integration](/guides/ci/) and
  [writing your own rules](/guides/rules/).
- **[Command line](/reference/command-line/)** and **[Language syntax](/reference/syntax/)**: the
  `fabr` command and the `.fabr` language in full.
- **[Core targets and configuration](/reference/standard-rules/)**: the target types and settings
  that are always available.
- **[Writing a plugin](/developer/writing-a-plugin/)**: add target types and rules of your own.
- **JavaScript reference**: [targets and configuration](/reference/js/targets/),
  [dependencies](/reference/js/dependencies/), [module resolution](/reference/js/module-resolution/),
  [TypeScript compilation](/reference/js/typescript/), [stylesheets](/reference/js/stylesheets/),
  [testing](/reference/js/testing/), [bundling](/reference/js/bundling/) and
  [publishing](/reference/js/publishing/).
- **Java reference**: [targets and configuration](/reference/java/targets/),
  [dependencies](/reference/java/dependencies/),
  [compiling](/reference/java/compiling/), [testing](/reference/java/testing/),
  [running programs](/reference/java/running/) and [packaging](/reference/java/packaging/).
