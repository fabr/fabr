---
title: Writing a plugin
description: How to build, test and publish a fabr plugin with fabr itself, by writing a small text linter step by step.
---

This how-to builds a small plugin, `@example/text-lint`, that adds a `text_lint` target type:
it checks text files for lines that end in whitespace, and optionally for lines that are too long.
The plugin is an ordinary npm package, and fabr builds it, tests it and publishes it. Along the way
it covers what most plugins need: the plugin package, a target type and the rule that builds it,
running a tool, reading a target's properties, and tests. The
[plugin reference](/developer/plugins/) documents everything shown here in full.

You need fabr installed (see the [quick start](/quickstart-js/)) and Node.js 22.19 or later. A
project that uses the finished plugin looks like this:

```
plugin @example/text-lint;

text_lint docs_lint {
  srcs = docs:**/*.md;
  max_length = 100;
}
```

## 1. The plugin project

The plugin is a fabr project of its own:

```
text-lint/
  PROJECT.fabr
  src/index.ts        the rule, and activate()
  lib/LINT.fabr       the target type
  test/lint.test.ts   added in step 2
```

`PROJECT.fabr` declares the plugin's package with `js_package`:

```
plugin @fabr-build/js;

js_package @example/text-lint {
  srcs = src:**/*.ts lib/**;
  exports = src:index.ts;
  provided_deps = @npm:@fabr-build/core:^0.3.1;
}
```

`src:**/*.ts` compiles the TypeScript to the root of the package, and `lib/**` keeps the `.fabr`
files in a `lib/` directory beside it, where fabr looks for them. `@fabr-build/core` is the
interface a plugin is written against. It is a `provided_deps` dependency, npm's peer
dependency: the plugin compiles against it, but when it runs it uses the copy of core that fabr
itself loads. There is no `package.json` to write; fabr generates it from the target.

A target type is declared in a `.fabr` file shipped with the plugin. Create `lib/LINT.fabr`:

```
# Text files checked for lines that end in whitespace.
targetdef text_lint {
  # The files to check.
  srcs = REQUIRED FILES;
}
```

The rule is the code that builds targets of the type. Create `src/index.ts`:

```ts
import { defineRule, FileSet, MemoryFile, getPackageLibFile, PluginContribution } from "@fabr-build/core";

const textLint = defineRule({
  type: "text_lint",
  properties: {},
  requirements: context => ({ srcs: context.getFileProperty("srcs") }),
  evaluateMaterialized: (_context, { srcs }) => {
    const names = [...FileSet.unionAll(...srcs)].map(([name]) => name).sort();
    return new FileSet(new Map([["files.txt", MemoryFile.from(names.join("\n") + "\n")]]));
  },
});

export function activate(): PluginContribution {
  return {
    rules: [textLint],
    includes: [getPackageLibFile("@example/text-lint", "LINT.fabr")],
  };
}
```

A rule has two halves:

- **`requirements`** states the target's file dependencies, here the files its `srcs` property
  names. It returns them without content: fabr resolves them first, and can show them with `fabr deps`
  without building anything.
- **`evaluateMaterialized`** builds the target. It is given each requirement with its content,
  here `srcs` as a list of `FileSet`s, one for each source written. This first version only lists
  the files, as a `files.txt` it returns directly.

`activate` is what fabr calls to load the plugin. It returns the rules and the `.fabr` files to
include; `getPackageLibFile` locates a file in the installed package's `lib/` directory.

Build the package and look at what it contains:

```sh
$ fabr build @example/text-lint
✓ Compiling @example/text-lint (0.8s)
Built @example/text-lint
$ fabr ls @example/text-lint
index.d.ts
index.js
index.js.map
lib/LINT.fabr
package.json
```

## 2. Testing the plugin

A plugin is tested the way it is used: by running fabr, with the plugin installed, on a project
that uses it. A test can do that by starting fabr as a separate process in a temporary directory.
Add a test target to `PROJECT.fabr`:

```
js_test e2e {
  tests = test:**/*.test.ts;
  deps = @example/text-lint @npm:@fabr-build/cli:^0.3.1 @npm:@types/node:22.15.3;
}
```

