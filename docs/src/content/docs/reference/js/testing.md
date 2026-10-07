---
title: Testing
description: How fabr runs JavaScript and TypeScript tests with node:test, jest or vitest — what to declare for each framework, what works, and what behaves differently from running the framework yourself.
---

`fabr test` compiles a target's tests and runs them with one of three test frameworks: Node.js's
built-in `node:test` (the default), jest, or vitest. Fabr compiles the tests itself and starts the
test processes itself, so none of the frameworks reads its own configuration file. What you'd
normally put in `jest.config.js` or `vitest.config.ts` either comes from your build file or has a
fixed value, as described on this page.

If you're converting an existing suite, go to the section for your framework:
[jest](#jest) or [vitest](#vitest). Each lists what to declare, what works, and what differs from
running that framework's own command.

## The three frameworks

| | `node` (default) | `jest` | `vitest` |
|---|---|---|---|
| Runs your tests with | Node.js's `node:test` | jest's own test framework and libraries (jest 29 or 30) | the vitest you declare (4.1 or later) |
| Test API | `describe`, `it` and hooks as globals; no built-in assertions | jest's globals: `describe`, `it`, `expect`, `jest` | imported from `"vitest"` |
| You add to `test_deps` | an assertion library, if you want one | `@types/jest`; `jsdom` for DOM tests | `vitest`; `jsdom` for DOM tests |
| Tests are compiled to | CommonJS | CommonJS | ES modules |
| DOM tests (jsdom) | no | yes | yes |
| Module mocking | `node:test`'s `mock` | `jest.mock`, `__mocks__` directories | `vi.mock` |
| Stylesheet and image imports in tested code | work | work | work |
| Configuration file | none | `jest.config.js` is not read | `vitest.config.ts` is not read |

Choose a framework for the whole project with the `JS_TEST_FRAMEWORK` setting, or for one target
with its `test_framework` property:

```
JS_TEST_FRAMEWORK = jest;

js_package legacy {
  srcs = src:**/*.ts;
  tests = src:**/*.test.ts;
  test_framework = node;      # this target only
}
```

## Declaring tests

A `js_package` carries its own tests. `tests` names the test files and `test_deps` the packages
only the tests need:

```
js_package mylib {
  srcs = src:**/*.ts;
  tests = src:**/*.test.ts;
  deps = @npm:lodash:4.17.21;
  test_deps = @npm:chai:4.3.6 @npm:@types/chai:4.3.1;
}
```

Test files are compiled together with the package's sources, so a test imports the code it tests
by relative path, or by the package's own name. The tests can use everything in `deps` as well as
`test_deps`. Nothing listed under `tests` or `test_deps` becomes part of the built package, and
`test_deps` are not added to its `package.json`.

For tests that don't belong to a package, such as an end-to-end suite, declare a `js_test`. It
takes the same settings under shorter names:

| `js_package` | `js_test` | What it is |
|---|---|---|
| `tests` | `tests` | The test files. |
| `deps` and `test_deps` | `deps` | Packages and supporting sources the tests use. |
| `test_framework` | `framework` | `node`, `jest` or `vitest`. |
| `test_env` | `env` | Environment variables for the test processes. |
| `test_resources` | `resources` | Files the tests read at run time. |
| `test_expectations` | `expectations` | Snapshot files. |

```
js_test e2e {
  tests = test:**/*.test.ts;
  deps = test:**/*.ts mylib @npm:@types/node:22.15.3;
}
```

### Every file in `tests` is run as a test

Fabr has no naming rule like jest's `testMatch`: each source file that `tests` matches is run as a
test file, whatever it's called. Keep helpers, fixtures written in TypeScript, and mocks out of
that pattern, and supply them another way:

- In a `js_package`, a helper that lives among `srcs` is already compiled with the tests. To keep
  it out of the built package, list it in `test_deps` instead: a source file there is compiled
  with the tests, never run as a test, and never shipped.
- In a `js_test`, list helpers in `deps`, as the example above does with `test:**/*.ts`. A file
  matched by both `deps` and `tests` is still a test.

Under jest and vitest, a helper that is matched by `tests` fails with
`This test file registered no tests`.

## Running tests

```sh
fabr test mylib        # compile and run mylib's tests
fabr test -w mylib     # ...and again whenever a source changes
fabr test -u mylib     # ...and record or update snapshots
```

A passing run prints one line per target, such as `mylib: 12 tests passed (1 skipped)`. A failing
run prints each failed test with its file, message and stack trace, and fails the target.

Some things differ from running a test framework's own command:

- **A passing run is cached.** If nothing the tests depend on has changed, `fabr test` reports the
  previous result without running them again. A failing run is never cached. The unit is the
  target: changing one test file runs all of that target's tests again.
- **You select tests by target, not by file or name.** There is no equivalent of `jest -t` or of
  passing a file path, and arguments aren't passed through to the framework. To run a subset
  routinely, give it its own target.
- **Output from passing tests is not shown.** `console.log` output and anything else a test writes
  to stdout or stderr is discarded, unless a test file fails to load at all, in which case the
  end of its error output is included in the failure.
- **Each test file runs in its own process,** in parallel up to the number of processors, so test
  files share no state. Framework options that control workers or isolation don't apply.
- **A test times out after 120 seconds** under every framework, where jest and vitest default to
  5 seconds. A timeout you set on an individual test still applies, as does `jest.setTimeout`.
- **There is no coverage reporting.**

## The test environment

Tests run in a staged copy of the compiled tree, not in your project directory, and see only what
the target declares.

### Environment variables

A test process starts with an empty environment: no `PATH`, no `HOME`, no `CI`, and no `NODE_ENV`
(jest and vitest normally set `NODE_ENV=test`). Declare the variables your tests need with
`test_env`:

```
js_package mylib {
  srcs = src:**/*.ts;
  tests = src:**/*.test.ts;
  test_env = {
    NODE_ENV = test;
    TZ = UTC;
    NODE_OPTIONS = "--max-old-space-size=512";
  }
}
```

Because there is no `PATH`, a test that starts another program must name it by absolute path, for
example `process.execPath` for Node.js itself.

### Files the tests read

List data files the tests open at run time in `test_resources`. They are placed alongside the
compiled tests under the same names they have in your source tree, and the working directory of
each test process is the root of that tree. With `srcs = src:**/*.ts` and
`test_resources = src:fixtures/**`, a test finds `src/fixtures/users.json` either way:

```ts
fs.readFileSync("fixtures/users.json");                        // relative to the working directory
fs.readFileSync(path.join(__dirname, "fixtures/users.json"));  // relative to a test in src/
```

A file that isn't declared isn't in that tree, so a path relative to the test or to the working
directory won't find it.

### Stylesheets and other assets

Tested code can import stylesheets and images as it does for a bundler. Under every framework
these imports work without configuration:

- **A css-module that is one of the target's own sources** is built as it is for the package, so
  `styles.cardTitle` in a test is the real scoped class name, such as `card-title_FCiirPWT`.
  Assert on `styles.cardTitle`, not on a literal class name.
- **Any other stylesheet import** (`.css`, `.scss`, `.sass`, `.less`, `.styl`) yields an object
  whose every property is its own name, so `styles.cardTitle` is `"cardTitle"`. This is what
  jest's `identity-obj-proxy` provides.
- **An image, font or media file** yields its file name, such as `"logo.png"`.

The file need not be in the test's tree: an import of a stylesheet or image that isn't declared
yields the same stub. Under jest, a `jest.mock` of the same path takes precedence.

### DOM tests

To run a target's tests in a browser-like environment, add the `dom` flag to its `deps` or
`test_deps`, and `jsdom` to its `test_deps`:

```
js_package widgets {
  srcs = src:**/*.tsx;
  tests = src:**/*.test.tsx;
  deps = @npm:react:19.1.0;
  test_deps = dom @npm:jsdom:26.1.0 @npm:@types/jest:30.0.0;
  test_framework = jest;
}
```

The flag does two things: it adds the DOM type declarations to the compile, and it runs the tests
under jsdom. Put it in `deps` when the package's own sources use DOM APIs, and in `test_deps` when
only the tests do. The `node` framework has no DOM environment; a target with the `dom` flag needs
`jest` or `vitest`.

Both jest and vitest also accept their usual per-file comment, `@jest-environment jsdom` or
`// @vitest-environment jsdom`, which overrides the environment for that file. The comment
doesn't add the DOM types, so a file that names `document` or `window` directly still needs the
flag to compile.

### A setup file

A source file named `setupTests` (`setupTests.ts`, `setupTests.js`) at the root of the target's
source tree is loaded in every test process before the test file, after the framework's globals
exist. It is the equivalent of jest's `setupFilesAfterEnv` and vitest's `setupFiles`, limited to
one file. With `srcs = src:**/*.ts`, the root is `src/`, so the file is `src/setupTests.ts`.

The file has to be compiled with the tests without being one of them:

- Don't let the `tests` pattern match it.
- In a `js_package`, list it in `test_deps` (`test_deps = src:setupTests.ts …`) so that it isn't
  shipped with the package. In a `js_test`, list it in `deps`.

A `setupTests` file in a subdirectory is an ordinary source and isn't loaded automatically. Two at
the root is an error.

## Snapshots

All three frameworks keep snapshots where jest does, in `__snapshots__/<test file>.snap` beside
the test file, for example `src/__snapshots__/render.test.ts.snap`. Declare them as the target's
`test_expectations`:

```
js_package mylib {
  srcs = src:**/*.ts;
  tests = src:**/*.test.ts;
  test_expectations = src:**/__snapshots__/*.snap;
}
```

Declare them there and not in `srcs`: a snapshot file among a package's `srcs` is shipped with the
package and can't be updated.

An ordinary run only checks. A test whose snapshot is missing fails, where jest and vitest would
record it and pass (outside CI). To record new snapshots or update changed ones, run:

```sh
fabr test -u mylib
```

If the tests pass, fabr writes the new and changed snapshot files into your source tree and prints
`Updated <file>` for each. A run with failing tests writes nothing.

Two limits apply:

- **Inline snapshots can be checked but not written.** `toMatchInlineSnapshot()` compares against
  a value already in your source, but fabr can't record or update one, because the test that runs
  is the compiled file. Use `toMatchSnapshot()`.
- **Obsolete snapshots aren't reported.** A snapshot whose test no longer exists is ignored in an
  ordinary run, and dropped from its file the next time `-u` rewrites that file. Fabr doesn't
  delete a `.snap` file whose test file is gone.

## `node:test`

The default framework runs your tests with Node.js's built-in
[test runner](https://nodejs.org/api/test.html). It needs no packages, so it works in a project
with no test dependencies at all.

```
js_package mylib {
  srcs = src:**/*.ts;
  tests = src:**/*.test.ts;
  deps = @npm:@types/node:22.15.3;
  test_deps = @npm:chai:4.3.6 @npm:@types/chai:4.3.1;
}
```

```ts
import { expect } from "chai";
import { greet } from "./index";

describe("greet", () => {
  it("greets by name", () => {
    expect(greet("world")).to.equal("Hello, world!");
  });
});
```

Fabr defines these as globals, with their types, in every test file: `describe`, `it`, `test`,
`before`, `after`, `beforeEach` and `afterEach`, plus `beforeAll` and `afterAll` as other names for
`before` and `after`. They are `node:test`'s own functions, and you can import them, or anything
else, from `node:test` instead. The types come from `@types/node`, which the target needs in its
`deps`.

There is no `expect`. Use `node:assert`, or add an assertion library such as chai to `test_deps`.
For mocks, use [`mock`](https://nodejs.org/api/test.html#mocking) from `node:test`.

Snapshots are `node:test`'s, taken through the test context:

```ts
import type { TestContext } from "node:test";

it("renders the greeting", (t: TestContext) => {
  t.assert.snapshot(render("world"));
});
```

What to know:

- **Snapshots need Node.js 23.4 or later.** On an earlier version, `fabr test -u` fails with
  `Recorded snapshots need node 23.4 or later`.
- **`--test-only` isn't supported, so `it.only` and `describe.only` have no effect.** Node.js
  honours `only` when it is started with that flag, and fabr has no way to pass it, so the other
  tests still run. Use `it.skip`, or `{ skip: true }`, on the tests you want left out.
- **No DOM environment.** See [DOM tests](#dom-tests).
- **Tests are compiled to CommonJS,** whatever format the package itself is built in. `import`
  statements work as usual; `import.meta` and top-level `await` aren't available in test files.

## jest

Setting the framework to `jest` runs your tests with jest's own test framework and libraries:
`describe`/`it`/`expect`, matchers, mock functions, fake timers and snapshots all behave as they
do under jest, because they are jest's code. What fabr replaces is everything around them. It
compiles the tests, starts the processes, and loads modules through Node.js instead of jest's
module loader. So jest's command line and configuration file aren't involved.

### What to declare

```
JS_TEST_FRAMEWORK = jest;

js_package mylib {
  srcs = src:**/*.ts;
  tests = src:**/*.test.ts;
  test_expectations = src:**/__snapshots__/*.snap;
  test_deps = @npm:@types/jest:30.0.0
              @npm:@types/istanbul-lib-report:3.0.3? @npm:@types/yargs-parser:21.0.3?
              @npm:ansi-styles:4.1.0? @npm:ansi-styles:5.2.0?
              @npm:picomatch:2.3.1? @npm:picomatch:4.0.2?;
}
```

- **`@types/jest`** supplies the types of the globals. Without it the tests don't compile.
- **The entries ending in `?`** are needed by the packages `@types/jest` depends on. Two of them
  are required without a minimum version, so nothing selects one, and two are needed at two
  versions at once. If you leave any out, or a version has moved on, the build stops and prints
  the exact lines to add. [Dependencies](/reference/js/dependencies/#when-versions-conflict)
  explains the marker. In a project with several test targets, put these in a
  [catalog](/reference/js/dependencies/#catalogs) once.
- **jest itself is not something you declare.** Fabr supplies it, at the version named by the
  `JEST` setting (`@npm:jest:30.3.0` by default). Set `JEST = @npm:jest:29.7.0;` to use another;
  jest 29 and 30 are supported.
- **Add `jsdom`** to `test_deps`, with the `dom` flag, for [DOM tests](#dom-tests).

The jest framework needs Node.js 22.15 or later.

### Coming from jest.config.js

No jest configuration is read: not `jest.config.js`, and not the `jest` key of a `package.json`.

| jest option | In fabr |
|---|---|
| `testMatch`, `testRegex`, `roots` | The target's `tests` pattern. |
| `preset: "ts-jest"`, `transform` | Not needed: fabr compiles the tests with TypeScript before they run. Other transformers can't be added. |
| `testEnvironment` | `node`, or `jsdom` with the [`dom` flag](#dom-tests). Per file, the `@jest-environment` comment. Custom environment modules aren't loaded. |
| `testEnvironmentOptions` | Per file only, with the `@jest-environment-options` comment. |
| `setupFilesAfterEnv` | One file, by name: [`setupTests`](#a-setup-file). |
| `setupFiles` | No equivalent. Use `setupTests`, which runs after the framework is installed. |
| `moduleNameMapper` for stylesheets and images | Built in; see [stylesheets and other assets](#stylesheets-and-other-assets). |
| `moduleNameMapper` for path aliases | No equivalent. Imports resolve as described in [Module resolution](/reference/js/module-resolution/). |
| `testTimeout` | Fixed at 120 seconds; set it per test, or call `jest.setTimeout` in `setupTests`. |
| `clearMocks`, `resetMocks`, `restoreMocks` | No equivalent. Call `jest.clearAllMocks()` and the others from an `afterEach` in `setupTests`. |
| `globalSetup`, `globalTeardown`, `reporters`, `resolver`, `runner`, `globals` | Not supported. |
| `collectCoverage` and the other coverage options | Not supported. |

### What works

- The globals `describe`, `it`, `test`, `expect`, the hooks, and their variants: `.each`, `.only`,
  `.skip`, `.todo`, `.failing`, `.concurrent`. They can also be imported from `@jest/globals`.
  `.only` applies within its own file, as under jest.
- `jest.fn`, `jest.spyOn`, `jest.mocked`, `jest.replaceProperty`, and `clearAllMocks`,
  `resetAllMocks` and `restoreAllMocks`.
- `jest.mock`, with or without a factory, hoisted above the file's imports as under jest. Also
  `jest.doMock`, `jest.unmock`, `jest.requireActual`, `jest.requireMock`,
  `jest.createMockFromModule`, `jest.resetModules`, `jest.isolateModules`, automocking, and
  `{ virtual: true }`.
- `__mocks__` directories: one at the root of the source tree mocks the npm package of the same
  name automatically, and one beside a module is used by a `jest.mock` of that module that has no
  factory. The mock files must be compiled with the tests, so match them with `srcs` or
  `test_deps`, not `tests`.
- Fake timers (`jest.useFakeTimers`, `jest.advanceTimersByTime`, `jest.setSystemTime` and the
  rest).
- Snapshots with `toMatchSnapshot()`; see [Snapshots](#snapshots).
- The `@jest-environment` and `@jest-environment-options` comments at the top of a test file.
- Packages published only as ES modules can be imported from tests and from the code under test
  without a `transformIgnorePatterns` entry, and a `jest.mock` of a module applies to imports made
  from inside such packages too.

### What differs from jest

- **`setImmediate` and `process.nextTick` aren't faked by default.** `jest.useFakeTimers()` leaves
  them real. To fake them as jest does, pass `jest.useFakeTimers({ doNotFake: [] })`.
- **`jest.resetModules()` and `jest.isolateModules()` reset only your own modules.** Packages
  loaded from dependencies stay loaded, where jest reloads them too. A test that depends on a
  package being re-initialised needs to mock it.
- **Variables used in a `jest.mock` factory needn't be named `mock…`.** Jest's Babel plugin
  rejects a factory that refers to other outer variables; fabr doesn't apply that rule, so code
  that jest rejects for this reason runs.
- **Not available:** `jest.unstable_mockModule`, `jest.unstable_unmockModule`,
  `jest.onGenerateMock`, and legacy fake timers (`jest.runAllImmediates`). Calling one fails the
  test with a message saying it isn't supported.
- **`NODE_ENV` isn't set to `test`.** Set it in [`test_env`](#environment-variables) if your code
  reads it.
- **Tests must use jest's globals or `@jest/globals`.** A file that imports `describe` and `it`
  from `node:test` registers nothing with jest and fails with
  `This test file registered no tests`.

## vitest

Setting the framework to `vitest` runs your tests with the vitest package you declare. Fabr
compiles the tests to ES modules and has vitest load them with Node.js's own module loader, so
Vite takes no part: there are no Vite plugins and no Vite transforms.

### What to declare

```
JS_TEST_FRAMEWORK = vitest;

js_package mylib {
  srcs = src:**/*.ts;
  tests = src:**/*.test.ts;
  test_expectations = src:**/__snapshots__/*.snap;
  test_deps = @npm:vitest:5.0.3 @npm:@types/deep-eql:4.0.2?;
}
```

- **`vitest`**, version 4.1 or later, in `test_deps`. Earlier versions can't load tests without
  Vite.
- **Node.js 22.15 or later.**
- **`@npm:@types/deep-eql:4.0.2?`** is needed because vitest's type declarations require that
  package without a minimum version, so nothing else selects one. If it's missing, the build
  prints the line to add.
- **With vitest 4.1, also name a `vite` version,** such as `@npm:vite:6.4.0`. Vitest 4.1 accepts
  any Vite from 6.0.0, fabr selects the [lowest version that satisfies a range](/reference/js/dependencies/#how-versions-are-chosen),
  and Vite 6.0.0 fails at startup with
  `TypeError: Cannot read properties of undefined (reading 'length')`. Vitest 5 needs no `vite`
  entry.
- **Add `jsdom`** to `test_deps`, with the `dom` flag, for [DOM tests](#dom-tests).

Import the test API in each file. Vitest's `globals` option is off and can't be turned on:

```ts
import { describe, it, expect, vi } from "vitest";
```

### What works

- `describe`, `it`, `test`, `expect`, the hooks, and `vi.fn`, `vi.spyOn` and fake timers.
- `vi.mock`, hoisted above the file's imports.
- Snapshots with `toMatchSnapshot()`; see [Snapshots](#snapshots).
- A [`setupTests`](#a-setup-file) file.
- The `// @vitest-environment jsdom` comment at the top of a test file.

### What differs from vitest

- **No configuration file is read.** `vitest.config.ts`, `vite.config.ts` and the workspace file
  are ignored, and there's no way to pass an option. Reporters, pools, `globals`, `alias` and the
  rest keep fabr's values.
- **Nothing Vite does to an import happens.** These fail, at compile time or when the test loads:
  - Vite plugins, including framework plugins such as `@vitejs/plugin-react`. JSX itself is fine,
    because fabr compiles it.
  - `resolve.alias` and `tsconfig` path aliases. Imports resolve as described in
    [Module resolution](/reference/js/module-resolution/).
  - `import.meta.env`, `import.meta.glob` and `import.meta.hot`.
  - `?raw`, `?url` and `?worker` imports. Plain stylesheet and image imports work; see
    [Stylesheets and other assets](#stylesheets-and-other-assets).
- **Not available:** coverage, benchmarks (`bench`), type testing (`expectTypeOf` with
  `--typecheck`), browser mode, projects, and in-source tests.
- **Tests are ES modules,** so `require`, `__dirname` and `__filename` aren't defined in a test
  file. Use `import.meta.dirname`.
- **`NODE_ENV` isn't set to `test`.** Set it in [`test_env`](#environment-variables) if your code
  reads it.

Running without Vite depends on a vitest option that vitest still marks experimental, so a later
vitest release may change how it behaves.

## Troubleshooting

| What you see | Cause | What to do |
|---|---|---|
| `Cannot test 'x': no rule matches target type 'js_package'` | `test_framework` or `JS_TEST_FRAMEWORK` isn't `node`, `jest` or `vitest` | Correct the value; the message lists the accepted ones. |
| `This test file registered no tests` | Under jest or vitest: a helper or setup file matched by `tests`, or a test file that takes `describe`/`it` from `node:test` | Narrow the `tests` pattern (see [Every file in `tests` is run as a test](#every-file-in-tests-is-run-as-a-test)), or use the framework's own API. |
| `the following packages are required only without a version lower bound ('*')` | A test dependency's own dependencies name a package without a minimum version | Add the `@npm:…?` lines the message prints to `test_deps` or your catalog. |
| `Cannot find name 'describe'` or `'expect'` when compiling | jest: `@types/jest` isn't in `test_deps`. vitest: the API isn't imported. `node`: `@types/node` isn't in `deps`, or `expect` is used without an assertion library | Add the package or the import. |
| `Cannot find name 'document'` when compiling | The target doesn't have the `dom` flag | Add `dom` to `deps` or `test_deps`; see [DOM tests](#dom-tests). |
| `The fabr test runner provides no 'jsdom' environment` | The target has the `dom` flag and uses the `node` framework | Set `test_framework` to `jest` or `vitest`. |
| `These tests need a DOM environment … but 'jsdom' is not among its dependencies` | The `dom` flag without the `jsdom` package | Add `@npm:jsdom:<version>` to `test_deps`. |
| `This test has no recorded snapshot`, or `No recorded snapshot for this test` | A new snapshot, or a `.snap` file that isn't declared | Run `fabr test -u`, and check the file is matched by `test_expectations`. |
| `EACCES: permission denied, open '…/__snapshots__/x.test.ts.snap'` under `fabr test -u`, or `.snap` files in the built package | The `.snap` files are matched by `srcs`, not `test_expectations` | Match them with `test_expectations` only. |
| `Recorded snapshots need node 23.4 or later` | `node` framework snapshots on an older Node.js | Use Node.js 23.4 or later. |
| `Test target has more than one setupTests script` | Two `setupTests` files at the root of the source tree, such as a `.ts` and a `.js` | Keep one. |
| `The jest compatibility runner supports jest 29 and 30, but JEST is pinned to …` | `JEST` names another major version | Set `JEST` to a jest 29 or 30 release. |
| `fabr runs vitest 4.1 or later, but the target's vitest is …` | An older vitest in `test_deps` | Use vitest 4.1 or later. |
| `TypeError: Cannot read properties of undefined (reading 'length')` at `new ModuleRunner`, under vitest 4.1 | Vite 6.0.0 was selected | Add a later `vite`, such as `@npm:vite:6.4.0`, to `test_deps`. |
| A test passes under jest or vitest but times out, or reads an undefined variable, under fabr | The test relies on `PATH`, `NODE_ENV`, `CI`, `TZ` or another inherited variable | Declare it in [`test_env`](#environment-variables). |
| The tests re-run every time although nothing changed | fabr is started through `yarn` or another wrapper that changes `PATH` on each run | Run `fabr` directly; see [Known limitations](/known-limitations/#host-tools-arent-hermetically-sealed-yet). |
