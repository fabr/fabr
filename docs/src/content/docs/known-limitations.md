---
title: Known limitations
description: Current limitations and rough edges in fabr you should be aware of — shell scripts' host tools, optional npm dependencies, and cache concurrency.
---

Fabr builds, tests and runs real JavaScript, TypeScript and Java projects, itself included, but it
is under active development. This page lists the places where its present behaviour falls short
of what it intends, with a workaround for each. Limits of a particular feature are documented with
that feature: see [Testing](/reference/js/testing/),
[Stylesheets](/reference/js/stylesheets/#not-supported) and
[TypeScript compilation](/reference/js/typescript/) for JavaScript, and the "Not supported"
sections of the [Java reference](/reference/java/dependencies/#not-supported) pages.

| Limitation | Effect |
|---|---|
| [Shell scripts use the `sh` on your machine](#shell-scripts-run-on-the-sh-on-your-machine) | A different `sh`, or a different program a script runs, can change results without fabr noticing. |
| [Optional dependencies required as `*` are dropped](#optional-npm-dependencies-required-only-as--are-left-out-silently) | Such a dependency is missing, with no warning. |
| [No lock between fabr processes](#concurrent-fabr-processes-duplicate-work-rather-than-sharing-it) | Two builds at once may each do the same work; deleting the cache under `fabr run` removes the running program. |

## Shell scripts run on the `sh` on your machine

Fabr intends a build to depend only on its
[declared inputs](/introduction/#the-same-result-every-time). JavaScript programs meet that: they
run on the Node.js release that the [`NODE` setting](/reference/js/dependencies/#the-nodejs-version)
names, which fabr downloads and tracks like any other input. A [`script`](/reference/standard-rules/#script)
target is the exception. It runs under the `sh` that fabr finds on your `PATH`, and what fabr records
about it is only its name: not where it was found, and not which shell or version it is. The same
goes for any program the script starts.

So **a different `sh`, or a different version of a program a script runs, can change a result
without invalidating the cache.** Fabr reuses results built with the old one.

**Workaround:** write the step as a `js_script` where you can, so that it runs on the Node.js
release `NODE` names. Otherwise, keep the shell and the programs scripts use the same on machines
that should produce the same results, and delete the cache after changing them.

## Optional npm dependencies required only as `*` are left out silently

An optional dependency that packages require only as `*` (for example `fsevents: "*"`) has no
version that can be selected, so fabr leaves it out, currently without a warning.

**Workaround:** declare the dependency yourself with a version.

## Concurrent fabr processes duplicate work rather than sharing it

Within one `fabr` process, each piece of work is done once, however many targets need it. Between
processes there is no such coordination: two `fabr` runs at the same time that both need something
neither has built will each build it.

This costs time, not correctness. Each process works in a directory of its own and adds a result
to the cache in a single step, so two runs can't corrupt an entry between them.

**Workaround:** none is needed for correctness. To avoid the repeated work, don't start two
builds of the same unbuilt change at once, for example in two worktrees of one branch. Builds of
different changes, or of one already built, share the cache as usual.

Relatedly, `fabr run` installs the program it runs in the cache, and keeps the install there to
reuse on the next run, so deleting the cache while `fabr run` or `fabr run -w` is running deletes
the files of the program it is running. Stop the program first.
