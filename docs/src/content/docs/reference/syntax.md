---
title: Language syntax
description: The full syntax of PROJECT.fabr and .fabr build scripts.
---

A fabr build script (`PROJECT.fabr`, and any files it includes) is a small declarative language:
configuration properties, target declarations, and plugin/include directives.

Every name (property or target) is declared exactly once, and order of declaration is unimportant.
All properties and targets are resolved lazily when required to satisfy a build.


## Comments and whitespace

A `#` begins a comment that runs to end of line. Whitespace (spaces, tabs, newlines) is
insignificant except as a token separator.

```
# This is a comment.
JS_TARGET = es2021-commonjs;   # trailing comment
```

## Plugins and includes

`plugin <name>;` loads a rule plugin by package name (resolved by regular module resolution)

```
plugin @fabr-build/js;
```

`include ./<path>.fabr;` includes another script **relative to the including file**. There is no
system include search path; the path must be relative and must not contain variables:

```
include ./targets/frontend.fabr;
```

The path may **glob**, in which case it includes every file that matches.

```
include ./targets/*.fabr;
include ./packages/**/BUILD.fabr;
```

An include must name **at least one file** either way: a pattern matching nothing is an error, as a
plain path that isn't there is. 

Core's standard library (`STD.fabr`) is always present, and each declared plugin's own `.fabr` files
are included automatically — so `plugin @fabr-build/js;` is all you need to get the `js_*` targets
and their configuration.

## Names

The characters a name may contain depend on what it names:

| Name | Allowed characters |
|---|---|
| Property name, target type | letters, digits, `@`, `_` |
| Target name | the above, plus `/`, `.`, `-` |

By convention, global repositories (e.g. `@npm`) are prefixed with `@`, but this is not required.

## References

A reference is a shell-like glob expression plus optional name splitting, renaming, and constraints.

:::note
Direct file references may use `../` (relative to the current fabr file) as long as the resulting path
is still inside the overall project, however (if not otherwise removed already) any `../` will be stripped
from the resulting names. For example:

```
js_script myscript {
  entry = ../scripts/script.ts;  # Yields scripts/script.ts
}
```
:::

### Globbing

Standard shell globbing is supported, plus the recursive '**':

```
srcs = src/*.tsx;              # All files ending in .tsx immediately inside src (not a subdir)
srcs = src/**/*.ts;            # All files ending in .ts anywhere inside src/
deps = lib/*.[jt]s;            # Match both *.js and *.ts using a character class.
```

A name that names a directory is treated as implicitly ending in `/**`:
```
srcs = src;                    # where src is a directory, matches all files in src recursively.
```

Bash's **extended globs** are supported too — one of five leaders followed by a parenthesised
*pattern list*, matching within a single path component. A pattern list is **one or more** patterns
separated by `|`, so `!(node_modules)`, `!(dist|build)` and `!(dist|build|coverage)` are all valid:

| Pattern | Matches |
| --- | --- |
| `?(…)` | zero or one occurrence of any listed pattern |
| `*(…)` | zero or more occurrences |
| `+(…)` | one or more occurrences |
| `@(…)` | exactly one occurrence |
| `!(…)` | anything *except* the listed patterns |

```
srcs = src/!(Validation)/**;        # every file under src/, excluding the Validation subtree
srcs = src/!(dist|build|gen)/**;    # ...excluding three of them
srcs = src/@(api|web)/*.ts;         # only the api and web subtrees
srcs = !(*.test).ts;                # .ts files, excluding .test.ts
```

Each listed pattern is itself a pattern, so wildcards, character classes, nested groups and
`${...}` substitutions all work inside one. A group must be closed — an unterminated `!(` is an
error, not literal text (quote it to name a file that really contains those characters).

### Quoting

Unquoted values may contain letters, digits, `_`, and `/ - . @ :` (plus glob characters
`* ? [ ]` and the extglob `?*+@!( | )`) — enough for paths, references, globs, and versions.
Note that outside an extglob group `( ) | !` are ordinary characters, so a bare leading `!` is a
literal `!` and not a negation. Use quotes when you need spaces or exact bytes:

