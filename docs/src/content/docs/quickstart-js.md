---
title: Quick start (JavaScript / TypeScript)
description: Build, test, and run a TypeScript package with fabr.
---

This guide gets you from an empty directory to a compiled, tested, runnable TypeScript package.

:::note
It's worth noting what you _don't_ need here: no package.json, tsconfig.json, jest.config.js, or lock files -
just your `PROJECT.fabr` and your source files.
:::

## Install

Fabr ships as two npm packages: **`@fabr-build/cli`** (the `fabr` command) and **`@fabr-build/js`**
(the JavaScript/TypeScript rules, loaded from your build script). Install them together — globally.

```sh
npm install -g @fabr-build/cli @fabr-build/js
```

:::note
Fabr resolves a plugin by ordinary module resolution, so the plugin package must sit next to the
host `fabr` — installing them together, as above, satisfies that. Declaring `plugin @fabr-build/js;`
then loads its rules and configuration.
:::

## A minimal project

Create a `PROJECT.fabr` at your project root:

```
plugin @fabr-build/js;

# Optional: which TypeScript compiler to use, and the output target.
TSC = @npm:typescript:5.4.5;
JS_TARGET = es2021-commonjs;

js_package mylib {
  srcs = src:**/*.ts;
}
```

And a source file, `src/index.ts`:

```ts
export const greet = (name: string): string => `Hello, ${name}!`;
```

Now build it:

```sh
fabr build mylib
```

Fabr compiles the TypeScript, generates a `package.json`, and produces the package. Inspect the
result without digging through the cache:

```sh
fabr ls mylib            # list the built files
fabr cat mylib/index.js  # print a built file — path into a target as if it were a directory
fabr cp mylib ./out      # copy the package out -> ./out/mylib/ (cp -R rules)
```

Everything you build can be inspected in this way as if the targets were plain directories.

:::note
`mylib/index.js` and `mylib:index.js` reach the same file but *name* it differently: a `/` keeps the
whole written path, while a `:` strips everything before it. It makes no difference to `cat`, but it
decides the names that `ls` prints.
:::

## Dependencies and catalogs

Declare an npm dependency with a `@npm:` reference — `@npm:<package>:<version>`:

```
js_package mylib {
  srcs = src:**/*.ts;
  deps = @npm:lodash:4.17.21 @npm:@types/node:20.12.7;
}
```

Versions are exact requirements, resolved deterministically at each usage using the MVS algorithm. Mutable dist-tags like
`latest` are rejected — they would make the build non-deterministic.

When several targets share dependencies, you can declare them once in a **catalog** so they resolve jointly
and every consumer sees one consistent set of versions:

```
catalog @pkg {
  deps = @npm:typescript:5.4.5 @npm:@types/node:20.12.7
         @npm:chai:4.3.6 @npm:@types/chai:4.3.1;
}

TSC = @pkg:typescript:tsc;   # reference a catalog member as @pkg:<name>

js_package mylib {
  srcs = src:**/*.ts;
  deps = @pkg:@types/node;
}
```

## Testing

For package tests, just add a `tests` property with the sources and (if needed) any additional test dependencies in `test_deps`.
Tests will be automatically excluded from your main package build.

```
js_package mylib {
  srcs = src:**/*.ts;
  tests = src:**/*.test.ts;
  test_deps = @pkg:chai @pkg:@types/chai;
}
```

Fabr ships its own test runner (built on `node:test`). It provides the `describe`/`it`/`before`/…
**globals**; assertions are imported normally:

```ts
import { expect } from "chai";
import { greet } from "./index";

describe("greet", () => {
  it("greets by name", () => {
    expect(greet("world")).to.equal("Hello, world!");
  });
});
```

Run them:

```sh
fabr test mylib
```

`fabr test mylib` is exactly `mylib` built with the `test` operation. A per-target report summary
prints before the build-status line, and a failing test fails the target.

## Running programs

A `js_script` target defines a runnable Node program — `entry` is the script file to launch (or a
package whose bin is the entry), and `deps` assemble the rest of the install (packages mount under
`node_modules`, loose files land at their own paths):

```
js_script tool {
  entry = src:main.js;
  deps = @npm:chalk:5.3.0;
}
```

```sh
fabr run tool arg1 arg2
```

`fabr run` stages the install and launches it with inherited stdio — stdin, tty, pipes, and the exit
code all pass straight through, in your current working directory. Everything after the target name
is passed to the program verbatim (put any fabr options *before* the target).

## The commands you'll use

| Command | What it does |
|---|---|
| `fabr build <target>` | Build the target (the default operation). |
| `fabr test <target>` | Compile and run the target's tests. |
| `fabr run <target> [args…]` | Launch a runnable with inherited stdio. |
| `fabr ls [-l] <ref>` | List the files a reference resolves to (`-l` adds hash + size). |
| `fabr cat <ref>` | Write the resolved files' bytes to stdout. |
| `fabr cp <ref…> <dir>` | Copy the resolved files into a directory. |

Two flags work on most commands:

- `-D<PROP>=<VALUE>` overrides a configuration property, e.g. `fabr -DBUILD_TYPE=release build mylib`.
- `-w` keeps fabr running and rebuilds (or re-tests, or relaunches) as your sources change — see
  [Watch mode & dev servers](/guides/watch/).

Next steps:

- The [JavaScript reference](/reference/js-rules/) for every `js_*` target and its properties.
- [Watch mode & dev servers](/guides/watch/) — the live rebuild/retest/relaunch loop.
- [Known limitations](/known-limitations/) — a few rough edges worth knowing about up front.
