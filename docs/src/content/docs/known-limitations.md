---
title: Known limitations
description: Current limitations and rough edges in fabr you should be aware of — host-tool hermeticity, test-runner support, and npm version resolution.
---

Fabr is an active experiment. It is fully self-hosting and builds, tests, and runs real
JavaScript/TypeScript projects, but several things are deliberately incomplete or behave differently
from the tools you may be used to. The most important ones to know about are below. (This page is
about present behaviour; planned features that simply don't exist yet are a separate matter.)

## Host tools aren't hermetically sealed

Fabr aims at [deterministic builds](/introduction/#determinism-and-no-lockfiles), but there is one
significant gap today: **host programs are not modelled as identified dependencies.** The `node`
interpreter used to run JavaScript, the `sh` used by shell scripts, and any other tool fabr invokes
on the host are found by a **`PATH` search**, and the resolved absolute path is what goes into the
build cache key.

Two consequences follow:

- **Builds aren't fully hermetic with respect to your toolchain.** A different build of `node` (or
  another host tool) can change outputs, but fabr captures only its path, not its identity — so a
  genuine toolchain change may not invalidate the cache, and a build isn't guaranteed reproducible
  across machines with different tools installed.
- **A `PATH` that changes every run defeats the cache.** If you launch fabr through a wrapper that
  rewrites `PATH` per invocation — most notably `yarn`, which prepends a fresh temp shim directory
  each time — the interpreter resolves to a different path every run, the cache key changes, and work
  that should have been a cache hit re-runs. `fabr test` under `yarn` never hits the cache for this
  reason.

**Workaround:** invoke fabr by a stable path — install the CLI and run `fabr` directly (or
`node …/cli/build/index.js`) rather than through a `PATH`-rewriting wrapper — and keep a consistent
host toolchain across the machines that share a cache. This is wasted recompute, not incorrect
output.

## Only fabr's own test runner is supported — not jest or vitest

`fabr test` runs tests under **fabr's own runner**, built on Node's `node:test`. It provides the
`describe`/`it`/`before`/`after` globals; you supply the assertion library yourself (list it in the
target's `test_deps` — [chai](https://www.chaijs.com/), for example) and import it explicitly.
Results are reported in [CTRF](https://ctrf.io) form.

**Popular third-party runners — [jest](https://jestjs.io) and
[vitest](https://vitest.dev) — are not supported.** Their APIs are not available: no `jest.mock` /
`vi.mock` module mocking, no `jest.fn` spies, no built-in snapshot testing, no auto-magic transforms
or their configuration. A suite written against jest or vitest will not run under `fabr test` as-is,
and there is currently no way to select an alternative runner.

**Workaround:** write tests against `node:test`-compatible globals plus a standalone assertion
library. Porting an existing jest/vitest suite means replacing the runner-specific pieces (mocks,
spies, snapshots) with plain equivalents.

## npm resolution uses MVS and can differ from npm/yarn

Fabr resolves npm dependencies by **[minimal version selection](/reference/js-rules/)** (MVS): for
each package it picks the highest of the *minimum* versions actually required across the build, with
**no lockfile**. This is deterministic and reproducible — the same requirements always select the
same versions — but it is a different algorithm from npm's and yarn's "newest version satisfying the
range at install time", so the results can differ:

- **The selected version may not match what `npm install` gives you.** If a package only works
  correctly with a version newer than anything your build actually requires, raise the floor with an
  explicit requirement (e.g. `@npm:some-pkg:1.4.2`) — MVS will never silently pick a newer version
  for you.
- **One version per major (per minor for 0.x) for anything you compile or link against.** If two
  parts of your build require incompatible majors of the same transitive dependency, that is a
  conflict you must resolve by pinning. (Sealed *tool* closures — a `js_script`/`script` and its
  `run` delivery — relax this and nest duplicate versions npm-style; the one-version rule still holds
  for everything a target compiles or links into its output.)
- **Install-time behaviours don't happen.** Fabr fetches and assembles package contents; it does not
  run `postinstall` scripts or auto-install peer dependencies the way an npm client would. A package
  that depends on such behaviour may not work out of the box.

**Workaround:** add explicit version requirements to raise floors, and use a
[`catalog`](/reference/js-rules/) to pin one consistent set of versions across a project. A genuine
need for two coexisting majors of a *linked* dependency is a current limitation.
