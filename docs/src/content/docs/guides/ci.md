---
title: Continuous integration
description: How to run fabr in CI — installing it, what to cache, what its output and exit status look like, collecting test results, and what isn't available yet.
---

Running fabr in CI needs little setup: install Node.js and fabr, run the same commands you run
locally, and keep fabr's cache between runs. There is no dependency install step, because fabr
fetches packages as part of the build.

```yaml
# GitHub Actions
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: 22
  - run: npm install -g @fabr-build/cli@0.2.1
  - uses: actions/cache@v4
    with:
      path: ~/.cache/fabr
      key: fabr-${{ runner.os }}-${{ runner.arch }}-${{ github.sha }}
      restore-keys: fabr-${{ runner.os }}-${{ runner.arch }}-
  - run: fabr test ALL
```

## Install

Fabr needs Node.js 22.19 or later, and `node` on the `PATH`.

Install a specific version of `@fabr-build/cli`, so that CI and your team use the same one; a
build file has no way to require a fabr version. `fabr --version` prints what is installed.

## Choose what to run

Name the targets: `fabr build` and `fabr test` have no "everything" form. For a project with
several targets, declare a property listing them and use it in CI:

```
ALL = @acme/core @acme/app @acme/cli;
```

```sh
fabr test ALL
```

`fabr test` builds what the tests need, so a separate `fabr build` step is only needed for targets
that have no tests.

A command given no targets fails with `The 'build' command requires a target`, so a step whose
target list comes out empty, for example from an unset variable, fails and doesn't pass by doing
nothing.

## Exit status

| Status | Meaning |
|---|---|
| 0 | Everything named was built, and all tests passed. |
| 1 | Anything else: a build error, a failing test, a dependency that couldn't be resolved, an unknown target or option, a command with no target, a failed `sync`. |
| 2 | An internal error in fabr. |
| 130, 143, 129 | Interrupted by `SIGINT`, `SIGTERM` or `SIGHUP`. Running steps are stopped first. |

`fabr run` exits with the status of the program it ran.

A failing test and a build error both give 1. The output says which.

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

Fabr's cache holds downloaded packages and the result of every build step and passing test run.
Keeping it between CI runs is what makes them fast: an unchanged project downloads and rebuilds
nothing, and a change rebuilds only what depends on it.

The cache is a directory on the machine: `~/.cache/fabr` on Linux and `~/Library/Caches/fabr` on
macOS. To put it somewhere else, set `FABR_CACHE_DIR`, and keep it outside the project directory
so that no source pattern can match its contents. There is no shared or remote cache for several
machines to use at once, so in CI you save the directory at the end of a run and restore it at the
start of the next.

### Saving it

- **Save it on every run**, with a key that changes each time and a prefix to restore from, as in
  the example at the top of this page. A cache saved once and never updated stops matching as the
  project changes.
- **Key it by operating system and architecture.** Platform-specific packages and the results
  built with them differ between platforms, so a cache shared across them mostly grows.
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
- **Tools on the runner aren't tracked by version.** If a runner image replaces `node` with a
  different version at the same path, results built with the old one are reused.
  `actions/setup-node` installs each version at its own path, so the problem doesn't arise there.
  See [Known limitations](/known-limitations/#host-tools-arent-hermetically-sealed-yet).

Run `fabr` directly, not through `yarn` or another wrapper that changes `PATH`: fabr records where
it found `node`, and a path that changes on each run makes steps run again.

### Size

Fabr trims the cache itself. About once a day, at the end of a run, it removes entries that
haven't been used for 30 days. There is no command or setting for this. In CI the trimmed cache
only replaces the stored one if that run's cache is saved, which is another reason to save on
every run.

## Test results

`fabr test` prints a summary for each target and the details of each failure. A target's results
are also kept as a [CTRF](https://ctrf.io) report, `ctrf-report.json`, which many CI systems can
display. Copy it out after the tests have run:

```sh
fabr test @acme/core
fabr cp '@acme/core<BUILD_OPERATION=test>:ctrf-report.json' reports/core
```

The report exists only for a passing run. When tests fail, the failures are in the log and there
is no report to collect.

## Network access

Fabr contacts the npm registry (or the registry `NPM_REPOSITORY_URL` names), the hosts that
registry's packages are downloaded from, and the URLs of any `fetch` targets.

- **A build whose packages are all in the cache makes no requests.** Published versions are never
  re-fetched.
- **Proxies** are taken from `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`.
- **Private registries** take credentials from `.npmrc`, where a value can come from the
  environment: `//npm.example.com/:_authToken=${NPM_TOKEN}`. See
  [Private registries](/reference/js/dependencies/#private-registries).
- **Downloads aren't retried.** A network failure fails the build; run it again, and what was
  downloaded before the failure is kept.

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

## What isn't supported

- **A shared or remote cache.**
- **A limit on parallel steps.**
- **A machine-readable log, or CI annotations.**
- **A test report for a failing run.**
- **Coverage reports.**
- **Building in a container image, lint and format steps, and reports of outdated or vulnerable
  dependencies** aren't part of fabr yet.
