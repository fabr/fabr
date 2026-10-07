---
title: Quick start (JavaScript / TypeScript)
description: Build, test, and run a TypeScript package with fabr.
---

This guide takes you from an empty directory to a TypeScript package that is compiled, tested and
runnable. The whole project is a `PROJECT.fabr` file and your sources: there is no `package.json`,
`tsconfig.json`, test configuration or lockfile to write.

## Install

Fabr needs Node.js 22.19 or later. Install the `fabr` command globally:

```sh
npm install -g @fabr-build/cli
```

That also installs `@fabr-build/js`, the plugin with the JavaScript and TypeScript rules.

:::caution
Install `@fabr-build/cli` only. Adding `@fabr-build/js` to the command makes npm install a second
copy of fabr's core beneath it, which a plugin can't use; fabr reports this when it loads the
plugin.
:::

## A minimal project

Create `PROJECT.fabr` in an empty directory:

```
plugin @fabr-build/js;

js_package mylib {
  srcs = src:**/*.ts;
}
```

and a source file, `src/index.ts`:

```ts
export const greet = (name: string): string => `Hello, ${name}!`;
```

Then build it:

```sh
fabr build mylib
```

Fabr downloads the TypeScript compiler, compiles the source, and assembles a package with a
generated `package.json`. The package isn't written into your project; it is kept in fabr's
cache, and you look at it with `fabr`:

```sh
fabr ls mylib                 # list the files in the package
fabr cat mylib/index.js       # print one of them
fabr cp mylib ./out           # copy the package to ./out/mylib/
```

`srcs = src:**/*.ts` means "the `.ts` files under `src`, named without the `src/` prefix", which
is why the package contains `index.js` and not `src/index.js`.

Two settings are worth making explicit from the start: the compiler version, and the JavaScript
to emit. Both have defaults (`typescript` 5.6.3 and `es6-esm`):

```
TYPESCRIPT = @npm:typescript:5.6.3;
JS_TARGET = es2022-esm;
```

[TypeScript compilation](/reference/js/typescript/) lists what else you would have put in
`tsconfig.json` and where it goes.

## Dependencies

Declare an npm dependency with an `@npm:` reference, `@npm:<package>:<version>`, in the target's
`deps`:

```
js_package mylib {
  srcs = src:**/*.ts;
  deps = @npm:lodash:4.17.21 @npm:@types/lodash:4.17.7;
}
```

There is no install step and no lockfile: fabr fetches packages as the build needs them, and the
same build file always selects the same versions. When several targets share dependencies, declare
them once in a **catalog** and refer to its members by name:

```
catalog @pkg {
  deps = @npm:typescript:5.6.3 @npm:@types/node:22.15.3
         @npm:chai:4.3.6 @npm:@types/chai:4.3.1;
}

TYPESCRIPT = @pkg:typescript;

js_package mylib {
  srcs = src:**/*.ts;
  deps = @pkg:@types/node;
}
```

[Dependencies](/reference/js/dependencies/) covers version ranges, how versions are chosen,
resolving version conflicts, patching a package, and private registries.

## Testing

Add a `tests` property naming the test files, and `test_deps` for anything only the tests need.
Test files are left out of the built package.

```
js_package mylib {
  srcs = src:**/*.ts;
  tests = src:**/*.test.ts;
  deps = @pkg:@types/node;
  test_deps = @pkg:chai @pkg:@types/chai;
}
```

By default, tests run with Node.js's built-in test runner. `describe`, `it` and the hooks are
globals, and assertions come from whichever library you add:

```ts
import { expect } from "chai";
import { greet } from "./index";

describe("greet", () => {
  it("greets by name", () => {
    expect(greet("world")).to.equal("Hello, world!");
  });
});
```

```sh
fabr test mylib
```

A summary such as `mylib: 1 test passed` is printed for each target, and a failing test fails the
build. A passing run is cached, so running `fabr test` again without changes reports the result
without re-running the tests.

To run an existing jest or vitest suite, or to use snapshots or DOM tests, see
[Testing](/reference/js/testing/).

## Running programs

A `js_script` is a Node.js program: `entry` is the file to run, and `deps` the packages it
imports.

```
js_script tool {
  entry = src:main.ts;
  deps = @npm:chalk:5.3.0 @pkg:@types/node;
}
```

```sh
fabr run tool arg1 arg2
```

The program runs in your current directory with your terminal, and everything after the target
name is passed to it. Options for fabr itself go before the target.

## The commands you'll use

| Command | What it does |
|---|---|
| `fabr build <target>` | Build the target. |
| `fabr test <target>` | Compile and run the target's tests. |
| `fabr run <target> [args…]` | Build a program and run it. |
| `fabr ls <reference>` | List the files a target produces. |
| `fabr cat <reference>` | Print them. |
| `fabr cp <reference…> <dir>` | Copy them into a directory. |

Two options work with most of them:

- `-D<NAME>=<VALUE>` changes a setting for one run: `fabr build -DBUILD_TYPE=release mylib`.
- `-w` keeps fabr running and rebuilds, retests or restarts as your sources change; see
  [Watch mode & dev servers](/guides/watch/).

The [command-line reference](/reference/command-line/) has the rest.

## Next steps

- [Dependencies](/reference/js/dependencies/): version ranges, catalogs, conflicts, patches and
  private registries.
- [Testing](/reference/js/testing/): the three test frameworks, snapshots and DOM tests.
- [TypeScript compilation](/reference/js/typescript/): what replaces `tsconfig.json`, and how
  fabr's output differs from `tsc`'s.
- [Module resolution](/reference/js/module-resolution/): what an import can reach.
- [Stylesheets](/reference/js/stylesheets/): CSS, Sass and css-modules.
- [Bundling](/reference/js/bundling/): one-file builds for browsers and for Node.js.
- [Publishing packages](/reference/js/publishing/): the generated `package.json`, and `fabr sync`.
- [Projects with several packages](/guides/multi-package/): the layout that replaces workspaces.
- [Continuous integration](/guides/ci/): caching, output and exit statuses.
- [Targets and configuration](/reference/js/targets/): every `js_*` target and setting.
- [Watch mode & dev servers](/guides/watch/): the live rebuild, retest and relaunch loop.
- [Known limitations](/known-limitations/): rough edges worth knowing about up front.
