---
title: Running your own tools
description: Declare the programs, code generators, checks, archives and dev servers that your package.json scripts, Makefile rules and Maven or Gradle plugins ran, as fabr targets.
---

Compiling, bundling, testing and publishing are covered by the rules that come with fabr and its
plugins. Everything else your project's build did — the code generator in a `prebuild` script, a
Makefile rule that runs `sed` over a template, the Maven plugin that runs a Java tool, the
`npm run dev` server — you declare as targets of a few general-purpose types. Each one names the
program to run, what it reads and what it produces, so fabr can cache the result, rerun it only
when its inputs change, and use its output as an input to your other targets.

## Coming from npm scripts, Make, Maven or Gradle

| With your current tools | In fabr |
|---|---|
| `"build": "tsc"`, `"test": "jest"` | No target of your own: `fabr build` and `fabr test` on the `js_package` (see [Migrating an npm, Yarn or pnpm project](/guides/migrating-js/)). |
| `npm run <script>` that starts a program, `make deploy` | A [`script` or `js_script`](#programs-you-run) target, started with `fabr run`. |
| `npx prettier --write .` | `fabr run @npm:prettier:3.3.3 --write .`; see [Running a package's program](#running-a-packages-program). |
| A `prebuild` script or Makefile rule that writes a file the build uses | A [`generate`](#build-steps-and-code-generation) target, named in the `srcs` of the target that uses it. |
| `exec-maven-plugin`, `maven-antrun-plugin`, a Gradle `Exec` or `JavaExec` task | A [`generate`](#build-steps-and-code-generation) target, with a [`java_program`](/reference/java/running/#java-tools-in-a-build) as its command for a Java tool. |
| `build-helper-maven-plugin`'s `add-source` | Name the `generate` target's output in the consuming target's `srcs`; see [Using the result in another target](#using-the-result-in-another-target). |
| A recipe that runs `sed`, `protoc` or another program installed on the machine | A `generate` command naming the program through [`@host`](#programs-on-your-machine). |
| `"lint": "eslint ."`, `prettier --check` | A `generate` target that [checks rather than produces](#a-step-that-checks). |
| `patch-package`, `pnpm patch` | A [`patched`](#patching-a-dependency) target. |
| `zip -r dist.zip dist`, `maven-assembly-plugin` | A [`zip`](#archives) target. |
| `"dev": "vite"`, `webpack serve` | A [`serve`](#dev-servers) target, run with `fabr run -w`. |
| `curl -o` in a script to download a file | A [`fetch`](/reference/standard-rules/#fetch) repository, with the file's hash. |

Fabr runs nothing implicitly: there is no `prebuild` or `postinstall` hook. A step runs because
another target names its result, or because you asked for it on the command line.

## Programs you run

A program you start yourself, as you would with `npm run migrate` or `make deploy`, is a runnable
target, and `fabr run` builds it and starts it:

| Type | The program | Runs on |
|---|---|---|
| [`script`](/reference/standard-rules/#script) | A shell script, with the files it needs | `sh` |
| [`js_script`](/reference/js/targets/#js_script) | A JavaScript or TypeScript file, or an npm package's command-line program, with the packages it imports | The Node.js release fabr downloads |
| [`java_program`](/reference/java/running/#java_program) | Java sources or a jar, with what it requires | The JDK fabr downloads |

The same targets can also be commands in a [`generate`](#build-steps-and-code-generation) target,
or the server of a [`serve`](#dev-servers) target.

### `script`

```
script hello {
  entry = tools/hello.sh;
  deps = tools/lib.sh;
  args = Hello;
}
```

- `entry` is the script, run with `sh`.
- `deps` are other files the script needs, such as a file it sources. They are installed with the
  script under the names their references give them, so `tools/lib.sh` sits beside
  `tools/hello.sh` and the script finds it relative to itself, as `. "$(dirname "$0")/lib.sh"`.
  Don't use a path relative to the current directory: `fabr run` starts the script in your
  directory, not in the one it is installed in.
- `args` come before any arguments you give on the command line.

```sh
# tools/hello.sh
. "$(dirname "$0")/lib.sh"   # defines greeting
greeting "$@"
```

```sh
$ fabr run hello there
Hello there
```

### `js_script`

A `js_script` runs a Node.js program. Its `entry` is a `.ts` or `.js` file, compiled if needed, and
`deps` are the packages it imports:

```
plugin @fabr-build/js;

js_script greet {
  entry = scripts/greet.ts;
  deps = @npm:picocolors:1.1.1 @npm:@types/node:22.10.0;
  env = { MODE = dev; };
}
```

```ts
// scripts/greet.ts
import pc from "picocolors";
console.log(pc.green(`Hello, ${process.argv[2] ?? "world"}!`));
```

A TypeScript entry is type-checked like any other source, so a script that uses `process` or
`console` needs `@npm:@types/node` among its `deps`.

`entry` can instead be a package with a command-line program, which decorates that program with
the packages in `deps`, such as plugins it loads by name:

```
js_script md { entry = @npm:marked:15.0.12; args = --gfm; }
js_script docs_tool { entry = @npm:astro:7.1.1; deps = @npm:@astrojs/starlight:0.41.3; }
```

The program runs on the Node.js release fabr downloads, not the `node` on your `PATH`; see
[The Node.js version](/reference/js/dependencies/#the-nodejs-version).

### Running a package's program

To run an npm package's program without declaring anything, as you would with `npx`, name the
package with its version:

```sh
fabr run @npm:prettier:3.3.3 --write src/
fabr run @npm:typescript:5.6.3:tsc --version   # a package with several programs needs one named
```

To keep the version in one place, give it a name in your build file and run that:

```
PRETTIER = @npm:prettier:3.3.3;
```

```sh
fabr run PRETTIER --write src/
```

### Arguments, directory and environment

When you start a program with `fabr run`:

- Everything after the target name goes to the program, after the target's `args`. Options for
  fabr go before the target name: `fabr run -q greet Ann`.
- It runs in your current directory, so it reads and writes your files as it would have from an
  npm script.
- It has your terminal and your environment variables. A `js_script`'s `env` adds variables, and
  replaces any of the same name your shell sets.
- Its exit status is `fabr run`'s.

[`fabr run`](/reference/command-line/#run) has the details, and `fabr run -w` restarts the
program when what it is built from changes; see
[Watch mode & dev servers](/guides/watch/#restart-a-program-on-change).

## Build steps and code generation

A `generate` target runs a command as a step of the build and keeps the files it produces. It is
what you use for a code generator, a template expansion, or any other step no other target type
covers.

```
script gen_routes { entry = tools/gen-routes.sh; }

generate routes {
  srcs = api:*.txt;
  run = gen_routes *.txt > routes.ts;
}
```

```sh
# tools/gen-routes.sh: print a TypeScript module listing the routes in the files given.
echo "export const ROUTES = ["
cat "$@" | while read r; do echo "  \"/$r\","; done
echo "] as const;"
```

```sh
$ fabr build routes
✓ Building routes (15ms)
$ fabr cat routes:routes.ts
export const ROUTES = [
  "/users",
  "/orders",
] as const;
```

- `srcs` are the command's input files. They are placed in the directory it runs in, named as
  their reference names them: `api:*.txt` puts `api/routes.txt` there as `routes.txt`.
- `run` is the command. `> routes.ts` keeps its standard output as a file called `routes.ts`, and
  that file is the target's result.

The result stays in fabr's cache, not your source tree: look at it with `fabr ls` and `fabr cat`,
copy it out with `fabr cp routes ./out`, or name it in another target.

### The command line

`run` is written much as a shell command line, with a few differences:

- **Each command is a program fabr can run**: a runnable target (`gen_routes`), a name whose value
  is one (`PRETTIER`), a package (`@npm:marked:15.0.12`), or a program installed on your machine,
  through [`@host`](#programs-on-your-machine) (`@host:sort`). A bare `sort` is looked up as a
  name in your project.
- **A pattern among the arguments is expanded** against the input files, as `*.txt` is above. A
  pattern matching none of them is an error; quote it (`'*.json'`) to pass it to the program as
  it is.
- **Pipes and redirections**: `|`, `< file`, `> name`, `2> name`, `&> name` and `2>&1` work as in a
  shell, except that only the last command of a pipeline can redirect its standard output, and a
  stream can't be redirected twice.

```
generate sorted {
  run = @host:sort < ./api/routes.txt | @host:tr a-z A-Z > sorted.txt 2> errors.txt;
}
```

`< ./api/routes.txt` reads a file from your project; it names the file as any reference in the build
file does, not as it is named in the command's directory. A stream that isn't redirected is shown as
the step's output, prefixed with the target's name (`sorted err| …`), and repeated in the error if
the command fails. [Command property](/reference/syntax/#command-property) has the full syntax.

To run several shell commands in one step, as a Makefile recipe does, run them through the shell:
`run = @host:sh -c "mkdir -p out && cp *.txt out/";`.

### Choosing the result with `output`

Without `output`, the result is the files the redirections keep. A tool that writes files itself
needs `output` to say which to keep, as a pattern over the command's directory:

```
script site_gen { entry = tools/site.sh; }

generate site {
  srcs = pages:*.md;
  run = site_gen *.md > build.log;
  output = dist:**;
}
```

`dist:**` keeps everything the tool wrote under `dist/`, named without the `dist/` prefix, so
`fabr ls site` lists `about.html` and `index.html`. With `output` set, a redirection's file is
kept only if the pattern matches it: `build.log` here is not.

Have the tool write into a directory of its own and select that. The command's directory also
holds `srcs` and the command's own files (`tools/site.sh` here), so `output = **;` keeps those
too. `output` can rename what it keeps: `output = gen:*.java -> src/*.java;`.

### Using the result in another target

A `generate` target's result is files, which any target can name in its `srcs` like any other
target's output:

```
js_package app {
  srcs = src:**/*.ts routes:routes.ts;
}
```

`app` compiles `routes.ts` beside its own sources, so `src/index.ts` imports it as `./routes`.
`fabr build app` runs `routes` first, and only when its result isn't already in the cache. Name
the target alone (`srcs = routes;`) to take all of its files, or select some
(`routes:**/*.ts`), as with any [reference](/reference/syntax/#references).

### When it runs again

Fabr caches the result of a successful run and reuses it for as long as the run would be the same.
A `generate` target runs again when one of these changes:

- the content of a file in `srcs`;
- the command's programs: a script and its `deps`, a `js_script` and the packages it uses, the
  version of an npm package, a `@host` program's binary;
- the `run` line or `env`.

Anything else is invisible to the step, so a change to it doesn't rerun it: a file in your project
that `srcs` doesn't name, the time, your shell's environment. A failed run isn't cached, and runs
again the next time you build.

Because a result is reused whenever its inputs are the same, the command must produce the same
files from the same inputs. A command whose output depends on something it isn't given, such as
the current date or the Git commit, is reused unchanged until one of its inputs changes; pass such
a value in as described under [Values from outside the build](#values-from-outside-the-build).

### The command's directory and environment

A `generate` command runs in a directory of fabr's own, holding only `srcs` and the command's own
files. It can't see the rest of your project, and anything it writes outside the result is
discarded.

It also starts with **no environment variables** except those you give in `env`:

```
generate sorted_names {
  srcs = names:*.txt;
  run = @host:sort names.txt > sorted.txt;
  env = { LANG = C; };
}
```

There is no `HOME` and no `PATH`, so a program that finds another one by name on your `PATH` won't
find it. A shell script run by `script` still finds the standard system utilities, such as `cat`
and `sed`, through `sh`'s own default search path, but not `node` or anything else you installed.
Name each program as a command of its own (`@host:protoc`, a `js_script`) rather than calling it
from inside a script. A `js_script`'s own `env` applies when you start it with `fabr run`, not as a
command here: set the variables it needs in the `generate` target's `env`.

`fabr shell <target>` opens a shell in the directory the step runs in, with its inputs in place, and
prints the command it would run; use it to try a failing step by hand. See
[`fabr shell`](/reference/command-line/#shell).

### Incremental tools

A tool that can redo only what changed, given what it produced last time, can keep files from one
successful run to the next and be told what changed:

```
script render { entry = tools/render.sh; }

generate html {
  srcs = ./pages/*.md;
  run = render;
  output = out:**;
  incremental = out/**;
  changes = changes.txt;
}
```

- `incremental` is a pattern for the files the command keeps. Before the next run, fabr puts them
  back under the same names. A file both `output` and `incremental` match, as here, is part of the
  result and is kept too.
- `changes` names a file fabr writes before the next run, listing what changed in the command's
  directory since the last successful run: one line per file, `A`, `M` or `D` (added, modified,
  deleted), a tab, and the file's name.

```
A	pages/contact.md
M	pages/index.md
```

Neither is there for the first run, nor after fabr's cache has been cleared, and the command must
then do the whole job. Either way it must produce exactly what it would from nothing, because fabr
caches its result as if it had. The list covers every file in the directory, the command's own
included, so a line naming a file the tool doesn't know how to update means it should start again:

```sh
# tools/render.sh: render pages/*.md to out/*.html, redoing only what changed where it can.
tab="$(printf '\t')"
render() { echo "<h1>$(cat "$1")</h1>" > "out/$(basename "$1" .md).html"; }

mkdir -p out
if [ -f changes.txt ] && ! grep -qv "${tab}pages/" changes.txt; then
  while IFS="$tab" read -r op name; do
    if [ "$op" = D ]; then rm -f "out/$(basename "$name" .md).html"; else render "$name"; fi
  done < changes.txt
else
  rm -f out/*.html
  for page in pages/*.md; do render "$page"; done
fi
```

Adding `pages/contact.md` then renders that one page, and editing `tools/render.sh` renders them
all.

### A step that checks

A command that fails, by exiting with a non-zero status, fails the build. A linter or formatter
check is therefore a `generate` target whose result is its report:

```
PRETTIER = @npm:prettier:3.3.3;

generate format_check {
  srcs = src:**/*.ts;
  run = PRETTIER --check **/*.ts > format.txt;
}
```

`fabr build format_check` passes when every file is formatted, and fails with Prettier's output
otherwise; like any step, it runs again only when a source changes. Add it to the targets your CI
builds. To check every package the same way without a target for each, write a rule that gives
them a `lint` operation; see [A rule for another operation](/guides/rules/#a-rule-for-another-operation).

## Programs on your machine

`@host:<program>` is a program installed on the machine fabr runs on: the one your shell would run
for that name, found on fabr's own `PATH`, or the one at an absolute path (`@host:/usr/bin/cc`).
Use it wherever a command is written:

```
generate app_config {
  run = @host:sed -e s/DEBUG/RELEASE/ < ./config/app.in > app.conf;
}
```

Fabr identifies the program by its contents, so a different build of `sed` reruns the steps that
used it. It doesn't track anything the program reads or runs in turn — a compiler's headers and
linker, a configuration file in your home directory — so a change there alone reruns nothing. Prefer
a tool fabr downloads, such as an npm package or a [`java_program`](/reference/java/running/#java_program),
wherever there is one, and use `@host` for what only the machine provides. The program runs with the
[empty environment](#the-commands-directory-and-environment) every command has.

### Values from outside the build

A command sees only its inputs, so it can't read your project's Git history:
`` `@host:git rev-parse --short HEAD` `` fails with `not a git repository`. Pass such a value in
from the command line instead. Declare it with a default, and use it in the command:

```
default GIT_REV = dev;

generate revision {
  run = @host:echo "export const REV = '${GIT_REV}';" > rev.ts;
}
```

```sh
fabr build -DGIT_REV=$(git rev-parse --short HEAD) revision
```

A different value is a different input, so the step reruns when it changes.

For a short value that a tool prints, such as a tool's version, a
[command substitution](/reference/syntax/#command-substitution) puts the output into a property
directly: `` OS = `@host:uname -s`; ``.

## Patching a dependency

A `patched` target changes a package from a registry, with diffs or with a command, and named
after the package it replaces it everywhere in your build:

```
patched picocolors {
  srcs = @npm:picocolors:1.1.1;
  patches = patches/picocolors.patch;
}
```

`patches` are unified diffs as `git diff` writes them, applied in order. `run` is a command, as in
a `generate` target, run after the patches in a directory holding the package's files, which it
changes in place. [Patching a package](/reference/js/dependencies/#patching-a-package) has the
details.

## Archives

A [`zip`](/reference/standard-rules/#zip) target is a zip archive of its `srcs`, named after the
target:

```
zip site_bundle {
  srcs = site:** -> public/** ./README.txt;
}
```

```sh
$ fabr ls site_bundle
site_bundle.zip
$ fabr cp site_bundle ./dist
```

Each file is stored under the name its reference gives it, so `site:** -> public/**` puts the
`site` target's files under `public/`. Every entry has the same fixed timestamp, so the same files
make the same archive. To look inside it, continue the reference into the archive:
`fabr ls 'site_bundle:site_bundle.zip:**'`.

## Dev servers

A [`serve`](/reference/standard-rules/#serve) target is a long-running server together with the
files it serves, in place of a `dev` script:

```
serve preview {
  tool = @npm:http-server:14.1.1;
  files = site;
  args = -c-1 .;
}
```

`fabr run -w preview` starts the server in a directory holding `files`, updates them there as you
edit, and restarts the server when the server itself changes. See
[Dev servers with `serve`](/guides/watch/#dev-servers-with-serve).

## When to write a rule instead

A `generate` target is one step for one set of inputs. When several targets need the same step,
such as a generated client for each API description or a lint report for each package, write a
rule for their type, and fabr gives every target of the type its own copy of the step. See
[Writing your own rules](/guides/rules/).

## Troubleshooting

**`Unknown name 'sort'`**

A command in `run` is a name in your project, not a program on your `PATH`. Write
`@host:sort` for the program installed on your machine, or name a target or package.

**`node: command not found`, exit status 127, from a script run by `generate`**

Commands start with no `PATH`, so a script can't find programs you installed. Make the program a
command of its own: a `js_script` for Node.js code, `@host:<program>` for a program on your
machine.

**`Unable to find 'protoc' in PATH`**

The `@host` program isn't installed, or isn't on the `PATH` fabr was started with. Install it, or
name it by its absolute path (`@host:/opt/protoc/bin/protoc`).

**`no files in 'srcs' match this glob`**

A pattern in the command's arguments matched none of the input files. Check `srcs` with
`fabr ls <target>`, remembering that files are named as their reference names them (`api:*.txt`
gives `routes.txt`, not `api/routes.txt`), or quote the argument to pass it to the program
unexpanded.

**`the command produced no files matching output pattern 'out:**'`**

The tool wrote its files somewhere other than where `output` looks, or wrote nothing. Run
`fabr shell <target>` and the command it prints to see where its files go.

**`fabr ls` shows nothing for a `generate` target**

The command wrote files but nothing kept them: without `output`, only redirections (`> name`) are
the result. Add `output` selecting what the tool writes.

**`Circular dependency: 'config' depends on itself`**, with `help: 'config' names this target, not the path 'config'`

A file reference such as `< config/app.in` starts with the name of a target, here the target being
declared, so it names that target's files rather than the directory. Write the path with `./`:
`< ./config/app.in`.

**`fatal: not a git repository`**, or a tool that can't find a file in your project

The command runs in a directory holding only its `srcs`. Add what it reads to `srcs`, or pass a
value in with `-D`; see [Values from outside the build](#values-from-outside-the-build).

**`'typescript' has 2 candidate entries (tsc, tsserver) — name one (e.g. <ref>:tsc)`**

The package has several programs. Name the one to run: `@npm:typescript:5.6.3:tsc`.

**`Cannot run 'routes': no rule matches target type 'generate'`**

A `generate` target is a build step, not a program: build it with `fabr build routes`. To run a
program, declare a `script` or `js_script`.

**`Cannot find name 'process'` from a `js_script`**

The TypeScript entry is type-checked without Node.js's types. Add `@npm:@types/node:<version>` to
its `deps`.

**`patch 'patches/picocolors.patch' does not apply to 'picocolors.js': hunk @@ -1,3 +1,3 @@ does not match the file`**

The patch was written against a different version of the file. Make it again against the version
`srcs` names; see [Patching a package](/reference/js/dependencies/#patching-a-package).