The test's dependencies are the plugin, fabr's command-line package (which brings core with it)
and Node.js's types. They are installed together for the test, as they would be in a project that
installed fabr and the plugin, so the fabr the test runs finds the plugin.

Create `test/lint.test.ts`:

```ts
import { spawnSync } from "node:child_process";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const FABR = require.resolve("@fabr-build/cli");
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), "text-lint-cache-"));
after(() => fs.rmSync(CACHE, { recursive: true, force: true }));

/** Run fabr with `args` in a new project made of `files`. */
function fabr(files: { [name: string]: string }, ...args: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "text-lint-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return spawnSync(process.execPath, [FABR, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", FABR_CACHE_DIR: CACHE },
  });
}

/** A project with a text_lint target over its docs, given `properties` as well. */
function project(properties = ""): string {
  return `plugin @example/text-lint;

text_lint docs_lint {
  srcs = docs:**/*.md;
${properties}}
`;
}

describe("text_lint", () => {
  it("lists the files it checks", () => {
    const result = fabr({ "PROJECT.fabr": project(), "docs/a.md": "# A\n", "docs/b.md": "# B\n" }, "cat", "docs_lint");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "a.md\nb.md\n");
  });
});
```

The `fabr` helper writes a project into a new temporary directory and runs fabr there, with its
own cache directory so the tests leave your cache alone. `fabr test` runs tests with an empty
environment, which is why the helper gives fabr a `PATH`. The test reads the target's content
with `fabr cat`; `describe`, `it` and `after` are provided by fabr's test runner.

```sh
$ fabr test e2e
✓ Testing e2e (1.1s)
e2e: 1 test passed
```

## 3. Running a tool

A rule never runs a program itself: it returns a **build action** that does, and fabr runs and
caches it. The linter is a small shell script. Add it as `lib/linter.sh`:

```sh
#!/bin/sh
# Report every line that ends in whitespace, and fail if there are any.
found=$(awk '/[[:space:]]$/ { print FILENAME ":" FNR ": ends in whitespace" }' "$@")
if [ -n "$found" ]; then
  echo "$found"
  exit 1
fi
echo "$# files checked" > lint-report.txt
```

A tool is a target too. Declare it in `LINT.fabr`, with a global that names it:

```
# The program a text_lint target runs over its files.
default TEXT_LINTER = @example/text-lint-tools/linter;

script @example/text-lint-tools/linter {
  entry = ./linter.sh;
}
```

`script` is core's target type for a shell script; `./linter.sh` is relative to the `.fabr` file.
Because `TEXT_LINTER` is a `default`, a project can point it at a linter of its own. Then change
the rule to run the tool:

```ts
import { createExecAction, defineRule, FileSet, getPackageLibFile, PluginContribution } from "@fabr-build/core";

const textLint = defineRule({
  type: "text_lint",
  properties: {},
  requirements: context => ({ srcs: context.getFileProperty("srcs") }),
  evaluateMaterialized: (context, { srcs }) =>
    context.getGlobalRunnable("TEXT_LINTER").then(linter => {
      const files = FileSet.unionAll(...srcs);
      const names = [...files].map(([name]) => name).sort();
      const staged = FileSet.unionAll(files, FileSet.layout({ ".linter": linter }));
      return createExecAction(staged, linter.toCommandLine(names, { base: ".linter" }), "lint-report.txt");
    }),
});
```

- `getGlobalRunnable("TEXT_LINTER")` reads the tool as something to run. A tool is read in the
  evaluation, not in `requirements`: it is run by the build, not part of what the target is made
  from.
- `createExecAction(files, argv, outputs)` returns an action that puts `files` in an empty working
  directory, runs `argv` there, and collects the files matching `outputs` as the target's result.
  A non-zero exit fails the target, and the error shows the program's output. The linter is placed
  under `.linter/`, apart from the files it checks, and `toCommandLine` gives the command that
  runs it from there.

Fabr caches the action by what it is given: the files and the command line. Change a source, the
linter, or the arguments, and the action runs again; change nothing, and its last result is used.

The target's content is now the linter's report, so replace the test with two that build a clean
file and a bad one:

```ts
describe("text_lint", () => {
  it("passes clean files", () => {
    const result = fabr({ "PROJECT.fabr": project(), "docs/guide.md": "# Guide\n" }, "build", "docs_lint");
    assert.equal(result.status, 0, result.stderr);
  });

  it("fails a line that ends in whitespace", () => {
    const result = fabr({ "PROJECT.fabr": project(), "docs/guide.md": "# Guide  \n" }, "build", "docs_lint");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /guide\.md:1: ends in whitespace/);
  });
});
```

```sh
$ fabr test e2e
✓ Testing e2e (1.5s)
e2e: 2 tests passed
```

## 4. An option

Add a property to the target type, to limit line length:

```
targetdef text_lint {
  # The files to check.
  srcs = REQUIRED FILES;
  # The longest a line may be, in characters. Unset, lines may be any length.
  max_length = STRING;
}
```

`max_length` is a string, not a file dependency, so it is not a requirement: the evaluation reads
it from `context` and passes it to the linter, with `Computable.forAll` waiting for both it and
the tool (add `Computable` to the import):

```ts
  evaluateMaterialized: (context, { srcs }) =>
    Computable.forAll([context.getGlobalRunnable("TEXT_LINTER"), context.getString("max_length")], (linter, maxLength) => {
      const files = FileSet.unionAll(...srcs);
      const names = [...files].map(([name]) => name).sort();
      const options = maxLength === undefined ? [] : [`--max-length=${maxLength}`];
      const staged = FileSet.unionAll(files, FileSet.layout({ ".linter": linter }));
      return createExecAction(staged, linter.toCommandLine([...options, ...names], { base: ".linter" }), "lint-report.txt");
    }),
```

and teach the linter the option:

```sh
#!/bin/sh
# Report every line that ends in whitespace, or is longer than --max-length=N
# characters where that is given, and fail if there are any.
max=0
case "$1" in
  --max-length=*) max="${1#--max-length=}"; shift ;;
esac
found=$(awk -v max="$max" '
  /[[:space:]]$/ { print FILENAME ":" FNR ": ends in whitespace" }
  max > 0 && length > max { print FILENAME ":" FNR ": longer than " max " characters" }
' "$@")
if [ -n "$found" ]; then
  echo "$found"
  exit 1
fi
echo "$# files checked" > lint-report.txt
```

The option is part of the command line, so changing `max_length` runs the action again. Add a test
that sets it:

```ts
  it("fails a line longer than max_length", () => {
    const result = fabr(
      { "PROJECT.fabr": project("  max_length = 10;\n"), "docs/guide.md": "# A longer heading\n" },
      "build",
      "docs_lint"
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /guide\.md:1: longer than 10 characters/);
  });
```

```sh
$ fabr test e2e
✓ Testing e2e (1.8s)
e2e: 3 tests passed
```

## 5. Publishing

A `sync` target publishes the package to npm, at the version written in its entry:

```
sync release {
  @npm:@example/text-lint:0.1.0 = @example/text-lint<BUILD_TYPE=release>;
}
```

Build it first to see exactly what will be uploaded, then publish:

```sh
$ fabr build release
$ fabr ls release
@npm/@example/text-lint/0.1.0/@example/text-lint-0.1.0.tgz
@npm/@example/text-lint/0.1.0/package.json
$ fabr sync release
```

The generated `package.json` lists `@fabr-build/core` under `peerDependencies` as `^0.3.1`, and
a `release` build leaves out the source maps. See [Publishing packages](/reference/js/publishing/)
for credentials and the rest of the package's metadata.

A project then uses the plugin by installing it beside fabr and declaring it, as shown in
[Using a plugin](/developer/plugins/#using-a-plugin).

## Where next

The [plugin reference](/developer/plugins/) covers the rest of the contract:

- [choosing when a rule applies](/developer/plugins/#which-rule-builds-a-target), for example
  only under `fabr test`;
- [requirements](/developer/plugins/#requirements) beyond files: packages, what a target passes on
  to whatever depends on it, and version conflicts;
- [composing targets](/developer/plugins/#composing-targets) from other target types;
- [repository types](/developer/plugins/#repository-types).
