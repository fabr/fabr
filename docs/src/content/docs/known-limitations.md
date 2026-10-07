---
title: Known limitations
description: Current limitations and rough edges in fabr you should be aware of — host-tool hermeticity, npm install-time behaviour, cache concurrency, and watch-mode cleanup.
---

Fabr builds, tests and runs real JavaScript and TypeScript projects, itself included, but it is
under active development. This page lists the places where its present behaviour falls short of
what it intends, with a workaround for each. Limits of a particular feature are documented with
that feature: see [Testing](/reference/js/testing/),
[Stylesheets](/reference/js/stylesheets/#what-isnt-supported) and
[TypeScript compilation](/reference/js/typescript/).

| Limitation | Effect |
|---|---|
| [Programs on your machine aren't tracked](#host-tools-arent-hermetically-sealed-yet) | A different `node` can change results without fabr noticing; running fabr through `yarn` defeats the cache. |
| [npm install-time behaviour is missing](#npm-packages-that-rely-on-install-time-behaviour) | Packages that need a `postinstall` script may not work. |
| [No lock between fabr processes](#concurrent-fabr-processes-duplicate-work-rather-than-sharing-it) | Two builds at once may each do the same work. |
| [A force-killed watch leaves its program running](#watch-mode-can-leave-a-program-running-if-fabr-is-force-killed) | `kill -9` on fabr orphans the program it started. |

## Host tools aren't hermetically sealed yet

Fabr intends a build to depend only on its
[declared inputs](/introduction/#the-same-result-every-time). The programs it runs from your
machine are the exception today. `node`, which runs every JavaScript tool, and `sh`, which runs
shell scripts, are found by searching your `PATH`, and what fabr records about them is the path
where they were found, not which version they are.

- **A different `node` can change a result without invalidating the cache.** If you switch Node.js
  versions in place, at the same path, fabr reuses results built with the old one. Builds on two
  machines with different Node.js versions aren't guaranteed to match.
- **A `PATH` that changes on every run defeats the cache.** `yarn` puts a new temporary directory
  at the front of `PATH` each time it runs a command, so `node` is found at a different path on
  every run, and steps that should be reused run again. Under `yarn`, `fabr test` re-runs the
  tests every time for this reason.

**Workaround:** run `fabr` directly, not through `yarn` or another wrapper that changes `PATH`,
and use the same Node.js version on machines that should produce the same results. After
switching Node.js versions in place, delete the cache. The second problem costs time only; the
results are still correct.

## npm packages that rely on install-time behaviour

Fabr chooses dependency versions differently from npm, Yarn and pnpm, by
[minimal version selection](/reference/js/dependencies/#how-versions-are-chosen) and with no
lockfile; that is by design, and [Dependencies](/reference/js/dependencies/) describes it. Two
things a package manager does at install time are missing, though:

- **Install scripts aren't run.** A package that downloads or builds something in a `postinstall`
  script won't have done so, and may not work.
- **Unconstrained optional dependencies are skipped silently.** An optional dependency required
  only as `*` (for example `fsevents: "*"`) has no version that can be selected, so fabr leaves
  it out, currently without a warning.

**Workaround:** for an install script, look for a variant of the package that ships prebuilt
platform-specific packages, or [patch](/reference/js/dependencies/#patching-a-package) it. For a
skipped optional dependency, declare it yourself with a version.

## Concurrent fabr processes duplicate work rather than sharing it

Within one `fabr` process, each piece of work is done once, however many targets need it. Between
processes there is no such coordination: two `fabr` runs at the same time that both need something
neither has built will each build it.

This costs time, not correctness. Each process works in a directory of its own and adds a result
to the cache in a single step, so two runs can't corrupt an entry between them.

**Workaround:** none is needed for correctness. To avoid the repeated work, don't run two builds
of the same project at once, or give each its own cache with `FABR_CACHE_DIR`.

Relatedly, deleting the cache while a `fabr run` is in progress deletes the files of the program
it is running.

## Watch mode can leave a program running if fabr is force-killed

`fabr run -w` stops the program it started, along with any processes that program started,
whenever it restarts it and whenever fabr exits normally: on Ctrl-C, `SIGTERM`, `SIGHUP` or an
error. If fabr itself is killed with `SIGKILL`, by `kill -9` or by the system when memory runs
out, it gets no chance to do that, and the program keeps running with nothing supervising it.

**Workaround:** stop a watching fabr with Ctrl-C or `SIGTERM`. If a program is left behind, stop
it by hand; for a server, finding the process that holds its port is usually quickest.
