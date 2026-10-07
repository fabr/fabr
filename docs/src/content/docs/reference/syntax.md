---
title: Language syntax
description: The syntax of PROJECT.fabr and the .fabr files it includes — references, properties, targets and target types.
---

A fabr build file (`PROJECT.fabr`, and any files it includes) is written in a small declarative
language. It has four kinds of statement:

| Statement | Example | Section |
|---|---|---|
| Load a plugin or another file | `plugin @fabr-build/js;` | [Plugins and includes](#plugins-and-includes) |
| Set a property | `JS_TARGET = es2022-esm;` | [Properties](#properties) |
| Declare a target | `js_package mylib { srcs = src:**/*.ts; }` | [Target declarations](#target-declarations) |
| Define a target type | `targetdef mytype { srcs = FILES; }` | [Targetdef declarations](#targetdef-declarations) |

Most of what you write inside them is [references](#references): the patterns that name files,
targets and packages.

Two rules apply throughout. Every name, whether a property or a target, is declared once. And the
order of declarations doesn't matter: a name can be used before the line that declares it, and
nothing is worked out until a build needs it.

## Comments and whitespace

A `#` starts a comment that runs to the end of the line. Spaces, tabs and newlines only separate
words.

```
# This is a comment.
JS_TARGET = es2021-commonjs;   # so is this
```

A comment directly above a property, target or target type is its documentation: `fabr
list-targetdefs` and `fabr list-properties` show it.

## Plugins and includes

`plugin <package>;` loads a plugin, by the name of the npm package that provides it. The package
has to be installed alongside fabr.

```
plugin @fabr-build/js;
```

Loading a plugin makes its target types and settings available; nothing else needs including.
Fabr's own standard definitions are always available.

`include <path>;` reads another build file, by a path relative to the file containing the
`include`:

```
include ./targets/frontend.fabr;
include ./packages/*/BUILD.fabr;
```

The path can be a pattern, which includes every file that matches. It can't contain a `${…}`
substitution, and it must name at least one file: a path that doesn't exist and a pattern that
matches nothing are both errors.

## Names

| Name | Characters allowed |
|---|---|
| Property, target type | letters, digits, `_`, `@` |
| Target | the same, plus `/`, `.`, `-` |

Registries and catalogs are conventionally named with a leading `@` (`@npm`, `@pkg`), which isn't
required.

## References

A reference names files. It can be a path or a pattern in your source tree, a target, a package in
a registry, or a selection of files from any of those:

```
srcs = src/index.ts;                  # a file
srcs = src/**/*.ts;                   # a pattern
deps = mylib;                         # a target
deps = @npm:lodash:4.17.21;           # a package in a registry
srcs = mylib:build/*.js;              # files selected from a target
```

A path is relative to the build file it is written in. It can use `../` to reach files elsewhere
in the project, but not outside it. A name that is both a target and a directory means the target;
write `./name` for the directory.

### Globbing

Shell glob patterns work, along with `**` to match across directories:

```
srcs = src/*.tsx;              # .tsx files directly in src
srcs = src/**/*.ts;            # .ts files anywhere under src
deps = lib/*.[jt]s;            # .js and .ts files, using a character class
srcs = src;                    # a directory: everything under it
```

Bash's extended globs are supported too. Each is a prefix character followed by a parenthesised
list of one or more patterns separated by `|`, and matches within one path component:

| Pattern | Matches |
| --- | --- |
| `?(…)` | zero or one of the listed patterns |
| `*(…)` | zero or more |
| `+(…)` | one or more |
| `@(…)` | exactly one |
| `!(…)` | anything except the listed patterns |

```
srcs = src/!(generated)/**;         # everything under src except the generated directory
srcs = src/!(dist|build|gen)/**;    # ...except three directories
srcs = src/@(api|web)/*.ts;         # only the api and web directories
srcs = src/!(*.test).ts;            # .ts files other than .test.ts
```

The patterns in a list can themselves contain wildcards, character classes, further groups and
`${…}` substitutions. An unclosed group, such as `!(` with no `)`, is an error.

### Quoting

An unquoted value can contain letters, digits, `_`, and `/ - . @ :`, the glob characters
`* ? [ ]`, and the extended-glob forms above. Outside an extended glob, `(`, `)`, `|` and `!` are
ordinary characters, so a leading `!` on its own doesn't negate anything.

Quote a value that contains spaces or any other character:

- **Single quotes** `'…'` take the text as it is.
- **Double quotes** `"…"` allow `${…}` substitution and backslash escapes.

### Variable substitution

`$NAME` or `${NAME}` is replaced by the value of a property, in unquoted and double-quoted values:

```
VERSION = 2.4.0;
url = "https://example.com/releases/v${VERSION}/";
deps = @npm:my-package:${VERSION};
```

### Command substitution

Backticks run a command and are replaced by what it prints, for information that comes from a
tool, such as its version:

```
TSC_VERSION = `@npm:typescript:5.6.3:tsc --version`;
```

Like `${NAME}`, a backtick expression is one part of a value. It can be joined to the text around
it and used anywhere a substitution can be, including inside double quotes and inside a reference.
Inside single quotes it is ordinary text.

```
srcs = generated/`version_tool --short`/*.js;
```

- **The command must be something fabr can run**: a runnable target, a property naming one, or a
  package such as `@npm:typescript:5.6.3:tsc`. A program that exists only on your machine, such as
  `cc` or `sed`, can't be named.
- **The output is trimmed**, and runs of whitespace inside it, newlines included, become single
  spaces, as a shell does. For output of several lines, use a
  [`generate`](/reference/standard-rules/#generate) target and read the file it produces.
- **The command is run once** for a given tool and arguments, however many places use it, and the
  result is cached.

The command is a pipeline as in a [command property](#command-property), so `|` and redirections
work. Because the value is the command's stdout, a redirection to a file name discards that
stream (`2> log` silences stderr), and `2>&1` includes stderr in the value.

### Constraints

`<NAME=value>` after a reference asks for that reference to be built with a setting changed:

```
deps = core<TARGET=arm64-apple-macosx15.0>;      # core, built for another platform
srcs = mylib<JS_TARGET=es2022-esm>:*.js;         # mylib's .js files, built as ES modules
deps = other<BUILD_TYPE=release, JS_TARGET=es2022-esm>;
```

The `<` follows the name directly, before any `:` or `/` selection. The setting applies to the
target and to everything it depends on, unless one of those references sets it again. The rest of
the build is unaffected, so the same target can be built several ways in one build.

The same notation on the left of a property declaration means something different; see
[Guarded properties](#guarded-properties).

### Projection and renaming

A reference decides what its files are named as well as which files they are. Written with `/`,
the names keep the whole path. A `:` in place of a `/` drops everything before it:

```
srcs = src/lib/index.ts;       # named src/lib/index.ts
srcs = src:lib/index.ts;       # named lib/index.ts
```

Selecting files from a target or a package works the same way: `mylib:build/*.js`,
`@npm:esbuild:0.28.1:package.json`. What you get is those files only, not the package they came
from.

`->` renames. Each `*` and `**` in the template on the right takes what the wildcard in the same
position on the left matched:

```
srcs = src/index.ts -> main.ts;
srcs = src/**/*.ts -> lib/**/*.mts;
```

- The `->` has spaces around it and comes last in the reference.
- Both sides use only `*` and `**` as wildcards, not `?` or `[…]`, and the same number of them.
- A template with no wildcard names one file, so the left side can be any pattern that matches
  exactly one: `srcs = vendor/*/dist/index.js -> vendor.js;`. Matching two files is an error,
  since both would get the same name.

A template can instead refer to the wildcards by number, `$1` for the first and so on. The counts
then needn't match, so a numbered template can repeat a wildcard, reorder them or leave one out:

```
srcs = v*.tgz -> v$1/node-v$1.tgz;    # the first wildcard, twice
srcs = */*.a -> $2-$1.b;              # reordered
srcs = */*.a -> only-$2.b;            # the first one unused
```

The two styles can't be mixed in one template. Outside a rename template, `$1` is an ordinary
[variable substitution](#variable-substitution).

**Renaming a package.** When `->` follows a whole package, with no files selected from it, it
renames the package: the name it is installed and imported under. Its contents, version and
dependencies don't change.

```
deps = @npm:stream-browserify:3.0.0 -> stream;   # code importing "stream" gets this package
deps = mylib -> renamedlib;
```

**Choosing a program.** Where a reference is run, by `fabr run` or as a property that takes a
program such as a `serve` target's `tool`, selecting from a package looks among the package's
command-line programs as well as its files. `@npm:typescript:5.6.3:tsc` is the `tsc` program. A
package with one program needs no selection. A package with several, as `typescript` has `tsc` and
`tsserver`, must have one named.

### Archives

An archive can be read as if it were a directory, by continuing a reference into it. A reference
that stops at the archive is the archive file itself.

```
srcs = ./vendor.tgz:*:**;      # everything in the archive, below its top-level directory
data = ./vendor.tgz;           # the archive, as one file
```

Tar and zip archives are recognised, and tar compressed with gzip or xz, so `.tgz`, `.tar.gz`,
`.tar.xz` and `.zip` all work. Recognition is by a file's contents, not its name. An archive
inside an archive can be read the same way (`outer.tgz:inner.tgz:**`).

`**` doesn't look inside archives. `./**/*.ts` finds `.ts` files in your tree and treats any
archive it passes as a file. To look inside, the reference has to match the archive itself with
one of its components:

```
srcs = ./**/*.ts;              # .ts files in the tree
srcs = ./**/*.tgz/**/*.ts;     # the .ts files inside every .tgz in the tree
```

### Version override markers

A package version in a reference can end in `?` or `!`, to resolve a conflict between the versions
that different parts of a build require. Both need an exact version, and both can be written
wherever dependencies are listed: in a target's `deps` or in a catalog.

```
deps = @npm:aws-param-store-sdkv3:4.0.0
       @npm:tslib:2.6.2? @npm:tslib:1.14.1?     # both versions of tslib are allowed
       @npm:some-package:2.0.0!;                # every requirement on it becomes 2.0.0
```

**`?` allows a version.** A build normally uses one version of each package, and fails when the
requirements can't agree on one. Listing each version involved with a `?` lets them all be used:
each package gets the version its own requirement accepts, as it would under npm.

- The entries name the complete set of versions allowed. If a later change makes the build need a
  different version, it fails again and says which entry to update.
- An entry is not a dependency. It doesn't add the package to the target.
- In a catalog, an ordinary exact entry counts as allowing that version:
  `deps = @npm:tslib:2.6.2 @npm:tslib:1.14.1?;`.
- A `?` also supplies a version for a package that is only ever required as `*`, which otherwise
  has no version to select.

**`!` forces a version.** Every requirement on the package, from any dependency, is replaced by
exactly this version, as npm's `overrides` does. Requirements it doesn't satisfy are overridden
without a warning, so use it when a dependency's requirement is wrong, and `?` otherwise.

[Dependencies](/reference/js/dependencies/#when-versions-conflict) shows the error that prompts
these and how to choose between them.

## Properties

A property gives a name a value, and ends with `;`:

```
name = value;
```

At the top level of a build file a property is global: a configuration setting, or a value to
reuse. Inside a target it is one of that target's inputs. The value is a
[string](#string-properties), a [map](#map-properties) or a [command](#command-property).

A global property can be set from outside the build file: for one run with `-DNAME=value` on the
command line, or for one reference with a [constraint](#constraints).

### Default properties

`default` declares a value to use only when nothing else declares the property:

```
default TYPESCRIPT = @npm:typescript:5.6.3;
```

Fabr and its plugins declare their settings this way, which is why a build file can set
`TYPESCRIPT` itself without that being a second declaration of the name.

### String properties

A string property is one or more words separated by whitespace. Each word is a reference or a
quoted string:

```
version = 1.4.0;
description = "A small example";
deps = @npm:chai:4.3.6 @npm:@types/chai:4.3.1 @npm:picomatch:2.3.1;
```

A property that lists references can be used by name where references are expected, which is how
a list of dependencies is shared:

```
TEST_LIBS = @npm:chai:4.3.6 @npm:@types/chai:4.3.1;

js_package mylib {
  srcs = src:**/*.ts;
  test_deps = TEST_LIBS;
}
```

### Map properties

A map is a block of `key = value;` entries. A value is a string, another map, or several maps one
after another, which make a list:

```
metadata = {
  description = My package;
  license = GPL-3.0-or-later;
  repository = { type = git; url = https://example.com/r.git; };
  maintainers = { name = ann; } { name = bob; };
}
```

The `;` after a closing `}` is optional.

Naming another map inside a block includes its entries. Entries are applied in the order written
and a later one replaces an earlier one with the same key, so a shared map can be extended or
overridden:

```
COMMON = { license = GPL-3.0-or-later; author = { name = Ann; }; };

metadata = { COMMON; description = This particular package; };
```

### Command property

A command is a pipeline, written much as in a shell. A [`generate`](/reference/standard-rules/#generate)
target's `run` is one, and so is the inside of a [command substitution](#command-substitution).

```
run = my_script -l < src/input.txt | paginate > output.txt;
```

Each command is something fabr can run: a runnable target, or a package with a command-line
program. Programs on your machine can't be named. The arguments are words, and a pattern among
them is expanded against the target's input files.

| Form | Meaning |
| --- | --- |
| `a \| b` | Send `a`'s stdout to `b`'s stdin. |
| `< name` | Read the first command's stdin from a reference that names one file. |
| `> name` | Keep stdout as a file called `name`. Only on the last command, since an earlier one's stdout goes to the pipe. |
| `2> name` | Keep stderr as a file called `name`. |
| `2>&1` | Send stderr wherever stdout is going at that point. `1>&2` is the reverse. |
| `&> name` | Keep both in one file: the same as `> name 2>&1`. |

Redirections apply in the order written, as in a shell: `> f 2>&1` sends both streams to `f`,
while `2>&1 > f` sends stderr to where stdout was going before, and then stdout to `f`. Unlike a
shell, redirecting the same stream twice is an error.

A stream that isn't redirected is shown as the step's output, and included in the error if the
command fails.

In a `generate` target, the files that redirections keep are the target's result. If the target
sets `output`, that chooses the result instead, from those files and from any files the commands
wrote, and a kept file it doesn't match is left out. A kept file and a written file with the same
name is an error.

### Guarded properties

A property declaration can have a **guard**: `<NAME=pattern>` after the property's name. The
declaration then applies only in builds where the setting matches.

```
js_package watcher {
  srcs = src:*.ts;
  srcs<TARGET=*-linux-*> = src:linux/**/*.ts;
  srcs<TARGET=*-apple-*> = src:macos/**/*.ts;
  deps<TARGET=*-apple-*> = @npm:fsevents:2.3.3;
}
```

A build for Linux gets the common sources and the Linux ones; a build for macOS gets the common
sources, the macOS ones and `fsevents`.

- **A guard's value is a pattern**, matched against the setting's value. Several settings in one
  guard must all match: `<TARGET=*-linux-*, BUILD_TYPE=release>`.
- **Every declaration that matches applies.** For a property that lists files, the matching
  declarations are combined. There is no "most specific guard wins".
- **A property with a single value can have only one match.** Two guarded declarations of `version`
  that both match are an error naming both, so write guards for such a property that can't
  overlap.
- **When no declaration matches, the property is unset**, and the target type's
  [default](#property-defaults) applies if it has one.

This is the notation of a [constraint](#constraints) in a different place, with a different
meaning. After a reference it *requires* a setting, and takes an exact value. After a property
name being declared it *tests* a setting, and takes a pattern.

A guard can be written once around several declarations:

```
js_package watcher {
  srcs = src:*.ts;
  <TARGET=*-apple-*> {
    srcs = src:macos/**/*.ts;
    deps = @npm:fsevents:2.3.3;
  }
}
```

Global properties can be guarded in the same way. For those, a `default` declaration is what
applies when no guarded declaration matches; a property declared only under guards, none of which
match, is an error.

## Target declarations

A target is declared as `<type> <name> { <properties> }`:

```
js_package mylib {
  srcs = src:**/*.ts;
  deps = @npm:lodash:4.17.21;
  tests = src:**/*.test.ts;
}
```

The type is one that fabr's core or a loaded plugin defines; the reference pages for
[core](/reference/standard-rules/) and [JavaScript](/reference/js/targets/) list them with their
properties. The name is how the target is referred to, in build files and on the command line.

A target can be declared `default`, like a property:

```
default js_script lint_tool { entry = tools/lint.js; }
```

A default target is used only if no other declaration has its name. A plugin declares the tools it
supplies this way, so that a project can replace one by declaring a target with the same name. Two
default declarations of one name are still an error.

## Targetdef declarations

`targetdef` defines a target type: the properties its targets take. Fabr's core and its plugins
define the standard ones.

```
targetdef script {
  entry = REQUIRED FILES;
  deps  = FILES;
  args  = STRING;
}
```

Building a target needs a rule for its type, and rules come from plugins, so defining a type in a
build file is mostly useful alongside a plugin that supplies its rules. Writing plugins is
described in `PLUGINS.md` in the fabr repository.

Each entry is `<property> = <kind>;`. A `*` in place of a property name gives a kind to every
property not otherwise listed, for types whose targets take arbitrary keys:

```
targetdef sync {
  * = FILES;
}
```

### Property kinds

| Kind | The value is |
|---|---|
| `STRING` | Text. |
| `FILES` | References, which become a set of files. |
| `MAP` | A block of `key = value;` entries; see [Map properties](#map-properties). |
| `COMMAND` | A command pipeline; see [Command property](#command-property). |
| `REWRITE` | Renaming rules written `pattern -> template`; see [Projection and renaming](#projection-and-renaming). |
| `REQUIRED` | Not a kind but a modifier, written before one: the property must be set. |

`MAP`, `COMMAND` and `REWRITE` are checked: a value of the wrong form is an error, as is a missing
`REQUIRED` property. `STRING` and `FILES` are not told apart when a build file is read. They
document what a property is for, and the rule that reads the property decides how to treat its
value.

### Property defaults

A kind can be followed by `default` and a value, which a target of the type gets when it doesn't
set the property:

```
targetdef script {
  entry   = REQUIRED FILES;
  args    = STRING default --quiet;
  outputs = FILES default *.js;
}
```

- A default can be anything the property itself could be set to, including references, `${…}`
  substitutions and a `{ … }` block for a `MAP`.
- A relative path in a default is relative to the file that defines the type, not to the file
  declaring the target, so a plugin's defaults can refer to the plugin's own files.
- A `${…}` in a default is replaced with the value the setting has for the target being built, so
  a default can follow `${BUILD_TYPE}`.
- `REQUIRED` and `default` can't be combined, and a `*` entry can't have a default.
