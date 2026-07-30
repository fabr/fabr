---
title: Command line
description: The fabr CLI — its commands, options, and how targets and files are named on the command line.
---

Fabr is driven by a single `fabr` command:

```sh
fabr [command] [options] <targets…>
```

The command defaults to `build`, so `fabr mylib` is `fabr build mylib`. Diagnostics and progress go to
**stderr**; a command's *data* output — a `cat`'s file bytes, an `ls` listing — goes to **stdout**, so
the data can be piped cleanly away from the noise.

All fabr commands run inside the context of the current project, that is, the nearest PROJECT.fabr file
found to the current working directory. 

## Commands

### `build`

Build the given targets (the default). Each target's result is produced into the cache; nothing is
written to your working tree.

```sh
fabr build mylib
fabr mylib            # build is the default
```

### `test`

Compile and run the targets' tests, reporting the results.

```sh
fabr test mylib
```

### `run`

Build a target as a runnable and execute it with inherited stdio (tty, pipes, exit code all pass
through). Everything **after** the target is passed to the program verbatim — put fabr's own options
*before* the target. The target runs in the current working directory and with the active environment.

```sh
fabr run mytool --flag arg                 # --flag arg go to the program
fabr run @npm:typescript:5.4.5:tsc --version
```

### `shell`

Stage a target's build sandbox — its resolved inputs and tool mounts, exactly as the build step sees
them — into a temporary directory, print the command the step would run, and open a shell there. For
debugging a build step (a genrule, a compile) by hand. The shell runs with the build's own clean
environment; the directory is removed on exit.

```sh
fabr shell docs_site
```

### `ls`

Build the given names and list the files they resolve to. `-l` adds each file's hash and size.

```sh
fabr ls mylib
fabr ls -l 'mylib:*.js'
```

### `cat`

Build a target and write its matching files' bytes to **stdout**, so you can inspect or pipe them.

```sh
fabr cat 'mylib:index.js'
```

### `cp`

Build the given names and copy their files into a destination directory (the final argument, a plain
filesystem path relative to your working directory). Additive, and a copy rather than a hard-link, so
it never writes through a cache blob.

`cp` follows **`cp -R`'s rules exactly** and is never package-aware: whether the files land flat or
under a subdirectory is decided by the reference *as written*, exactly as a shell path would decide
it.

```sh
fabr cp mylib build/             # names a container -> build/mylib/…
fabr cp 'mylib:index.js' out     # names one file    -> out/index.js
fabr cp 'mylib:build/*.js' out   # a glob -> the matched files land directly in out/
fabr cp 'mylib:build/**' out     # a subtree -> out/…, the structure below build/ kept
```

If the reference carries a [rename](/reference/syntax/#projection-and-renaming) (`-> tmpl`), that is
the naming: the files are copied under the names it produced and none of the above applies.

Whether you write the path with a `:` or a `/` makes no difference here. The separator decides what
the resolved files are *named* — a `:` strips what precedes it, a `/` keeps the whole written path,
which is what `ls` shows you — but `cp` copies *from* the path as written either way, so both forms
land the same files in the same places.

### `sync`

Build a `sync` target's members and publish them to their destination coordinates (e.g. an npm
registry). Building the target is the cacheable dry run; `sync` performs the upload, dependencies
first.

```sh
fabr sync release
```

### `list-targets`

List the targets declared in the project. `-l` adds each target's source location; `--all` includes
the internal targets normally hidden (those declared by core and plugin libraries); `--json` emits
structured data. An optional list of names filters the listing.

### `list-targetdefs`

List the available target *types* and their property schema. `-l` for source locations, `--json` for
structured data. An optional name filters to specific types.

```sh
fabr list-targetdefs js_package
```

### `list-properties`

List the global configuration properties (with their defaults) and the flag switches. `--json` for
structured data.

### `list-all`

Emit the whole build vocabulary — types, properties, and flags — as one JSON document, for tooling
(fabr's own documentation is generated from it). Always JSON.

## Options

| Option | Meaning |
|---|---|
| `-DPROP=VALUE` | Force property `PROP` to `VALUE` for this run (overrides the build script and any default). |
| `-w` | Watch mode: rebuild — and, for `run`, restage/relaunch when sources change. |
| `-q`, `--quiet` | Suppress the live subcommand output otherwise streamed as steps run; a *failed* step still shows its captured output. |
| `-l` | Long listing: hash + size per file (`ls`), or source location (`list-*`). |
| `--json` | Emit JSON (the `list-*` verbs). |
| `--all` | Include internal targets in `list-targets`. |
| `-v`, `--version` | Print the fabr version and exit. |
| `-h`, `--help` | Print usage and exit. |
| `--` | End option parsing — everything after is a positional, so a target may begin with `-` or be spelled like a command. |

## Naming targets and files

Every target you name — on `build`, `test`, `run`, `shell`, `ls`, `cat`, `cp`, `sync` — is a whole
**reference**, parsed exactly as in a build script. See the [language syntax](/reference/syntax/) for
the full grammar. Two parts of a reference apply on the command line:

- A **`:projection`** selects and renames files out of the resolved result — `pkg:build/*.js` selects
  `build/*.js` out of target `pkg`, `golden:*.expect -> *.out` renames as it selects, and an external
  requirement such as `@npm:esbuild:0.28.1:package.json` resolves too. Projections are meaningful only
  for the file-listing verbs (`ls`, `cat`, `cp`) and for picking a runnable's entry (`run`); the
  whole-target verbs (`build`, `test`, `sync`) build the entire target and ignore any projection.
- A **`<KEY=VALUE>` constraint** applies a build-config override to just that reference — the
  per-reference form of `-D` (which sets the property for the *whole* run). It works everywhere a
  target is named. See [Constraints](/reference/syntax/#constraints).

The difference between a constrained reference and `-D` only shows when you name more than one target:

```sh
fabr build 'a<BUILD_TYPE=release>' b       # a (and its deps) as release; b at the default
fabr build -DBUILD_TYPE=release a b        # both a and b as release
```
