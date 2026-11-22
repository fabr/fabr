---
title: Browser tests
description: How fabr runs end-to-end tests that drive a browser, with Playwright or Cypress — declaring a browser_test, choosing its browser, running it interactively, and what behaves differently from running the framework yourself.
---

A `browser_test` target runs an end-to-end suite that drives a browser, in one browser, written for
the browser test framework its `framework` property names: `playwright` by default (the
`BROWSER_TEST_FRAMEWORK` setting), or `cypress`. Unlike fabr's runs of node:test, jest and
vitest, both read your suite's own config, with fabr owning only the settings each section below
lists. `browser_test`
comes in a file of the js plugin, which a project includes to use it:

```
include @fabr-build/js:lib/BROWSER_TEST.fabr;

browser_test e2e {
  tests = e2e:tests/**/*.spec.ts;
  deps = e2e:**/*.ts @npm:@playwright/test:1.64.0 @npm:@types/node:22.15.3;
  base_url = https://staging.example.com/;
  browser = playwright/chromium;
}
```

A `js_test` or `js_package` naming `playwright` or `cypress` as its framework fails with
`'playwright' tests drive a browser, which a browser_test supplies`.

## How a browser test differs from other test targets

A browser test is compiled, cached and reported like any other test target (see
[Testing](/reference/js/testing/)), with these differences:

- **Its test files run together, in one run of the framework,** which schedules them across its
  own workers. So a change to anything the suite depends on runs every test file again, where
  other test targets run again only the files a change reaches, and the framework's own timeouts
  apply rather than fabr's.
