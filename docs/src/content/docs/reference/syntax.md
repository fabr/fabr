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

### Quoting

Unquoted values may contain letters, digits, `_`, and `/ - . @ :` (plus glob characters `* ? [ ]`) —
enough for paths, references, globs, and versions. Use quotes when you need spaces or exact bytes:

- **Single quotes** `'…'` are literal (no substitution).
- **Double quotes** `"…"` allow variable substitution and escapes.


### Variable substitution

Variable substitution is `$NAME` or `${NAME}`, in double-quoted and unquoted values:

```
url = "${NPM_REPOSITORY_URL}";
version = ${FABR_VERSION};
```

### Constraints

A reference can be constrained under one or more properties:

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

These can be applied anywhere, for example `@npm:esbuild:0.2.1:package.json` references the package.json
file directly from the esbuild 0.2.1 package. These results are treated as simple files (ie not as the
package they came from).

A projection against a package being run — under fabr run, or via a property that takes a runnable
such as TSC or a serve target's tool — searches the program names the package declares in its
bin as well as its files, so `@npm:typescript:5.4.5:tsc` selects the tsc compiler to run. A package
declaring a single bin needs no projection: that bin is the default entry. One declaring several has no
default, so the reference must name one — typescript declares both tsc and tsserver, and leaving
the projection off will report an error.

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

Default properties are used if and only if there is no non-default property with the same name.
(typically used by system defaults).

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
