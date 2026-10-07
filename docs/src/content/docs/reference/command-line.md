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
| [`run`](#run) | Build a program and run it. |
| [`ls`](#ls), [`cat`](#cat), [`cp`](#cp) | List, print or copy the files a target produces. |
| [`shell`](#shell) | Open a shell in the directory a build step runs in, for debugging. |
| [`sync`](#sync) | Publish packages. |
| [`list-targets`](#list-targets), [`list-targetdefs`](#list-targetdefs), [`list-properties`](#list-properties), [`list-all`](#list-all) | Describe the project and what a build file can contain. |

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

When nothing has changed since the last build, fabr prints `Already up to date`.

### `test`

Compiles and runs the targets' tests, and prints a summary for each target. The tests run in a
copy of their declared inputs, so they can't change your project directory.

```sh
fabr test mylib
fabr test -u mylib    # also record new and changed snapshots
```

A passing run is cached and isn't repeated until something the tests depend on changes. With `-u`,
new and changed snapshots are written back into your source tree after a passing run, and each
file is named as it is written. For JavaScript, see [Testing](/reference/js/testing/).

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

### `list-properties`

Lists the configuration settings with their current values, and the flags. `--json` gives the
output as JSON.

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
programs to run. `build`, `test` and `sync` work on the whole target and ignore it.

A constraint is the per-reference form of `-D`. The difference shows when you name more than one
target:

```sh
fabr build 'a<BUILD_TYPE=release>' b       # a and what it depends on as release; b as usual
fabr build -DBUILD_TYPE=release a b        # both as release
```
