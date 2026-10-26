---
title: Dependencies
description: How to declare npm dependencies in fabr, how versions are chosen without a lockfile, and how catalogs, version conflicts, patches and private registries work.
---

A fabr project declares its npm dependencies in the build file, on the targets that use them.
There is no `package.json` to maintain, no install step, and no lockfile: fabr downloads what a
build needs when it needs it, and chooses versions by a rule that gives the same answer every
time. This page covers declaring dependencies and how their versions are chosen.
[Module resolution](/reference/js/module-resolution/) covers what an `import` can reach once they
are.

## Coming from npm, Yarn or pnpm

| With npm, Yarn or pnpm | In fabr |
|---|---|
| `dependencies` in `package.json` | A target's `deps`. |
| `devDependencies` | `test_deps` for what tests need. Build tools aren't dependencies; they are [settings](#tool-versions) such as `TYPESCRIPT`. |
| `peerDependencies` | A target's `provided_deps`, or `optional_provided_deps` for an optional peer. |
| `npm install` | Nothing. Packages are fetched during the build and cached. |
| The lockfile | Nothing. The same build file always selects the same versions. |
| A range such as `^4.17.0` installs the newest match | A range selects the **lowest** version that satisfies everything in the build. |
| Two versions of a package are installed side by side when ranges disagree | An error, until you allow it; see [When versions conflict](#when-versions-conflict). |
| `overrides` / `resolutions` | The `!` marker. |
| Workspace `catalog:` (pnpm, Yarn) | A [catalog](#catalogs). |
| `patch-package`, `pnpm patch`, `yarn patch` | A [`patched` target](#patching-a-package). |
| `postinstall` scripts | Not run. |
| `.nvmrc`, or Volta's `volta.node` | The [`NODE` setting](#the-nodejs-version). Fabr downloads that release and runs your tools and tests on it. |

## Declaring a dependency

A dependency is written `@npm:<package>:<version>`:

```
js_package mylib {
  srcs = src:**/*.ts;
  deps = @npm:lodash:4.17.21 @npm:@types/lodash:4.17.7 @npm:@scope/widgets:^2.1.0;
}
```

The version is an exact version or any npm range: `^2.1.0`, `~2.1.0`, `2.x`, `>=2.1.0 <3`. A range
that contains a space or one of `< > = |` needs quotes, as in `@npm:send:">=0.19.0"`. A dist-tag
such as `latest` is rejected, because what it names changes over time.

Five properties of a `js_package` take dependencies, and they differ in what the published
package says about them:

| Property | Used for | In the generated `package.json` |
|---|---|---|
| `deps` | Packages the code imports | `dependencies` |
| `provided_deps` | Packages the code imports but whoever uses the package supplies, such as `react` for a component library | `peerDependencies` |
| `optional_provided_deps` | As `provided_deps`, for packages whoever uses the package may leave out. The package is still built against them. | `peerDependencies`, marked optional in `peerDependenciesMeta` |
| `compile_deps` | Packages the code is compiled against that the published package doesn't need, such as one imported only for types that don't appear in its declarations | Not written |
| `test_deps` | Packages only the tests import | Not written |

The range written to `package.json` is the one you declared: `@npm:lodash:^4.17.0` becomes
`"lodash": "^4.17.0"`. A dependency on another target in the same project is written by its name
(`deps = mylib;`); see [Projects with several packages](/guides/multi-package/#depend-on-a-sibling-package)
and [Packages built in your project](#packages-built-in-your-project).

`@types` packages go in `deps` alongside the packages they describe, and so does anything else the
compiler needs to see whose types can appear in the package's declarations. A package imported
only for types the declarations never mention can go in `compile_deps`.

A reference is a dependency only in a property that takes packages, such as the five above. In a
property that takes files, such as `resources`, `@npm:normalize.css:8.0.1` is that package's own
files, with nothing it depends on; see [Property kinds](/reference/syntax/#property-kinds).

## How versions are chosen

Fabr uses **minimal version selection**, the algorithm Go modules use. For each package it gathers
every requirement in the build, yours and those of your dependencies' own `package.json` files,
and selects the lowest version that satisfies all of them. In practice that is the highest of the
minimum versions anything asks for.

```
deps = @npm:lodash:^4.17.0;       # selects lodash 4.17.0, not the newest 4.x
```

This is what makes a lockfile unnecessary. With npm, `^4.17.0` means "the newest 4.x at the time
of install", which changes as releases are published, so the result has to be recorded. The
lowest satisfying version doesn't change when something newer is published, so the build file
alone determines the result.

What follows from it:

- **You get the versions you ask for, not newer ones.** If you need a fix made in `lodash`
  4.17.21, write `^4.17.21`. Updating a dependency is always an edit to the build file.
- **Your dependencies' dependencies are also at their minimums.** A package that declares
  `"qs": "^6.11.0"` gets `qs` 6.11.0 unless something else in the build asks for more. To raise
  it, add your own requirement (`@npm:qs:^6.13.0`); the highest minimum wins.
- **An exact version is exact.** `@npm:lodash:4.17.21` selects 4.17.21, and it is an error if
  something else in the build needs a higher one.
- **Each target resolves its own dependencies.** Two targets can end up with different versions of
  a package if their requirements differ. A [catalog](#catalogs) makes them agree.

If the lowest version a range names was never published (`^1.2.0` where the first 1.x release was
1.2.3), fabr selects the lowest published version that satisfies the range.

### Seeing which versions were chosen

`fabr deps <target>` prints the target's dependency tree: each requirement as written, the version
selected for it, and `(!)` beside every package the build would need at more than one version. It
reads only registry metadata, so it works on a target that fails to build because of a conflict:

```
$ fabr deps app
app
deps
├── chalk:4.1.2
│   ├── ansi-styles:^4.1.0 -> 4.1.0 (!)
│   │   └── color-convert:^2.0.1 -> 2.0.1
│   │       └── color-name:~1.1.4 -> 1.1.4
│   └── supports-color:^7.1.0 -> 7.1.0
│       └── has-flag:^4.0.0 -> 4.0.0
└── pretty-format:30.0.5
    ├── react-is:^18.3.1 -> 18.3.1
    ├── ansi-styles:^5.2.0 -> 5.2.0 (!)
    └── @jest/schemas:30.0.5
        └── @sinclair/typebox:^0.34.0 -> 0.34.0

(!) conflicting in app:
  ansi-styles: 4.1.0, 5.2.0
```

[`fabr deps`](/reference/command-line/#deps) describes the rest of its output and the other names
it accepts.

## Catalogs

A catalog is a named list of dependencies whose versions are chosen once, together. Targets then
refer to its members by name, without a version:

```
catalog @pkg {
  deps = @npm:typescript:5.6.3 @npm:@types/node:22.15.3
         @npm:react:^19.1.0 @npm:react-dom:^19.1.0 @npm:@types/react:^19.1.0
         @npm:chai:4.3.6 @npm:@types/chai:4.3.1;
}

TYPESCRIPT = @pkg:typescript;

js_package ui {
  srcs = src:**/*.tsx;
  deps = @pkg:react @pkg:react-dom @pkg:@types/react;
  test_deps = @pkg:chai @pkg:@types/chai;
}
```

Use one when several targets share dependencies. Every target that uses `@pkg:react` gets the same
`react`, with the same versions of everything `react` depends on, and the version is written in
one place. The catalog can be named anything; a project can have several.

- **A member is fetched only when a target uses it,** so a catalog can list everything the project
  might use at no cost.
- **Two versions of one package** can both be members if one is renamed:
  `@npm:typescript:6.0.0-beta -> typescript-6` is then `@pkg:typescript-6`.
- **Targets in your own project and [patched packages](#patching-a-package)** can be members, by
  name.
- **A catalog and a direct `@npm:` reference are resolved separately.** A target that uses
  `@pkg:react` and also `@npm:scheduler:0.25.0` gets `scheduler` at that version for its own
  imports and whatever version the catalog chose for `react`'s; if those differ, that is a
  [version conflict](#when-versions-conflict). Prefer adding the package to the catalog.

Naming a member the catalog doesn't have fails with `Catalog @pkg has no member 'x'`, followed by
the list of members it does have.

## When versions conflict

A target uses one version of each package. When the requirements in a build can't all be met by
one version, fabr stops and reports each requirement and where it came from, followed by lines
you can paste to resolve it (`fabr deps` shows the same conflict
[in the whole tree](#seeing-which-versions-were-chosen)):

```
error: Resolution requires multiple versions of the same package:
  ansi-styles is required as '^4.1.0' and as '^5.2.0', and no one version is both
    '^4.1.0' required via: chalk@4.1.2
    '^5.2.0' required via: pretty-format@30.0.5
help: add to the failing deps (or a shared catalog):
  @npm:ansi-styles:5.2.0? @npm:ansi-styles:4.1.0?
```

npm resolves disagreements like this one silently, by installing a second copy, and published
packages rely on that more often than you might expect: `express` 4.18 alone needs two versions
of `ms`. Expect to add a few of these lines when you first convert a project.

There are three ways to resolve one, in order of preference:

1. **Change a requirement so that one version satisfies everything,** usually by moving one of
   your own dependencies to a release whose requirements agree with the rest.
2. **Allow both versions with `?`.** `@npm:ansi-styles:5.2.0? @npm:ansi-styles:4.1.0?` in the
   target's `deps`, or in the catalog, permits exactly those two versions. Each package then gets
   the version its own range accepts, as it would under npm. The markers don't make
   `ansi-styles` a dependency of your target.
3. **Force one version with `!`.** `@npm:ansi-styles:5.2.0!` replaces every requirement on the
   package with that version, like npm's `overrides`. Use it when a dependency's range is wrong
   and you know the forced version works.

The markers need exact versions. If a later change moves either side of the conflict, the build
fails again and names the marker to update. The
[language reference](/reference/syntax/#version-override-markers) has the full rules.

Programs that fabr only runs, such as the TypeScript compiler, a bundler, or a `js_script`'s own
dependencies, are not held to one version per package. Their dependencies nest as npm's would,
without markers.

### Packages built in your project

A target that builds a package, such as a sibling `js_package` or a
[patched](#patching-a-package) package, takes part in choosing versions like a package from the
registry. A build has no version number, so a range asked of its name is no request for it: a build
your target names in its own `deps` answers every requirement on its name, whatever range is asked
for, which is how a patched package replaces the original everywhere, but a build reached only
through another target answers only the requirements that name it. A build of a target in another
[configuration](/guides/concepts/#configuration), such as `core<BUILD_TYPE=release>`, counts as a
different version of the same package, and the build your target names in its own `deps` is the
one it uses:

| `app`'s `deps` | Result |
|---|---|
| `core widgets<BUILD_TYPE=release>`, where `widgets` depends on `core` | Builds. `widgets` uses the `core` that `app` names. |
| `lib1 lib2`, where `lib1` depends on `core<BUILD_TYPE=release>` and `lib2` on `core` | A version conflict: nothing says which build to use. |
| `lib @npm:core:1.0.0`, where `lib` depends on the target `core` | A version conflict: a registry version doesn't stand in for a package built in your project. |
| `core @npm:core:1.0.0`, or `core core<BUILD_TYPE=release>` | An error: `app` would import two packages named `core`. |

The version conflict is the same error as for registry versions, with each build written the way
you would reference it:

```
error: Failed to build app: Resolution requires multiple versions of the same package:
  core is required as 'core' and as 'core<BUILD_TYPE=release>', and no one version is both
    'core' required via: lib2
    'core<BUILD_TYPE=release>' required via: lib1
help: add to the failing deps (or a shared catalog): core<BUILD_TYPE=release>? core?
```

To resolve it:

- **Name the one to use** in the target's own `deps`: `deps = core lib1 lib2;`.
- **Force one with `!`.** `core!` uses the package the target builds wherever `core` is required;
  `@npm:core:1.0.0!` uses the registry's.
- **Allow both with `?`**, as the help line suggests. Each package then gets the build or version
  it asked for.

A single `deps` list names each package once, whatever the two would resolve to, so asking for a
name twice in one list is reported against the list itself:

```
error: Failed to build app: 'core' is required here as two different packages (from 'core' and '@npm:core:1.0.0')
help: a target requires one package of each name: keep one, or allow the other alongside with '?'
```

Keep one, or mark the other with `?`, which allows it without asking for it. A `!` doesn't settle
it: `core! @npm:core:1.0.0` still names `core` twice. Across lists the resolution decides: with
`deps = core<MODE=a>; test_deps = core<MODE=b>;` the tests ship two builds of `core`, a conflict,
unless the test's is marked `core<MODE=b>!` (tests run against that build throughout) or
`core<MODE=b>?` (each package gets the build it asked for). Under `fabr build`, `test_deps` is
read for its loose files only, so the build itself is unaffected.

To use the files of several builds side by side, rather than a package, list them in a property
that takes files, such as `resources`.

### Packages required without a minimum version

Some packages require another with the range `*`, which names no minimum. DefinitelyTyped's
`@types` packages do this to each other routinely. If nothing else in the build asks for that
package with a minimum, there is no version to select:

```
error: the following packages are required only without a version lower bound ('*'), so no version is selectable — name one explicitly:
  '@types/deep-eql' — required by @types/chai@5.2.2
help: add to the failing deps (or a shared catalog):
  @npm:@types/deep-eql:4.0.2?
```

Add the suggested line. The `?` supplies the version without making the package a dependency of
your target.

## Renaming a package

`->` gives a dependency a different name, which is the name your code imports:

```
deps = @npm:stream-browserify:3.0.0 -> stream;
```

In a published `package.json` this is written as an npm alias,
`"stream": "npm:stream-browserify@3.0.0"`. A package built in your project can be renamed the same
way: `deps = mylib -> foo;` is written `"foo": "npm:mylib@1.2.3"`, with the `version` of the
`mylib` target. See [Aliases](/reference/js/module-resolution/#aliases).

## Patching a package

To change a published package without forking it, declare a `patched` target named after it.
`srcs` is the package, and `patches` the diffs to apply:

```
patched glob-promise {
  srcs = @npm:glob-promise:1.33.0;
  patches = patches/glob.patch;
}

js_package editor {
  srcs = src:**/*.ts;
  deps = glob-promise;
}
```

The result is a package with the target's name, the version and dependencies of the original, and
the patched files. Because it is named `glob-promise`, it replaces the published package
everywhere in a build that includes it, including where other packages depend on `glob-promise`.
Listing it in a catalog does the same for every target that uses the catalog. Under any other
name it is a separate package, and the original stays in use wherever it is required.

A patch is a unified diff with paths relative to the package root, as `git diff`, `pnpm patch` and
`yarn patch` write them (`a/dist/index.js`).

- It can change, add, delete and rename files, and set a file's executable bit. Binary changes are
  refused.
- Several patches apply in the order written.
- A patch must apply exactly. One that doesn't fails the build, naming the patch, the file and
  the hunk: `patch 'glob.patch' does not apply to 'dist/index.js': hunk @@ -12,7 +12,7 @@ does not match the file`.
- Patching `package.json` changes that file's contents, but not the package's version or the
  dependencies fabr resolves for it.
- `srcs` must name the package in its registry (`@npm:…`), not through a catalog.

## Platform-specific and optional dependencies

Packages that ship native code usually publish one package per platform and list them all as
`optionalDependencies`, each marked with the `os`, `cpu` and `libc` it supports; `esbuild` and
`@swc/core` work this way. Fabr keeps the ones that match the platform being built for and drops
the rest. That platform is the `TARGET` setting, which defaults to the machine fabr is running on.

A regular (non-optional) dependency that doesn't support the platform is an error:
`fsevents@2.3.3 is not supported for the target platform (os 'linux' is not in [darwin])`.

An optional dependency required only as `*` is left out, because no version of it can be selected.
If you need one, declare it yourself with a version.

## What fabr doesn't do

- **Install scripts aren't run.** `preinstall`, `install` and `postinstall` scripts in a package
  are ignored. A package that downloads or compiles something in such a script won't have done so.
  Many have a prebuilt alternative published as platform-specific packages, which does work.
- **Only registry dependencies are followed.** A dependency whose `package.json` requires
  something by `git+https://`, `file:`, `workspace:` or a tarball URL can't be resolved, and fails
  when that requirement is reached.
- **`devDependencies` of packages you depend on are ignored,** as with every package manager.

## Private registries

`@npm` is a registry declared by the JavaScript plugin, pointing at `https://registry.npmjs.org/`.
To use a different registry for everything, set `NPM_REPOSITORY_URL`:

```
NPM_REPOSITORY_URL = https://npm.example.com/;
```

To use more than one, declare each with `npm_repository` and combine them with a
`repository_group`, which chooses a registry by package name:

```
npm_repository @internal {
  url = https://npm.example.com/;
  access = private;
}

repository_group @deps {
  @acme/* = @internal;
  *       = @npm;
}

js_package app {
  srcs = src:**/*.ts;
  deps = @deps:@acme/widgets:^2.0.0 @deps:lodash:4.17.21;
}
```

Dependencies are then written `@deps:<package>:<version>`. The most specific pattern wins, and a
package's own dependencies are routed by the same rules. A name is looked up in one registry
only; there is no falling back to another.

**Credentials** come from `.npmrc`, in the project's root directory and in your home directory, in
npm's own format:

```
//npm.example.com/:_authToken=${NPM_TOKEN}
```

`_authToken`, `_auth`, and `username` with `_password` are read, and `${VAR}` is replaced from the
environment. `@scope:registry=` lines are not read; route scopes with a `repository_group`.

## Tool versions

The tools fabr runs are npm packages too, each named by a setting you can override in your build
file. They are resolved separately from your targets' dependencies, so the version of TypeScript
that compiles your code doesn't have to agree with a `typescript` your code imports.

Fabr's own wrappers around these tools (its TypeScript compiler driver, the bundler and stylesheet
drivers, the test runners) are installed with fabr, in `@fabr-build/js-tools`, and aren't
downloaded. Each is a target with a setting's name — `TSC_DRIVER`, `JS_BUNDLER`, `SASS_DRIVER`,
`POSTCSS_DRIVER`, `JS_COVERAGE_DRIVER` and the [test runners](/reference/js/testing/#using-your-own-test-runner)
— which you replace by declaring that name in your build file (`TSC_DRIVER = my_driver;`).

| Setting | Default | Used for |
|---|---|---|
| `TYPESCRIPT` | `@npm:typescript:5.6.3` | [Compiling](/reference/js/typescript/) TypeScript and JavaScript |
| `ESBUILD` | `@npm:esbuild:0.28.1` | `js_bundle` |
| `SASS` | `@npm:sass-embedded:1.100.0` | [Sass](/reference/js/stylesheets/) |
| `POSTCSS`, `POSTCSS_MODULES` | `@npm:postcss:8.5.28`, `@npm:postcss-modules:9.0.1` | css-modules |
| `JEST` | `@npm:jest:30.3.0` | The [`jest` test framework](/reference/js/testing/#jest) |
| `NODE` | `@node:24.22.1:bin/node` | The Node.js binary every JavaScript program runs on; see [The Node.js version](#the-nodejs-version) |

A setting can name a catalog member (`TYPESCRIPT = @pkg:typescript;`), so that the compiler and
the `typescript` your code imports are the same version.

To run a package's command-line program directly, use `fabr run` with the same kind of reference:
`fabr run @npm:prettier:3.3.3 --check src`. Where a package has more than one program, name it:
`fabr run @npm:typescript:5.6.3:tsc`.

### The Node.js version

Fabr downloads the Node.js release that JavaScript programs run on, rather than using the `node`
on your `PATH`. The `NODE` setting names it, `@node:24.22.1:bin/node` by default, and every
JavaScript program fabr starts runs on that binary:

- the TypeScript compiler, the bundler, and the Sass and PostCSS steps;
- the test runners, and every test process they start;
- `js_script` targets, a `js_package` under `fabr run`, and a registry package's program
  (`fabr run @npm:prettier:3.3.3`);
- any of these used as a stage of a `generate` command.

`fabr` itself is a Node.js program, so it runs on whichever `node` starts it, which must be
Node.js 22.19 or later. That version and the one `NODE` names are independent: switching your
machine's Node.js, with `nvm use` or an upgrade, changes nothing that fabr builds.

To use another release, set `NODE` in your build file:

```
NODE = @node:22.15.0:bin/node;
```

Changing `NODE` rebuilds and retests everything that ran on the previous binary, because the
binary is part of each tool's installation. For a single run, set it on the command line instead:
`fabr test -DNODE=@node:22.15.0:bin/node mylib`.

A range is accepted, and as with packages, fabr selects the
[lowest published version that satisfies it](#how-versions-are-chosen): `@node:^22.15.0` is
22.15.0, and `@node:22` is 22.0.0, not the latest 22.x release. Write the exact version you
want.

#### The `@node` repository

`@node` is a repository of Node.js releases, as nodejs.org publishes them, for the platform being
built for:

| Reference | The files it names |
|---|---|
| `@node:24.22.1` | The whole release: `bin/node`, `bin/npm`, `lib/`, `include/` and the rest. |
| `@node:24.22.1:bin/node` | The `node` binary. |

The same references work on the command line, so `fabr run @node:24.22.1:bin/node --version`
runs that release, and `fabr ls '@node:24.22.1:bin/*'` lists its programs.

Releases are available for macOS and Linux, on x64 and arm64, including Linux with musl libc.
Builds that nodejs.org doesn't publish, such as the musl ones, are downloaded from
[unofficial-builds.nodejs.org](https://unofficial-builds.nodejs.org/). On any other platform the
build fails with:

```
error: Failed to build mytool: Node.js releases are not available for 'x86_64-unknown-freebsd'
…
help: set NODE to a node binary for this platform
```

To download releases from a mirror, declare `@node` yourself with its URL, laid out as
`https://nodejs.org/dist` is:

```
node_distribution @node { url = "https://nodejs.example.com/dist"; }
```

Builds that the mirror doesn't have are still downloaded from unofficial-builds.nodejs.org.

#### Using a Node.js binary you already have

`NODE` can name any executable file in your project instead. A build file can only name files in
its own project, so link the binary into it:

```sh
ln -s "$(command -v node)" tools/node
```

```
NODE = ./tools/node;
```

A path outside the project, such as `NODE = /usr/local/bin/node;`, fails with
`'/usr/local/bin/node' is outside the source tree`. Fabr reads the file the link points to and
tracks its contents, so replacing that binary rebuilds what ran on it. It doesn't track shared
libraries the binary loads: a Node.js that links its libraries dynamically, as Homebrew's does,
can still change behaviour without fabr noticing.

## Downloads and the cache

Package metadata and tarballs are downloaded as a build needs them and kept in fabr's cache
(`~/Library/Caches/fabr` on macOS, `~/.cache/fabr` on Linux, or the directory named by
`FABR_CACHE_DIR`). A published version never changes, so once downloaded it isn't fetched again,
and a build whose dependencies are all cached makes no network requests. Each tarball is checked
against the integrity hash the registry publishes before it is used.

Node.js releases are kept the same way. The first build that needs one downloads it, about 30 MB,
and checks it against the `SHASUMS256.txt` file published with the release. Where `NODE` names a
range, fabr also reads nodejs.org's list of releases, and checks it again once nodejs.org's caching
headers say the copy is stale (currently after an hour); without a network connection it uses the
copy it has, with a warning. An exact version needs no list.

Deleting the cache is always safe: the next build downloads what it needs and selects the same
versions.

## Troubleshooting

| What you see | Cause | What to do |
|---|---|---|
| `'latest' is not a valid version constraint for 'x'` | A dist-tag where a version is needed | Write a version or a range. |
| `Missing version in package reference 'x'` | `@npm:x` with no version | Add one: `@npm:x:1.2.3`. |
| `'@npm' names a repository, not a package or files` | A registry or catalog named on its own, as in `deps = @npm;` | Name a package in it: `@npm:x:1.2.3`. |
| `Resolution requires multiple versions of the same package` | Requirements that no single version satisfies | See [When versions conflict](#when-versions-conflict). |
| `'x' is required here as two different packages` | One `deps` list names `x` twice: two versions or ranges, two builds of a target, or a target and a registry package | Keep one, or mark the other with `?`; see [Packages built in your project](#packages-built-in-your-project). |
| `… which is provided by the target 'x', but 'x' is not a package` | A package depends on `x`, and the target named `x` in the build produces plain files, not a package | Build `x` as a package, or rename the target so the names no longer collide. |
| `required only without a version lower bound ('*')` | A package required only as `*` | Add the suggested `@npm:…?` line; see [above](#packages-required-without-a-minimum-version). |
| `no published version of x satisfies '…' required by y` | A range nothing published matches | Correct the requirement, use a version of `y` whose requirement can be met, or force a version with `!`. |
| `NPM package x@1.2.3 not found` | That exact version was never published | Check the version against the registry. |
| `x@… is not supported for the target platform` | A non-optional dependency built for another platform | Remove it, or build for a platform it supports by setting `TARGET`. |
| `Catalog @pkg has no member 'x'` | The catalog doesn't list `x` | Add it to the catalog's `deps`. |
| `Catalog entry '…' projects into a package` | A catalog entry that names a file inside a package | List the whole package, and name the file where you use it: `@pkg:x:path/to/file`. |
| A package behaves like an older release than the one npm installed | Minimal version selection chose the lowest satisfying version | Raise the requirement to the version you need. |
| `Node.js releases are not available for '…'` | No Node.js release is published for the platform | Point `NODE` at a binary for it; see [Using a Node.js binary you already have](#using-a-nodejs-binary-you-already-have). |
| `Node.js 24.99.0 is not published at https://nodejs.org/dist` | `NODE` names a version that doesn't exist | Correct the version in `NODE`. |
| `Node.js … is not published for linux-arm64-musl` (or another platform) | That release has no build for the platform, on nodejs.org or unofficial-builds | Choose another version, or point `NODE` at a binary for the platform. |
| `'…' is outside the source tree`, from `NODE` | `NODE` names a file outside your project | Link the binary into the project; see [Using a Node.js binary you already have](#using-a-nodejs-binary-you-already-have). |
| A package fails at run time looking for a file its install script would have created | Install scripts aren't run | Look for a prebuilt variant of the package, or [patch](#patching-a-package) it. |
