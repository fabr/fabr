---
title: Command line
description: The fabr command — its commands and options, and how targets and files are named on the command line.
---

```sh
fabr [command] [options] <targets…>
```

`fabr` works on the project that contains the current directory: the nearest `PROJECT.fabr`, in
this directory or one above it. Progress and errors are written to stderr, and a command's own
output, such as the listing from `ls` or the file contents from `cat`, to stdout, so that output
can be piped or redirected on its own.

## Commands at a glance

| Command | What it does |
|---|---|
| [`build`](#build) | Build targets. |
| [`test`](#test) | Build and run targets' tests. |
| [An operation's name](#an-operations-name) | Build targets under an operation a rule declares, such as `lint`. |
| [`run`](#run) | Build a program and run it. |
| [`ls`](#ls), [`cat`](#cat), [`cp`](#cp) | List, print or copy the files a target produces. |
| [`deps`](#deps) | Print the dependency tree of targets or packages. |
| [`shell`](#shell) | Open a shell in the directory a build step runs in, for debugging. |
| [`sync`](#sync) | Publish packages. |
| [`list-targets`](#list-targets), [`list-targetdefs`](#list-targetdefs), [`list-operations`](#list-operations), [`list-properties`](#list-properties), [`list-all`](#list-all) | Describe the project and what a build file can contain. |

### Leaving the command out

With no command, each target gets the first of `build`, `test` and `run` that its type supports:

```sh
fabr mylib                    # a js_package: builds it
fabr e2e                      # a js_test: runs its tests
fabr devserver --port 3000    # a serve target: runs it
```

A target that can only be run ends fabr's own arguments: everything after it goes to the program,
as `--port 3000` does above. To pass arguments to a target that can also be built, name the
command: `fabr run mylib --flag`.

## Commands

### `build`

Builds the targets. The results go into fabr's cache; nothing is written into your project
directory. Use [`ls`](#ls), [`cat`](#cat) and [`cp`](#cp) to look at them or take a copy.

```sh
fabr build mylib
fabr build -DBUILD_TYPE=release mylib app
```

Each name must be one the project declares, such as a target, optionally with a
[constraint](#naming-targets-and-files). A path or a pattern (`mylib:build/*.js`, `./src`) is an
error: to get at particular files, use `ls`, `cat` or `cp`. fabr checks every name before it starts,
so if any of them is wrong, nothing is built.

When nothing has changed since the last build, fabr prints `Already up to date`.

### `test`

Compiles and runs the targets' tests, and prints a summary for each target. The tests run in a
copy of their declared inputs, so they can't change your project directory. Targets are named as
for [`build`](#build).

```sh
fabr test mylib
fabr test -u mylib    # also record new and changed snapshots
fabr test --coverage mylib    # also measure code coverage
```

A passing run is cached and isn't repeated until something the tests depend on changes. With `-u`,
new and changed snapshots are written back into your source tree after a passing run, and each
file is named as it is written. With `--coverage`, the tests are measured for code coverage: a
summary is printed and an lcov report written to `coverage/lcov.info`, or to `<dir>/lcov.info`
with `--coverage=<dir>`; the directory is relative to the current directory. For JavaScript, see [Testing](/reference/js/testing/).

### An operation's name

A rule can give a target type an operation of its own, such as `lint` (see
[Writing your own rules](/guides/rules/#a-rule-for-another-operation)). The operation's name is
then a command that builds targets under it:

```sh
fabr lint app lib
fabr lint -w app
```

`fabr lint app` builds `app` as `fabr build 'app<BUILD_OPERATION=lint>'` does, and takes the same
options as `build`. Any operation a rule's guard names (`<BUILD_OPERATION=lint>`) can be given this
way, and `fabr list-operations` lists them. A word no rule names as an operation
is read as a target name, as before.

An operation's name is a command even where the project also declares a target of that name, as
`build` and `test` are: write `fabr build lint` to build the target, or put it after `--`.

Two such operations come with fabr's plugins, for target types that have a rule for them
(`fabr list-operations` shows which):

- `fabr sources <target>`: the target's sources, such as a `js_package`'s or a `jar_package`'s
  `srcs` and `resources`.
- `fabr doc <target>`: its documentation, such as a `jar_package`'s javadoc.

A package reference from a registry can be read under them too, for what the registry publishes
beside the package: `fabr ls '@mvn:org.slf4j:slf4j-api:1.7.36<BUILD_OPERATION=sources>'` lists
the contents of its `-sources.jar`. A registry that publishes nothing for an operation, as npm
publishes no separate sources or documentation, refuses the reference.

### `run`

Builds a target as a program and runs it. The program has your terminal: its input, output and
exit status are its own. It runs in your current directory, with your environment.

```sh
fabr run mytool --flag arg                    # --flag arg go to the program
fabr run -DBUILD_TYPE=release mytool          # options for fabr go before the target
fabr run @npm:typescript:5.6.3:tsc --version  # a package's command-line program
```

Everything after the target is passed to the program unchanged, including a `--`. Options meant
for fabr go before the target.

A JavaScript program, such as a `js_script`, a `js_package` with a program, or an npm package's
command, runs on the Node.js release the
[`NODE` setting](/reference/js/dependencies/#the-nodejs-version) names, not on the `node` on your
`PATH`; `process.execPath` in the program is that binary. Because the program gets your
environment, a `NODE_OPTIONS` you have set applies to it, and a release older than your own
Node.js may reject an option in it. `fabr run @node:24.22.1:bin/node` runs a Node.js release
itself.

fabr installs the program, with everything it needs, into a directory in its cache, and keeps that
directory for the next run of the same program from the same project with the same `-D` settings:
running it again updates only the files that changed. Two copies of one program running at the same
time each get a directory of their own. An installation that hasn't been used for 30 days is removed
when fabr trims its cache.

A [`serve`](/reference/standard-rules/#serve) target is the exception to "runs in your current
directory": it runs in a directory containing the files it serves. `fabr run -w` restarts the
program, or updates the files it serves, as sources change; see
[Watch mode & dev servers](/guides/watch/).

### `ls`

Builds what the references name and lists the files. `-l` adds each file's content hash and size.

```sh
fabr ls mylib
fabr ls -l 'mylib:*.js'
```

A reference to a package with no version, or to a repository, lists what it contains: an npm
package's published versions, newest first; a catalog's members; or the packages installed in a
scope of `@fabr-home`. Nothing is downloaded or built to list them, and `-l` makes no difference.

```sh
fabr ls @npm:esbuild
fabr ls @pkg
```

npm can't list every package it holds, or every package in a scope, so `fabr ls @npm` and
`fabr ls @npm:@types` are errors; name a package instead, as in `fabr ls @npm:@types/node`.
Likewise `fabr ls @fabr-home` is an error, and `fabr ls @fabr-home:@fabr-build` lists the scope.

### `cat`

Builds what the references name and writes the contents of the files to stdout.

```sh
fabr cat mylib/package.json
fabr cat 'mylib:*.d.ts' > all-types.d.ts
```

A reference that matches no files is an error.

### `cp`

Builds what the references name and copies the files into a directory, which is the last argument
and an ordinary path. Existing files in the directory are kept unless a copied file has the same
name.

Where the files land follows the rules of `cp -R`, applied to the reference as you wrote it:

```sh
fabr cp mylib out                # a whole target      -> out/mylib/…
fabr cp 'mylib:index.js' out     # one file            -> out/index.js
fabr cp 'mylib:build/*.js' out   # a pattern           -> the matching files, directly in out/
fabr cp 'mylib:build/**' out     # everything under it -> out/…, keeping the structure below build/
```

Writing the reference with `/` or `:` makes no difference to `cp`: `mylib/index.js` and
`mylib:index.js` both copy to `out/index.js`. A reference with a
[rename](/reference/syntax/#projection-and-renaming) (`-> template`) is the one case where the
names come from the reference: the files are copied under the names the rename gives them.

### `deps`

Prints the packages each reference depends on, as a tree: one block per reference, with a section
for each property that brings in packages. On a terminal, packages built in your project are shown
in colour.

```sh
fabr deps mylib
```

```
mylib
deps
├── mycore
│   └── undici:^6.19.0 -> 6.19.8
├── chai-as-promised:7.1.1
│   ├── check-error:^1.0.2 -> 1.0.2
│   └── chai:>= 2.1.2 < 5 -> 4.3.6 (p)
└── semver:7.6.3

(p) - provided requirement, bound by the consumer
```

Each line is a package under the name it is installed as. `requested -> selected` shows the
version or range the package above it asks for and the version chosen for the whole tree; a line
with one version asked for exactly that, or, where its reference states none, shows the version chosen. A package built in your project is shown by name alone:
it has no version until it is built.

| Mark | Meaning |
|---|---|
| `(*)` | This package's dependencies are shown where it first appears. |
| `(p)` | A provided requirement (an npm peer dependency): the package is supplied by whatever depends on the one requiring it. |
| `(n)` | Nothing is installed for this requirement, for example an optional peer dependency that no package in the tree supplies. |
| `(!)` | A version that conflicts with another version of the same package in the tree, so building the target fails until you allow both or pin one. The conflicting versions are listed under the tree. |

The tree is the one the target's own build resolves, so it depends on the configuration. A
reference is read under the `build` operation; to see what another operation resolves, such as a
package's `test_deps`, [require it on the reference](/reference/syntax/#constraints):

```sh
fabr deps 'mylib<BUILD_OPERATION=test>'
```

A target type that has no `build` operation and only one of its own (a `js_script` runs, a
`js_test` tests) is read under that one.

A package reference needs no declared target, which answers "what does this package bring with
it" before you add it:

```sh
fabr deps @npm:glob:10.0.0
fabr deps @dep:chai          # a catalog member, at the versions the catalog pins
```

`deps` builds none of the targets it lists and downloads no packages from a registry: it reads
what each target declares and resolves versions exactly as a build would, which needs only each
package's registry metadata. Only the properties that take packages are shown: a target named in
one is listed by its name, whether it builds a package or plain files, and what a property that
takes files names (`srcs`, `resources`) is left out. So are the tools a target runs, such as the
TypeScript compiler or a `generate` target's `run` command, which are installed apart from the
target's own packages. A target with no packages prints `No dependencies`. A reference that selects
files (`mylib:build/*.js`) is an error: name the target.

Two things are still computed, because the dependencies cannot be known without them:

- A `repository_group` route that serves a package from files (`amperize = ./vendor/amperize;`)
  reads that package's `package.json` for its version and dependencies. When those files are a
  downloaded archive it is downloaded, and when they are a target's output that target is built.
  This happens only when something in the tree requires that package.
- A command substitution (`` `…` ``) in a value that names a dependency is run.

### `shell`

Sets up the directory that a target's build step runs in, with its inputs and tools in place,
prints the command the step would run, and opens a shell there. Use it to reproduce a failing step
by hand. The shell has the same empty environment the step has, and the directory is removed when
you exit.

```sh
fabr shell docs_site
```

### `sync`

Builds the packages a [`sync`](/reference/standard-rules/#sync) target lists and publishes them,
each after the packages it depends on. `fabr build` on the same target produces the packages
without uploading them, which is a way to check a release first.

```sh
fabr build release    # produce the packages to be published
fabr sync release     # publish them
```

### `list-targets`

Lists the targets the project declares. Names given as arguments limit the listing to those
targets.

| Option | Adds |
|---|---|
| `-l` | Where each target is declared. |
| `--all` | The targets fabr and its plugins declare themselves, which are normally hidden. |
| `--json` | Output as JSON. |

### `list-targetdefs`

Lists the target types a build file can use, with the properties each takes. A name limits it to
that type.

```sh
fabr list-targetdefs js_package
```

`-l` adds where each is declared, and `--json` gives the output as JSON.

### `list-operations`

Lists every operation the project's rules declare, the standard ones included, with the target
types that have a rule for each, in the order they are declared. `--json` gives the output as JSON.

```
build  generate, patched, sync, fabr_plugin, js_package, js_bundle, js_compile, sass_compile, css_postcss
lint   js_package
run    script, serve, fabr_plugin, js_package, js_script
test   js_package, js_test
```

### `list-properties`

Lists the configuration settings with their current values, and the flags. `-l` adds where each
is declared, and `--json` gives the output as JSON.

### `list-all`

Writes everything the other `list-` commands report, as one JSON document. The
[core](/reference/standard-rules/) and [JavaScript](/reference/js/targets/) reference pages are
generated from it.

## Options

| Option | Applies to | Meaning |
|---|---|---|
| `-DNAME=VALUE` | all | Set a configuration property for this run, overriding the build file and any default. |
| `-w` | `build`, `test`, `run` | Keep running, and rebuild, retest or restart when sources change. See [Watch mode](/guides/watch/). |
| `-u`, `--update` | `test` | Record new and changed snapshots, and write them into your source tree. |
| `--coverage[=DIR]` | `test` | Measure code coverage, print a summary and write `DIR/lcov.info` (`coverage/` by default). |
| `-q`, `--quiet` | all | Don't show the progress display or the output of build steps. A step that fails still shows its output in the error. |
| `--no-progress` | all | Don't show the progress display. Output from build steps is then printed as it arrives, as it is when stderr isn't a terminal. |
| `-l` | `ls`, `list-*` | Long listing: hash and size for `ls`, source location for the `list-` commands. |
| `--json` | `list-*` | Output as JSON. |
| `--all` | `list-targets` | Include the targets fabr and its plugins declare. |
| `--` | all | End of options. What follows is a target, even if it starts with `-` or is the name of a command. |
| `-v`, `--version` | | Print fabr's version. |
| `-h`, `--help` | | Print a summary of the commands and options. |

On a terminal, fabr shows the steps in progress at the bottom of the screen, and holds each step's
output until the step finishes, so that the output of steps running in parallel isn't mixed
together.

## Naming targets and files

An argument that names a target is a **reference**, written as it would be in a build file. The
[language reference](/reference/syntax/#references) describes references in full. On the command
line:

- **A target name** means the target: `mylib`.
- **A path into a target** selects files from what it builds: `mylib/package.json`,
  `'mylib:build/*.js'`. Quote a pattern so that your shell doesn't expand it.
- **A path in your project** names source files, relative to the current directory:
  `fabr ls ./src`.
- **A package reference** needs no declared target: `fabr ls @npm:esbuild:0.28.1`,
  `fabr run @npm:prettier:3.3.3 --check src`.
- **A constraint** builds that one reference with a different setting:
  `'mylib<BUILD_TYPE=release>'`.

Selecting files matters to `ls`, `cat` and `cp`, and to `run`, where it picks which of a package's
programs to run. `build`, `test` and `sync` work on a whole target: naming files, or a path in your
project, is an error.

A constraint is the per-reference form of `-D`. The difference shows when you name more than one
target:

```sh
fabr build 'a<BUILD_TYPE=release>' b       # a and what it depends on as release; b as usual
fabr build -DBUILD_TYPE=release a b        # both as release
```