- **Single quotes** `'…'` are literal (no substitution).
- **Double quotes** `"…"` allow variable substitution and escapes.


### Variable substitution

Variable substitution is `$NAME` or `${NAME}`, in double-quoted and unquoted values:

```
url = "${NPM_REPOSITORY_URL}";
version = ${FABR_VERSION};
```

### Command substitution

Backticks run a command and substitute what it wrote to stdout, for a tool that reports fixed
information — a version, a set of compiler flags:

```
TSC_VERSION = `${TSC} --version`;
```

A backtick expression is a *part* of a value, exactly like `${NAME}`, so it composes with the text
around it and may appear anywhere a variable may — including in double quotes, in a guard, or in a
reference. Single quotes are literal, so ``'`cmd`'`` is a backtick string rather than a command.

```
srcs = build/v`${TSC} --version`/*.js;
```

The output is **trimmed**, and internal runs of whitespace (newlines included) are collapsed to
single spaces — the same text a shell would substitute. A command whose output is genuinely
multi-line wants a [`generate`](#command-property) target and a file instead.

Between the backticks is a command pipeline in the same form as a
[command property](#command-property), so `|` and the redirections work and the command's own words
substitute first. Two differences follow from a substitution's value *being* its stdout:

- A redirection to a name **discards** that stream — the file it would write is unreachable, so
  `2> log` simply silences stderr. Redirecting stdout leaves the substitution with nothing to
  capture, and its value is empty.
- `2>&1` folds stderr into the value, which is otherwise stdout only.

The command runs once and its result is cached against the tool and its arguments, so the same
substitution written in several places costs one run.

The command must name a fabr **runnable** — a target, a global, or a package reference such as
`@npm:typescript:5.4.5:tsc`. A tool that only exists on the host (`cc`, `sed`, etc) cannot be named.

### Constraints

A reference can **require** a configuration, as a `<KEY=value>` facet on the reference:

```
deps = @package/core<TARGET=arm64-apple-darwin24.6.0>;   # Depend on @package/core for the given target
```

Constraints are transitive, ie the above example will also require @package/core's dependencies
to be recursively built under the specified target as well, unless further overridden.


### Projection and renaming

The ':' operator (a *projection*) is used in place of '/' to strip the part of the name before the
':' — the same reference with a `/` instead resolves to the same files, but keeps the whole written
path as their names:

```
srcs = src:lib/index.ts;       # maps src/lib/index.ts to lib/index.ts
```

More general renames are supported using the '->' operator, matching wildcards on both sides:

```
srcs = src/index.ts -> test.ts;
srcs = src/**/*.ts -> bin/**/*.js;
```

Each `*`/`**` in the template replays the same-position wildcard from the selector, so both sides must
use only `*`/`**` (not `?` or `[…]`) and have an equal number of them. The `->` must be spaced, and if
present must be the last part of the reference.

A template with no wildcards at all is exempt: it names one file outright, so the selector may be any
pattern — `srcs = foo/*/bar/index.ts -> index.ts;` names whatever it finds `index.ts`. It has to find
exactly one, since renaming two different files to the same name is a conflict like any other.

A template can also name the wildcards it wants by number, `$1` for the first, `$2` for the second and
so on — the same replay written explicitly. Because each one says which wildcard it takes, the counts
need not match: a numbered template may **reuse** a wildcard, **reorder** them, or leave some out.

```
srcs = v*.tgz -> v$1/node-v$1.tgz;    # $1 twice — impossible positionally
srcs = */*.a -> $2-$1.b;              # reordered
srcs = */*.a -> only-$2.b;            # first wildcard unused
```

The two forms don't mix in one template, and every `$n` must name a wildcard the selector actually has.
(`$1` means a back reference only inside a rename template; anywhere else it is an ordinary
[variable substitution](#variable-substitution).)

These can be applied anywhere, for example `@npm:esbuild:0.2.1:package.json` references the package.json
file directly from the esbuild 0.2.1 package. These results are treated as simple files (ie not as the
package they came from).

`->` renames what the reference delivers, so on a package — with no projection following it — it
renames the package itself: the name it is delivered and mounted under, leaving its content,
version and dependencies alone.

```
deps = @npm:stream-browserify:3.0.0 -> stream;   # sources importing 'stream' get the shim
deps = mylib -> renamedlib;                      # a built package, mounted under another name
```

A projection against a package being run — under fabr run, or via a property that takes a runnable
such as TSC or a serve target's tool — searches the program names the package declares in its
bin as well as its files, so `@npm:typescript:5.4.5:tsc` selects the tsc compiler to run. A package
declaring a single bin needs no projection: that bin is the default entry. One declaring several has no
default, so the reference must name one — typescript declares both tsc and tsserver, and leaving
the projection off will report an error.

### Archives

An archive file can be referenced as if it were a directory: continue the path through it to select
files inside. A reference that stops at the archive is just the file itself.

```
srcs = ./vendor.tgz:*:**;      # everything inside the archive (the * skips the tarball's top-level directory)
data = ./vendor.tgz;           # no path inside it: the tarball itself, as a file
```

Whether a file can be opened this way is decided by its contents, not its name: naming a text file
`notes.tgz` doesn't make it an archive, and a real archive is recognized whatever it's called. The
formats recognized are **tar**, **zip**, and tar under **gzip** or **xz** compression (so `.tgz`,
`.tar.gz` and `.tar.xz` all work, whatever they are named). Archives inside archives work the same
way (`outer.tgz:inner.tgz:**`).

The one thing that never looks inside an archive is `**`. A recursive glob matches the archive as an
ordinary file, so `./**/*.ts` won't pick up `.ts` files packed inside archives it passed along the
way. To search inside archives, the reference needs a path component that matches the archive file
itself — everything after that component then matches its contents:

```
srcs = ./**/*.ts;              # .ts files in the tree; archives are just files here
srcs = ./**/*.tgz/**/*.ts;     # for every .tgz in the tree, the .ts files inside it
```

### Version override markers

When a dependency closure's requirements are jointly unsatisfiable — two parts of the build need
incompatible versions of one package — the conflict is resolved with a one-character marker on an
**exact** version, written wherever the dependency is:

```
deps = @npm:aws-param-store-sdkv3:4.0.0
       @npm:tslib:2.6.2? @npm:tslib:1.14.1?     # both versions may ship: 1.14.1 nests where required
       @npm:tight-peer:2.0.0!;                  # forced: everyone gets this version
```

- `?` **permits a version to ship**. The markers name the *complete* set of versions you allow to
  coexist: the canonical (which stays the flat, shared copy) and each alternate (installed
  *nested* under the specific dependencies whose declared ranges need it, npm-style). A `?` entry
  is not a dependency — it demands nothing and delivers nothing directly — and it matches exactly:
  if either side of the conflict moves to a different version, the build errors again and tells
  you which marker to update. In a `catalog`, an ordinary exact pin of the canonical counts as its
  half of the sanction (`deps = @npm:tslib:2.6.2 @npm:tslib:1.14.1?;`). A `?` also **supplies**
  the version for a package that is required only with unbounded ranges (`@types/node: "*"` and
  friends), where no version is otherwise selectable — again without becoming a dependency.
- `!` **forces a version**: every requirement on the package, from any dependency, is replaced by
  exactly this version (npm's `overrides` semantics) — the tool for a dependency's over-tight
  constraint you judge wrong. Ranges the forced version does not satisfy are overridden silently,
  so prefer `?` (which honors every declared range) unless the constraint itself is the problem.



## Properties

A property assigns one or more values to a name, terminated by `;` (optional after a `{ … }`
block). Global property
declarations are either strings, maps, or commands and are declared as bare key/value pairs:

```
name = value;
```

Default properties are specified with the `default` keyword:

```
default TSC = @npm:typescript:5.4.5:tsc;
```

A default property is used if and only if there is no non-default property with the same name
(typically used by system defaults). The keyword applies to
[target declarations](#target-declarations) in the same way.

Properties can be overridden on the command-line or (locally) through a constraint expression.


### String property
A string property is a white-space separated list of name references (or quoted strings).

```
name = value;
deps = @npm:chai:4.3.6 @npm:@types/chai:4.3.1 @npm:picomatch:2.3.1;
```

### Map properties

A map property is a block of `key = value;` entries, where each value is in turn a string, a sub-map,
or a sequence of maps (as in `maintainers` below):

```
metadata = {
  description = My package;
  license = GPL-3.0-or-later;
  repository = { type = git; url = https://example.com/r.git; };
  maintainers = { name = ann; } { name = bob; };
}
```

You can extend another block-valued property by reference, to splice it into a block —
later entries win, so you can share a base and override per target:

```
COMMON = { license = GPL-3.0-or-later; author = { name = Ann; }; };

metadata = { COMMON; description = This particular package; };
```

Duplicate keys in a map extension are resolved left-to-right (similar to a destructuring operation)

### Command property

A command property (currently used only for generic `generate` rules, but allowed as a global property)
is a shell-like command expression allowing piping and redirection:

```
cmd = my_script -l < src/input.txt | pagination > output.txt;
```

When resolved, each command must be a runnable target, an input redirection takes a name reference that
must resolve to a single file, and output redirections must be a valid file path.

The redirections are:

| Form | Meaning |
| --- | --- |
| `< name` | Feed the first stage's stdin from a reference resolving to a single file. |
| `> name` | Capture stdout as content called `name` (final stage only — an earlier stage's stdout feeds the pipe). |
| `2> name` | Capture stderr as content called `name`. |
| `2>&1` | Send stderr wherever stdout currently goes. `1>&2` is the mirror; those are the only two streams. |
| `&> name` | Capture both together — exactly `> name 2>&1`. |

Redirections apply **in written order**, as in a shell: `> f 2>&1` sends both streams to `f`, while
`2>&1 > f` sends stderr where stdout was going *before* the redirection (so, to fabr's own output)
and only then moves stdout to `f`. Unlike a shell, redirecting the same stream twice is an error
rather than the last one quietly winning.

A stream that is not redirected is reported by fabr as the target's output, and is shown if the
command fails.


### Guarded properties

A property declaration may carry a **guard** — the same `<KEY=value>` facet a
[reference](#constraints) carries, written on the *declaration* instead of on a *use*. Position
decides what it means: on a use it is a **requirement** (the configuration that reference is built
under); on a declaration it is a **guard** (the configuration this declaration applies in), so the
declaration participates only where it matches. Guard values are patterns — a requirement takes an
exact value, and writing a pattern there is an error suggesting this form:

```
library platform_io {
  srcs = src/**/*.c;
  srcs<TARGET=*-linux-*> = src/epoll/**/*.c;
  srcs<TARGET=*-apple-*> = src/kqueue/**/*.c;
  deps<TARGET=*-linux-*> = @npm:epoll-native:1.2.0;
}
```

Several keys in one guard are a conjunction (`<TARGET=*-linux-*, BUILD_TYPE=release>`);

**Every matching declaration contributes.** For a files property they combine, exactly as the
values of a single declaration do — above, a linux build gets the common sources *and* the epoll
ones. Guards are never ranked against each other: there is no "most specific wins", because
patterns do not order (`*-linux-*` and `aarch64-*` are simply incomparable). For a property read
as a single value, two matching declarations are therefore an error naming both guards, not a
silent choice between them — make the guards disjoint, or put the fallback in the targetdef's
[declared default](#property-defaults), which supplies the property whenever no guard matched.

A guard can also be written once over a block of declarations, which is purely shorthand for
writing it on each of them:

```
js_package mylib {
  srcs = src/**/*.ts;
  <TARGET=*-linux-*> {
    srcs = src/linux/**/*.ts;
    deps = @npm:epoll-native:1.2.0;
  }
}
```

Guards apply to global properties in the same way, at file scope. There a `default` declaration is
the fallback: it supplies the property when no ordinary declaration matched. A global written only
under guards that all miss is an error saying so — it is declared, just not here.

## Target declarations

A target is declared as `<type> <name> { <properties> }`:

```
js_package mylib {
  srcs = src:**/*.ts;
  deps = @npm:lodash:4.17.21;
  tests = src:**/*.test.ts;
}
```

The `<type>` must be a targetdef provided by core or a loaded plugin. The `<name>` is how the target
is referenced elsewhere and on the command line.

A declaration may be prefixed with `default`, exactly as a [property](#properties) may:

```
default js_script test-runner { entry = ...; }
```

A default target is used if and only if there is no non-default declaration of that name — so a
build script can replace one a plugin or standard library ships simply by declaring its own. Two
default declarations of the same name still conflict, and a default declaration is validated
against its targetdef whether or not it ends up being used.

## Targetdef declarations

A `targetdef` declares a new *target type* and the schema of properties that targets of that type
accept. Core and loaded plugins provide the standard targetdefs (see the
[Core reference](/reference/standard-rules/) and [JavaScript reference](/reference/js-rules/)); you can
also declare your own in a build script.

```
targetdef script {
  entry = REQUIRED FILES;
  deps  = FILES;
  args  = STRING;
}
```

Each entry is `<property> = <kind…>;`, where the kinds combine on one line — `REQUIRED FILES` marks a
mandatory files property. A `*` key, in place of a property name, types every *otherwise-undeclared*
property, for target types whose set of properties is open-ended (e.g. `sync`'s reference-keyed
members):

```
targetdef sync {
  * = FILES;
}
```

### Property kinds

| Kind | Meaning |
|---|---|
| `STRING` | A scalar text value (supports substitution). |
| `FILES` | One or more references/globs, resolved to a set of files. |
| `MAP` | A block of `key = value;` entries (see [Map properties](#map-properties)). |
| `COMMAND` | A shell-like command pipeline (see [Command property](#command-property)). |
| `REWRITE` | Name-rewriting rules (`selector -> template`); see [Projection and renaming](#projection-and-renaming). |
| `REQUIRED` | A modifier marking a property as mandatory. |

`MAP`, `COMMAND`, and `REWRITE` are enforced — they constrain the *shape* the value may take (a block,
a pipeline, a rename template), and `REQUIRED` is checked for presence. `STRING` versus `FILES`,
however, is currently only a **hint**: it documents whether a property is meant to carry scalar text or
file references, but is not enforced — the rule that consumes the property decides how to interpret it.

### Property defaults

A kind may be followed by `default` and a value, supplying the property for every target of the type
that doesn't write one of its own:

```
targetdef script {
  entry   = REQUIRED FILES;
  args    = STRING default --quiet;
  outputs = FILES default *.js;
}
```

A default takes the full value syntax — references, globs, `${...}` substitution, and `{ ... }` blocks
for a `MAP` — and is resolved lazily, only where the property is actually read. Relative paths in a
default are rooted at the file that declares the targetdef, not at the one using it, so a plugin can
ship defaults that point at its own files. `${...}` substitution, by contrast, reads globals as
resolved for the *using* target, so a default can pick up build settings like `${BUILD_TYPE}`.

`REQUIRED` and `default` are mutually exclusive: a default supplies the property whenever it is
unwritten, leaving nothing for `REQUIRED` to demand, so declaring both is an error. The `*` wildcard
cannot carry a default either — it types only the keys a target actually writes, so there is no
unwritten property for a default to supply.

Defaults also apply where a rule builds an internal sub-target of the type without supplying that
property — so a defaulted property behaves the same however the target came about. A rule that means
to suppress a default passes an explicit empty value rather than omitting the property.