- **A failed test is retried within the run,** by the framework, as the target's
  [`stability`](/reference/js/testing/#flaky-and-unstable-tests) allows: where it includes `flaky`, up to
  `TEST_FLAKE_RETRIES` times, and otherwise not at all, whatever your config's own `retries` says.
- **The files the framework keeps of its tests** (traces, screenshots, videos) are kept with the
  result, and `fabr test --artifacts=<dir>` copies them out: see
  [Traces and screenshots](#traces-and-screenshots).
- **`fabr test --coverage` measures nothing,** since the code a browser suite exercises runs in the
  browser and in the server it tests, not in the test processes.
- **A [`setupTests`](/reference/js/testing/#a-setup-file) file runs where the framework runs
  setup:** once before any test as Playwright's `globalSetup`, or before every spec as a Cypress
  support file.
- **`fabr run <target>` opens the framework's interactive run** over the suite: see
  [Running a suite interactively](#running-a-suite-interactively).

## The browser

`browser` is the browser the target's tests run in, with these settings beside it:

| Property     | Value                                                                                                                                                                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser`    | One of the two kinds below. Unset, the suite runs in its framework's own default browser: Playwright's Chromium, or Cypress's Electron.                                                                                                                |
| `viewport`   | The page's size, `<width>x<height>`, such as `1280x720`.                                                                                                                                                                                              |
| `user_agent` | The user agent the browser reports.                                                                                                                                                                                                                   |
| `device`     | Playwright only: a device it emulates, by its name in Playwright's [device list](https://playwright.dev/docs/emulation#devices), such as `"iPhone 15"`, with that device's viewport, user agent, touch and scale factor. A `viewport` or `user_agent` beside it takes precedence. |

A `browser` is either of these:

- **`@browser:chrome:<version>`**: a Chrome for Testing build you choose, under either framework.
  A full version (`@browser:chrome:156.0.8078.4`) is that build; a milestone
  (`@browser:chrome:156`) is the first build on that milestone's release branch.
  `fabr ls @browser:chrome` lists the builds.
- **`playwright/chromium`, `playwright/firefox`, `playwright/webkit`**: under Playwright, its own
  build of that browser, the one your `@playwright/test` pins for the machine the tests run on,
  exactly as `playwright install` would choose it.

Fabr downloads the browser itself, into its cache, through the same proxy settings
(`HTTPS_PROXY`) and retries as every other download, so no `playwright install` or
`cypress install` step is needed. A browser keeps one location while its build is unchanged, so a
firewall's permission for it holds from run to run. On Linux the browser still needs the machine's
own system libraries; see
[Browsers need the machine's own libraries](/known-limitations/#browsers-need-the-machines-own-libraries).

## Testing in several browsers

Declare a target for each browser, sharing the rest of their settings through a
[map](/reference/syntax/#splicing-a-map-into-a-target):

```
E2E = {
  tests = e2e:tests/**/*.spec.ts;
  deps = e2e:**/*.ts @npm:@playwright/test:1.64.0 @npm:@types/node:22.15.3;
  base_url = https://staging.example.com/;
  expectations = e2e:tests/**/*-snapshots/**;
}
browser_test desktop { E2E; browser = playwright/chromium; }
browser_test oldest { E2E; browser = @browser:chrome:150; viewport = 1280x720; }
browser_test mobile { E2E; browser = playwright/webkit; device = "iPhone 15"; }
```

Each is then built, cached and reported apart: `fabr test desktop mobile` runs two of them, side
by side, and a failure in one doesn't run the others again.

## Running a suite interactively

`fabr run <target>` opens the framework's own interactive run over the target's tests, in its
browser, with the arguments after the target name passed on: under Playwright,
`playwright test <arguments>`, and under Cypress, `cypress open <arguments>`.

```sh
fabr run desktop --ui           # Playwright's UI mode
fabr run desktop --headed       # run the tests in a visible browser window
fabr run desktop --debug        # step through the tests in Playwright's inspector
fabr run desktop login --headed # only the files matching "login"
fabr run e2e                    # under Cypress: the Cypress app, its spec list the target's tests
```

The tests are compiled and set up exactly as `fabr test` runs them: the same browser, `base_url`,
`env`, browser settings and `setupTests`. The run reports through your config's own reporters
rather than fabr's, so `fabr run desktop --reporter=html` writes Playwright's HTML report, and
the run itself isn't cached. With `fabr run -w`, fabr recompiles the tests when you change them
and updates the compiled files in place, without restarting the app, so Playwright's UI mode and
the Cypress app see the change as they would a change to your own files.

Under `fabr run`, files the run writes stay in its staging directory in fabr's cache: Playwright's
`--update-snapshots` doesn't update your `expectations` (use `fabr test -u`), and an HTML report
or a trace opens from where Playwright says it wrote it. Cypress's `--config` and `--project`
are fabr's to set; put your settings in the suite's `cypress.config.ts`.

## Playwright

Under `framework = playwright` (the default), a `browser_test` runs a
[Playwright Test](https://playwright.dev/docs/intro) suite with the `@playwright/test` you
declare, and your suite's `playwright.config.ts` where it has one. Fabr compiles the suite,
fetches the browser, and runs the target's test files in one Playwright run, which schedules them
across your config's `workers` as `playwright test` does. The run has one project, named after the
target and running in its [browser](#the-browser). Results, retries and recorded screenshots then
work as for any other test target.

### What to declare

- **`tests`**: the spec files. They run together, so a change to anything they depend on runs all
  of them again, where other test targets run again only the files a change reaches.
- **`deps`**: `@playwright/test` (1.50 or later), the other packages the suite imports, and the
  suite's other source files: helpers, fixtures, `playwright.config.ts`, and its
  [`globalSetup`](#signing-in-once) or [`setupTests`](/reference/js/testing/#a-setup-file). As for any test target, the
  [`layout/pnp` flag](/reference/js/testing/#how-tests-find-their-packages) among them resolves packages through a PnP
  table rather than a `node_modules` tree.
- **`compile_deps = dom;`** where code in the suite runs in the page, such as a
  `page.evaluate` callback. That gives the suite the DOM's types; tests still run under Node.js.
  Putting `dom` in `deps` fails with
  `Playwright tests run under node, not in a DOM: move 'dom' to the target's compile_deps`.
- **`base_url`**: the URL the suite runs against. Fabr sets it as `use.baseURL`, so
  `page.goto("/")` and the `baseURL` fixture use it. Derive any other URL your suite needs from it
  in the suite's own code.
- **`browser`**, and its `viewport`, `user_agent` and `device`: see [The browser](#the-browser).
- **`expectations`**: recorded screenshots and snapshots, in the `*-snapshots` directories beside
  your spec files. See [Screenshots and snapshots](#screenshots-and-snapshots).
- **`env`**: the environment variables the tests run with, which are
  [the only ones they see](/reference/js/testing/#environment-variables). A config that reads `process.env.CI` sees it
  only where `env` sets it.
- **`stability`**: against a server outside the build, such as a staging deployment, use
  `stability = unstable;`, so that results are never served from the cache, or
  `stability = unstable flaky;` where its tests also fail by chance. See
  [Flaky and unstable tests](/reference/js/testing/#flaky-and-unstable-tests).

### The config

A source named `playwright.config` (`.ts` or `.js`) at the root of the target's source tree is your
suite's config, as Playwright's own command finds it; without one, Playwright's defaults apply.
Fabr uses it as written, except for the settings it owns:

| Setting                   | Under fabr                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects`                | Refused, with `The Playwright config defines projects, and a browser_test is one`: [declare a target for each browser](#testing-in-several-browsers), and sign in from [`globalSetup`](#signing-in-once). |
| `testMatch`, `testIgnore` | Applied to choose which files run, matched against the source file names you wrote them for, in a release build as in a debug one.                                      |
| `reporter`                | Replaced by fabr's report.                                                                                                                                                |
| `workers`                 | Your config's own: each test's `parallelIndex` and `TEST_PARALLEL_INDEX` mean what they do under `playwright test`.                                                     |
| `outputDir`               | A directory fabr chooses for each run.                                                                                                                                    |
| `updateSnapshots`         | `none`, or `changed` under `fabr test -u`.                                                                                                                                |
| `grep`                    | Your config's own, with [`fabr test -t`](/reference/js/testing/#running-tests) applied as Playwright's `--grep` where you give it.                                                             |
| `retries`                 | The target's [`stability`](/reference/js/testing/#flaky-and-unstable-tests): where it includes `flaky`, a failed test is retried within the run up to `TEST_FLAKE_RETRIES` times, and otherwise not at all. |
| `shard`                   | Not used.                                                                                                                                                                 |
| `use.baseURL`             | `base_url`, where the target sets it.                                                                                                                                     |

`globalSetup` and `globalTeardown` may name a TypeScript file (`./global-setup.ts`): fabr runs the
file it compiled from it.

### Signing in once

A suite that signs in once and reuses the session does so from the config's
[`globalSetup`](https://playwright.dev/docs/test-global-setup-teardown#option-2-configure-globalsetup-and-globalteardown),
saving the browser's state to a file the tests start from:

```ts
export default defineConfig({
  globalSetup: "./auth.setup.ts",
  use: { storageState: "auth.json" },
});
```

A [`setupTests`](/reference/js/testing/#a-setup-file) file at the root of the source tree does the same with no
`globalSetup` in the config.

`globalSetup`, `globalTeardown` and a `webServer` run once for each target's run, so a suite split
into a target per browser signs in once per target. Playwright's setup projects, which other
projects name in `dependencies`, aren't available, since a config's `projects` are refused.

### Screenshots and snapshots

`toHaveScreenshot`, `toMatchSnapshot` and `toMatchAriaSnapshot` compare against the records you
declare in `expectations`. A missing or different record fails the test with
`Run 'fabr test -u' to record the new value.`; `fabr test -u` records it beside the spec file, as
Playwright does, in `tests/login.spec.ts-snapshots/`.

Playwright names a screenshot for the run's project, which is the target, and the platform it was
taken on, as `home-e2e-linux.png`. So each target records its own screenshots, and a run on macOS
needs records of its own.

A `snapshotPathTemplate` of your own works where the records' path includes the spec file's name
(`{testFileName}` or `{testFilePath}`) and is relative to the test directory. A record placed in no
directory named for its spec file is updated by `fabr test -u` but never created.

### Traces and screenshots

What your config tells Playwright to keep of a test (`trace`, `screenshot` and `video` under
`use`, such as `trace: "retain-on-failure"`) is kept with the target's result, so a cached failed
run still has the traces of its failures. Copy them out with `--artifacts`:

```sh
fabr test --artifacts=test-results e2e
```

This writes them under `test-results/e2e/`, named as Playwright names them
(`login-spec-signs-in-e2e/trace.zip`), whether or not the tests passed, replacing what that
directory held. Open a trace with Playwright's own viewer,
`fabr run @npm:@playwright/test:1.64.0 show-trace <trace.zip>`, with the version your suite uses.
Playwright's HTML report isn't made.

### What differs from Playwright

- **The browser is fetched into fabr's cache,** not Playwright's own
  (`~/Library/Caches/ms-playwright` on macOS), and by fabr rather than Playwright's installer. A
  download mirror set with `PLAYWRIGHT_DOWNLOAD_HOST`, in the environment you run fabr in, still
  applies to Playwright's builds.
- **The tests are compiled to ES2017 or later** whatever the target's `JS_TARGET`, because
  Playwright reads a test's fixtures from its source, which an earlier ES level rewrites.
- **A test is named `suite › title`**: the run's one project is the target, so its name isn't
  repeated in each test's.
- **`--ui`, `--headed` and `--debug` are `fabr run` options**, not `fabr test` ones: see
  [Running a suite interactively](#running-a-suite-interactively).
- **A `webServer` in your config** starts its command with only the variables in `env`, so a
  command found through your shell's `PATH`, such as `npm run start`, isn't found.
- **A [`setupTests`](/reference/js/testing/#a-setup-file) file is the run's `globalSetup`**, run once before any test,
  not a file loaded in every worker: per-test setup in Playwright belongs in a fixture.

## Cypress

Under `framework = cypress`, a `browser_test` runs a [Cypress](https://docs.cypress.io) end-to-end
suite with the `cypress` package you declare and your suite's `cypress.config.ts` where it has
one. Fabr compiles the specs, fetches the Cypress app and the [browser](#the-browser), and runs
every spec in one `cypress run`.

```
browser_test e2e {
  framework = cypress;
  tests = e2e:**/*.cy.ts;
  deps = e2e:cypress.config.ts e2e:support/**/*.ts @npm:cypress:16.3.0;
  base_url = http://localhost:8080/;
  browser = @browser:chrome:156;
}
```

### What a Cypress suite declares

- **`tests`**: the spec files.
- **`deps`**: `cypress`, the other packages the specs import, and the suite's other source files:
  its `cypress.config.ts`, at the root of the target's source tree, and its support file. Without
  a config, Cypress's defaults apply, with no support file unless one is at Cypress's default
  location, `cypress/support/e2e.ts`. Cypress's own dependencies include several versions of some
  packages, so a Cypress target's packages are resolved as a tool's are, and conflicting versions
  among them aren't refused.
- **`base_url`**: the URL the suite runs against: Cypress's `baseUrl`, so `cy.visit("/")` uses
  it.
- **`browser`**: a browser fabr fetches (`@browser:chrome:<version>`; see
  [The browser](#the-browser)), with its `viewport` and `user_agent` as Cypress's
  `viewportWidth`/`viewportHeight` and `userAgent`. Unset, the specs run in Cypress's own
  Electron. Playwright's builds and `device` mean nothing to Cypress, and fail the target.
- **`resources`**: files the specs read or visit, such as a page `cy.visit("index.html")` opens,
  staged beside the compiled specs, where Cypress serves files from.
- **`env`** and **`stability`**, as for any other test target.

Fabr downloads the Cypress app the `cypress` package runs, for the version you declare, into its
cache, through the same proxy settings as every other download, and marks it verified, so no
`cypress install` or `cypress verify` step is needed.

### What differs from Cypress

- **The specs that run are the target's `tests`**, whatever your config's `specPattern` says. Use
  [`-T`](/reference/js/testing/#running-tests) to run some of them.
- **`fabr test -t` works as for any other framework**: a regular expression matched against each
  test's full name, with no plugin to install. Fabr runs a small support file of its own, which
  loads yours first.
- **A `supportFile` naming a TypeScript source**, such as `cypress/support/e2e.ts`, runs its
  compiled file, as the specs do.
- **A [`setupTests`](/reference/js/testing/#a-setup-file) file** at the root of the source tree, listed in `deps`, runs
  before every spec after your `supportFile`, as a second support file.
- **Screenshots and videos are kept with the result**, and copied out with `--artifacts` as a
  Playwright suite's are (see [Traces and screenshots](#traces-and-screenshots)).
- **Cypress compares against no recorded files**, so `expectations` and `fabr test -u` change
  nothing.
- **Tests compile to CommonJS**, which Cypress bundles itself.
- **`cypress open` is `fabr run`**: see [Running a suite interactively](#running-a-suite-interactively).

## Troubleshooting

| What you see | Cause | What to do |
| --- | --- | --- |
| `'playwright' tests drive a browser, which a browser_test supplies` | A `js_test` or `js_package` names `playwright` or `cypress` as its framework | Declare a `browser_test` for the suite. |
| `a browser test runs in one browser: declare a browser_test for each` | `browser` names more than one browser | Declare a target for each browser; see [Testing in several browsers](#testing-in-several-browsers). |
| `'playwright/webkit' is a Playwright build, which this framework does not run` | A `playwright/<name>` browser under Cypress | Name a browser fabr fetches, such as `@browser:chrome:156`. |
| `this framework runs no devices` | `device` under Cypress | Set `viewport` and `user_agent` instead. |
| `'…' is not a viewport (expected '<width>x<height>', such as '1280x720')` | A `viewport` in another form | Write it as `<width>x<height>`. |
| `Playwright knows no device '…'` | A `device` that isn't in Playwright's device list | Use the name as Playwright's [device list](https://playwright.dev/docs/emulation#devices) spells it, quoted where it has spaces. |
| `These tests run under Playwright, but '@playwright/test' is not among the target's dependencies.` | `@playwright/test` isn't in `deps` | Add it to `deps`. |
| `fabr runs Playwright 1.50 or later, but the target's @playwright/test is …` | An older `@playwright/test` | Use 1.50 or later. |
| `The Playwright config defines projects, and a browser_test is one` | The config has `projects` | Remove them, and [declare a target for each browser](#testing-in-several-browsers). |
| `The Playwright config names a globalSetup, and the suite has a setupTests file` | Both a `globalSetup` and a `setupTests` file | Keep one of them. |
| `These specs run under Cypress, but 'cypress' is not among the target's dependencies.` | `cypress` isn't in `deps` | Add `@npm:cypress:<version>` to `deps`. |
| `Playwright tests run under node, not in a DOM`, or `Cypress specs are run by Cypress, not in a DOM` | `dom` is in `deps` | Move `dom` to `compile_deps`. |
| `fabr sets the config and project Cypress opens` | `fabr run` given Cypress's `--config`, `--config-file` or `--project` | Put the settings in the suite's `cypress.config.ts`. |
