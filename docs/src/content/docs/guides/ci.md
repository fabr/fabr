---
title: Continuous integration
description: How to run fabr in CI — installing it, what to cache, what its output and exit status look like, collecting test results, coverage, security advisories and traces, and what isn't available yet.
---

Running fabr in CI needs little setup: install Node.js and fabr, run the same commands you run
locally, and keep fabr's cache between runs. There is no dependency install step, because fabr
fetches packages, and the Node.js release your tools and tests run on, as part of the build.

```yaml
# GitHub Actions
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: 22
  - run: npm install -g @fabr-build/cli@0.4.0
  - uses: actions/cache@v4
    with:
      path: ~/.cache/fabr
      key: fabr-${{ runner.os }}-${{ runner.arch }}-${{ github.sha }}
      restore-keys: fabr-${{ runner.os }}-${{ runner.arch }}-
  - run: fabr test --report reports/tests.xml --format junit @acme/core @acme/app
  - run: fabr build release
```

## Install

Fabr needs Node.js 22.19 or later, and `node` on the `PATH`, to run itself. That is the only use
of the runner's Node.js: your tools and tests run on the release the
[`NODE` setting](/reference/js/dependencies/#the-nodejs-version) names, which fabr downloads and
keeps in its cache, so the version `actions/setup-node` installs doesn't affect what is built.

Install a specific version of `@fabr-build/cli`, so that CI and your team use the same one; a
build file has no way to require a fabr version. `fabr --version` prints what is installed.

## Choose what to run

Run the same commands you would locally, naming what the repository produces and what you want
tested; fabr builds everything those depend on. There is no "everything" form, and there doesn't
need to be: a package nothing you name depends on isn't needed for this commit's result.

- **`fabr test` the targets whose tests should pass.** It builds what the tests need, so these
  targets need no separate `fabr build` step. It runs only the named targets' tests, not those of
  the packages they depend on, so name each package whose tests you want run.
- **`fabr build` what you ship that has no tests**: the application you deploy, or the
  [`sync` target](/reference/js/publishing/#publishing-with-sync) that publishes your packages.
  Building a `sync` target produces exactly what would be uploaded, without uploading it.
- **`fabr build` your checks**: a lint or format check is a target like any other that fails the
  build when the check fails; see [A step that checks](/guides/tools/#a-step-that-checks).

When the list of tested targets is long, or shared with your team, declare it once as a property
and name that:

```
TESTED = @acme/core @acme/app @acme/cli;
```

```sh
fabr test TESTED
```

The list is kept by hand, so add each new package to it. See
[Projects with several packages](/guides/multi-package/#build-what-you-ship).

A command given no targets fails with `The 'build' command requires a target`, so a step whose
target list comes out empty, for example from an unset variable, fails and doesn't pass by doing
nothing.

## Exit status

Fabr exits with status 0 when everything named was built and every test passed, and with 1 for
anything else, a failing test and a build error alike; the output says which. `fabr audit` exits
with 1 when it finds an advisory. A run interrupted by `SIGINT`, `SIGTERM` or `SIGHUP` stops its
running steps first and exits with 130, 143 or 129. The
[command-line reference](/reference/command-line/#exit-status) lists every status.

`fabr test` runs every named target's tests to the end, writes its reports and only then exits
with 1, so a step after it that collects results gets them all; see [Test results](#test-results).

## Output

Without a terminal, fabr writes a plain log to stderr, one line when each step starts and one when
it ends:

```
info:Compiling @acme/core (required by @acme/app)
info:✓ Compiling @acme/core (734ms)
info:Testing @acme/core
info:✓ Testing @acme/core (413ms)
info:@acme/core: 12 tests passed
info:Built @acme/core
```

Output from the tools that steps run is included as it arrives, each line marked with the target
it belongs to (`@acme/core out| …`). Errors are printed as blocks pointing at the line of the
build file or source responsible, and the log ends with `error:Build failed`.

- **Colour is off** when stderr isn't a terminal, and can't be forced on. `NO_COLOR` turns it off
  on a terminal.
- **`-q`** leaves out the start lines and the tools' output, keeping completion lines and errors.
  A step that fails still shows its output.
- **There is no machine-readable log**, and no annotations for GitHub or other CI systems.

Data that a command prints, such as a `fabr ls` listing or `fabr cat` contents, goes to stdout,
separate from the log.

## Cache

Fabr's cache holds downloaded packages and the result of every build step and test run.
Keeping it between CI runs is what makes them fast: an unchanged project downloads and rebuilds
nothing, and a change rebuilds only what depends on it.

The cache is a directory on the machine: `~/.cache/fabr` on Linux and `~/Library/Caches/fabr` on
macOS. To put it somewhere else, set `FABR_CACHE_DIR`, and keep it outside the project directory
so that no source pattern can match its contents. Keep it on a local disk: like most build
caches, it relies on renames being atomic, which network filesystems such as NFS don't reliably
guarantee. There is no shared or remote cache for several machines to use at once, so in CI you
save the directory at the end of a run and restore it at the start of the next.

### Saving it

- **Save it on every run**, with a key that changes each time and a prefix to restore from, as in
  the example at the top of this page. A cache saved once and never updated stops matching as the
  project changes.
- **Key it by operating system and architecture.** Platform-specific packages, the Node.js
  release, and the results built with them differ between platforms, so a cache shared across
  them mostly grows. The runner's own Node.js version doesn't need to be in the key.
- **Save it after `fabr` has finished**, not while it is running. A finished run leaves nothing
  half-written behind.
- **Use an archive format that keeps hardlinks and modification times.** The cache stores each
  unpacked package file once and hardlinks it into place, and it judges how recently an entry
  was used by its modification time.
  - `tar` keeps both, so `actions/cache` and other tar-based caches need nothing special.
  - A zip-based cache, or a copy made without `rsync -H` or `cp -a`, turns each hardlink into a
    second copy. The restored cache still works, but it is larger, and stays larger.
  - An archive that resets modification times stops the automatic trimming described below from
    removing anything.

### Restoring it

A restored cache can't make a build produce the wrong result by being out of date. A cached
result is used only when the inputs that produced it are unchanged, so a cache from an older
commit, another branch or another machine is used where it still applies and ignored where it
doesn't. A missing or damaged entry is rebuilt, and deleting the whole cache is always safe.

Two things qualify that:

- **Fabr trusts the contents of its cache.** It doesn't check a restored entry against anything,
  so whoever can write the cache can decide what a build produces. Don't restore, into a job that
  publishes or deploys, a cache that an untrusted job could have saved. On GitHub, a pull request
  from a fork can't write to the base branch's cache; with other systems and self-hosted runners,
  check how caches are scoped, or publish from a job that starts with an empty cache.
- **The programs a script starts aren't tracked.** A [`script`](/reference/standard-rules/#script)
  target finds them on the runner, and a cache restored into a job with different ones serves
  results built with the old ones. See
  [Known limitations](/known-limitations/#programs-a-shell-script-starts-are-not-tracked).

### Size

Fabr trims the cache itself. About once a day, at the end of a run, it removes entries that
haven't been used for 30 days. There is no command or setting for this. In CI the trimmed cache
only replaces the stored one if that run's cache is saved, which is another reason to save on
every run.

`fabr run` also keeps the installed files of each program it runs in the cache, to reuse on the
next run. In CI they add to the size of the saved cache, and are trimmed like anything else once
they go unused for 30 days.

## Test results

`fabr test` prints a summary for each name you give and the details of each failure, and fails
when any test failed. To give your CI system the results too, write them to a file with
`--report`: as JUnit XML, which CircleCI's `store_test_results`, GitLab, Jenkins and most others
read, or as a
[CTRF](https://ctrf.io) report:

```sh
fabr test --report reports/tests.xml --format junit TESTED
```

The file holds the results of every target tested, one test suite per test file, with each failed
test's message. It is written whether or not the tests pass, before the command fails for any that
didn't, so collect it in a step that runs after a failure too. A build error that stops the run
before the tests finish writes no file.

```yaml
# GitHub Actions: keep the report even when the tests fail
  - run: fabr test --report reports/tests.xml --format junit TESTED
  - uses: actions/upload-artifact@v4
    if: always()
    with:
      name: test-results
      path: reports/
```

A failed test run is cached like a passing one, so running the same commit again, as a CI retry
does, reports the same failures without running the tests. To run them again, for a test you
suspect is flaky, add `--retry-failed`.

Each target's own report is also kept as `ctrf-report.json`, which `fabr cp` copies out, failures
and all:

```sh
fabr cp '@acme/core<BUILD_OPERATION=test>:ctrf-report.json' reports/core
```

## Coverage

`fabr test --coverage` also measures code coverage. It prints a summary line and writes an lcov
report, which Codecov, Coveralls, SonarQube and most CI coverage tools read:

```sh
fabr test --coverage=reports/coverage TESTED
```

This writes `reports/coverage/lcov.info`, with each source named by its path in your project;
`--coverage` alone writes `coverage/lcov.info`. The directory is relative to the current
directory. Coverage is reported whether or not the tests pass. A run with
`--coverage` is cached separately from one without it, so a job that always passes `--coverage`
reuses its own earlier results. [Testing](/reference/js/testing/#coverage) describes what is
measured.

## Security advisories

`fabr audit` checks the packages your targets depend on against the [OSV](https://osv.dev)
database and exits with status 1 when any advisory affects one of them; see
[Auditing dependencies](/guides/auditing/) for what it checks and how to act on a finding. In CI,
write the report as SARIF and upload it, so that each advisory appears as a code-scanning alert
at the line of your build file that brings the package in:

```yaml
# GitHub Actions: show advisories as code-scanning alerts
  - run: fabr audit --format sarif @acme/app > audit.sarif
    continue-on-error: true
  - uses: github/codeql-action/upload-sarif@v3
    with:
      sarif_file: audit.sarif
```

Drop `continue-on-error` to fail the job instead. An audit that couldn't run, for instance because
the advisory database couldn't be reached, also exits with 1 and leaves `audit.sarif` empty, so
`continue-on-error` hides that failure from the audit step; the error is in its log. Advisories are read fresh on each run and never cached, so a commit that
passed yesterday can fail today when a new advisory is published; run the audit in a job of its
own, or on a schedule, if that shouldn't block a merge.

## Software bill of materials

`fabr sbom` writes a [CycloneDX](https://cyclonedx.org) bill of materials of a target's
dependencies to stdout. Keep it with each release, or hand it to a dependency-tracking service:

```yaml
# GitHub Actions: keep the SBOM with the build
  - run: fabr sbom -q @acme/app > app.cdx.json
  - uses: actions/upload-artifact@v4
    with:
      name: sbom
      path: app.cdx.json
```

It downloads no packages, and the same sources give the same file. See
[Writing a bill of materials](/guides/auditing/#writing-a-bill-of-materials).

## Finding out where a run's time goes

`--trace` on `fabr build`, `fabr test` or `fabr run` writes a timeline of the work the run did,
which [Perfetto](https://ui.perfetto.dev) opens. Keep it as an artifact to see why a CI run was
slow: which steps ran, what ran in parallel, and where the run waited.

```sh
fabr test --trace=reports/trace.json TESTED
```

Work served from the cache doesn't appear in the trace. See
[Tracing a run](/reference/command-line/#tracing-a-run).

## Network access

Fabr contacts the npm registry (or the registry `NPM_REPOSITORY_URL` names), the hosts that
registry's packages are downloaded from, `nodejs.org` and `unofficial-builds.nodejs.org` for the
Node.js release, and the URLs of any `fetch` targets. A Java build also contacts Maven Central (or
the repository `MAVEN_REPOSITORY_URL` names) and `api.adoptium.net` for the JDK, and `fabr audit`
contacts `api.osv.dev`.

- **A build whose packages and Node.js release are all in the cache makes no requests.**
  Published versions are never re-fetched. The exception is a list that can change, such as
  nodejs.org's list of releases when `NODE` names a version range, or a Maven package's versions
  when a requirement names a range: fabr checks it again at most once a day, or on every run given
  `--refresh`. Write exact versions to avoid it.
- **Proxies** are taken from `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`.
- **Private registries** take credentials from `.npmrc`, where a value can come from the
  environment: `//npm.example.com/:_authToken=${NPM_TOKEN}`. See
  [Private registries](/reference/js/dependencies/#private-registries).
- **A download that fails transiently is retried** twice, after one second and then four: a
  connection that is refused, drops or times out, or a `408`, `429` or `5xx` response. Any other
  failure, or a third failure, fails the build; run it again, and what was downloaded before the
  failure is kept.

## Build steps and the environment

Build steps and tests don't see the CI environment. They run with no environment variables other
than the ones a target declares (`test_env`, or `env` on a `generate`), so a secret or a `CI`
variable has to be passed deliberately. `fabr run` is the exception: the program it runs gets the
whole environment.

Fabr runs as many steps at once as the machine has processors, and each test file is one of those
steps. There is no option to lower that number. On a runner with many processors and little
memory, limit each test process instead, with `NODE_OPTIONS` in `test_env`.

## Publishing from CI

`fabr sync` publishes packages; see [Publishing packages](/reference/js/publishing/). In CI:

- Make sure each `sync` entry requires a release build (`= @acme/core<BUILD_TYPE=release>;`), so
  that the published packages don't depend on how the step is invoked.
- Provide a token through `.npmrc` that can publish without a one-time password. With no terminal
  fabr can't ask for one.
- Running `fabr sync` again after a partial failure is safe: versions already published are
  skipped.

## Not supported

- **A shared or remote cache.**
- **A limit on parallel steps.**
- **A machine-readable log, or CI annotations.** `--report` and `--trace` write the test results
  and the timeline as files, but the log itself is plain text.
- **A report of outdated dependencies.**
