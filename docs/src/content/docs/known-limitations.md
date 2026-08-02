---
title: Known limitations
description: Current limitations and rough edges in fabr you should be aware of — host-tool hermeticity, test-runner support, npm version resolution, cache concurrency, and watch-mode cleanup.
---

Fabr is under active development. It is fully self-hosting and builds, tests, and runs real
JavaScript/TypeScript projects, but several things are deliberately incomplete or behave differently
from the tools you may be used to. The most important ones to know about are below. (This page is
about present behaviour; planned features that simply don't exist yet are a separate matter.)

## Host tools aren't hermetically sealed yet

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
[vitest](https://vitest.dev) — are not yet supported.** Their APIs are not available: no `jest.mock` /
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
- **One version per package for anything you compile or link against.** Each package resolves to
  one version; requirements no single version can satisfy jointly (incompatible majors of a shared
  transitive, an exact pin against a higher floor) are a conflict, reported with the requirement
  chains on both sides and the override lines that would resolve it: a pin where a single
  satisfying version exists, a `?` alternate (`@npm:pkg:1.4.2?`) to sanction nesting the second
  version exactly where it is needed, or a `!` force (`@npm:pkg:2.0.0!`) to override an incorrect
  constraint. (Sealed *tool* closures — a `js_script`/`script` and its `run` delivery — nest
  conflicting versions npm-style without needing a sanction; the one-version rule holds for
  everything a target compiles or links into its output unless you sanction otherwise.)
- **Install-time behaviours don't happen.** Fabr fetches and assembles package contents; it does not
  run `postinstall` scripts or auto-install peer dependencies the way an npm client would. A package
  that depends on such behaviour may not work out of the box.
- **Unconstrained optional dependencies are skipped silently.** An optional dependency pinned only as
  `*` (for example `fsevents: "*"`) has no deterministic version under MVS and no lockfile to freeze
  one, so fabr drops it — the correct choice for reproducibility, but currently with no warning. If
  you need such an optional package, pin it with an explicit requirement.

**Workaround:** add explicit version requirements to raise floors, and use a
[`catalog`](/reference/js-rules/) to pin one consistent set of versions across a project. A genuine
need for two coexisting majors of a *linked* dependency is a current limitation.

## Concurrent fabr processes duplicate work rather than sharing it

Fabr deduplicates in-flight work and effectively write-locks cache entries **within a single
process**, so all of one build's internal parallelism is safe. There is, however, **no cross-process
lock** on the build cache: two fabr processes running at the same time that both miss the same entry
will each build it.

That costs time, not correctness. Everything transient lives in a per-process work tree
(`work/<host>-<pid>/`) and every commit into the store is atomic — a rename into the content pool,
temp-plus-rename for a manifest — so the two runs cannot interleave into a corrupt entry, and for a
deterministic build the loser's result is byte-identical to the winner's.

**Workaround:** none is needed for correctness. To avoid the duplicated work, don't run two fabr
builds against the same cache concurrently, or give each its own `FABR_CACHE_DIR`. Note also that
deleting the cache from under a *running* `fabr run`/`serve` removes the live staged install with
it.

## Watch mode can leave a program running if fabr is force-killed

`fabr run -w` (including on a `serve` target — there is no separate `serve` verb) supervises the
program it launches and tears down its whole process group
— including any workers it forked — on every restart and on every orderly exit (Ctrl-C, `SIGTERM`,
`SIGHUP`, or an uncaught error). But if fabr **itself** is force-killed — `SIGKILL`, an
out-of-memory kill, or a crash — nothing can run to clean up, and the launched program is orphaned,
left running with no supervisor. Only a hard kill of fabr does this; every ordinary way of stopping
it shuts the program down cleanly.

**Workaround:** stop a watching fabr with Ctrl-C or `SIGTERM` rather than `kill -9`. If a program is
orphaned, stop it by hand (for a server, finding it by the port it holds is usually easiest).

## A TypeScript source in a package's `deps` is emitted into the package

A target's `deps` can carry plain source files that it compiles against but doesn't distribute. A
`.d.ts` type-only file emits nothing and is correctly never shipped, but a **`.ts` source file** in
`deps` is compiled and its resulting `.js` currently ends up in the built **package** output.

**Workaround:** to share compiled TypeScript between targets, declare it as its own package and
depend on that, rather than adding the raw `.ts` file to `deps`.
