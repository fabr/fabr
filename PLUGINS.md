# Fabr plugins

Rule packages beyond the core engine are fabr *plugins*: ordinary npm packages, installed
alongside fabr, that contribute their build rules and `.fabr` library files to the host when a
project declares them. `@fabr-build/js` — the JavaScript/NPM ecosystem support — is itself a plugin and
the canonical example.

## Declaring

```
plugin @fabr-build/js;
```

- `plugin <packagename>;` may appear in any build file. A plugin declaration **auto-includes the
  plugin's own `.fabr` library files** — no separate `include` needed (declaring `@fabr-build/js` brings in
  its `JS.fabr`). Each plugin is activated once per build, in declaration order.
- **STD.fabr is always present** — core's library is included in every build without being named, so
  the generic `flag`/`script`/`generate` targetdefs are always available.
- Plugins are resolved by **module resolution only**: the package must be installed alongside the
  fabr host (for `@fabr-build/*` packages, they ship with the fabr installation). There is currently no
  option to build a plugin from source as part of the build that uses it. A plugin that cannot be
  resolved is an error.
- The only explicit `include` is a **path-relative** one — `include ./shared.fabr;`, resolved
  relative to the including file — for project-local shared `.fabr` files. There is no system include
  search path.

## The plugin contract

A plugin package's main entry point must export an `activate` function that **returns its
contribution** — the rules, repository types, and `.fabr` library files it provides. It performs no
registration and has no side effects; the host merges the returned `PluginContribution` into the
build model's rule tables and auto-includes its files.

```ts
import { packageLibFile, PluginContribution } from "@fabr-build/core";

export function activate(): PluginContribution {
  return {
    rules: [
      { type: "my_thing", constraints: { BUILD_OPERATION: "build" }, evaluate: buildMyThing },
    ],
    repositories: [{ type: "my_repository", provider: createMyRepository }],
    includes: [packageLibFile("@my/plugin", "MYLIB.fabr")],
  };
}
```

- `activate()` is a **pure function**: it takes no arguments, returns a `PluginContribution`, and
  registers nothing globally. It is called once per load (per build); a plugin declared from several
  files contributes once. A plugin reaches the host's facilities — helpers like `packageLibFile`,
  the `TargetContext` types, `Computable`, etc. — by **importing `@fabr-build/core` directly**. That is
  sound because a plugin always shares the host's single `@fabr-build/core` instance (see the single-copy
  requirement below); it must never load a second copy.
- `includes` are absolute paths to the plugin's own `.fabr` library files, auto-parsed and merged
  into the model when the plugin is declared. By convention a plugin ships them in `lib/`, next to
  its entry point, and names them with `packageLibFile("<its-own-name>", "FILE.fabr")` — which
  locates the file beside the package's resolved entry point, i.e. within the *built* package
  content, never a source tree. The `lib/` directory must therefore be packaged alongside the
  compiled code.
- `rules` — each `{ type?, constraints, evaluate }` contributes the implementation of a target
  type; omit `type` for a **default (all-types) rule**. The *schema* for a declared type (its
  `targetdef`) lives in the plugin's `.fabr` library files, not in code. Rule selection picks the
  rule whose constraints most specifically match the active configuration (`{}` is a wildcard); the
  `BUILD_OPERATION` constraint carries the build verb (`fabr test x` ≡ `x[BUILD_OPERATION=test]`),
  and an operation-specific rule must explicitly request `BUILD_OPERATION: "build"` for its
  dependencies, since constraints otherwise propagate.

  `evaluate(context: TargetContext)` is the rule body: read the target's properties and globals,
  materialize dependencies, compute layouts and generated files, and compose sub-targets — all
  through the `context` — then return a **`RuleResult`**. It never executes external tools and has
  no work directory: it either returns final content directly (a `FileSource`) or a
  **`BuildAction`** the framework caches and runs. The same rule serves declared and anonymous
  (sub-)targets identically — `context.getFileSet("srcs")` reads a declared property or a
  sub-target's supplied input transparently.

  - **To run a tool**, return a `BuildAction` — `new BuildAction(step, inputs, label?)`, or the
    `createExecAction(files, argv, outputs?)` helper. Its `step` (`{ id, version, run(inputs,
    workDir) }`) is the unit of build caching, keyed by `id:version` + a manifest of its concrete
    inputs (materialized FileSets and strings only); bump `version` when its behavior changes.
    Prefer `createExecAction`; write a bespoke step only where semantics demand it (e.g.
    `@fabr-build/js`'s `js:test-run`).
  - **To compose builds**, use `context.subTarget(type, inputs, {label, constraints})`. It builds
    an anonymous target of `type` and returns its cached output as a `Computable<FileSet>`, which
    you wire into a later action's inputs or reshape into final content. Actions never nest;
    composition is always via sub-targets.

  This document covers only the registration surface, not the evaluation/caching model
  these hang off.
- `repositories` — each `{ type, provider }` contributes a repository type. Repositories resolve
  requirements and are not rule-built targets: the provider is constructed lazily per build
  configuration against a narrow `RepositoryContext` (declared config properties,
  `memoize(tag, key, fn)` for resolution memos, `fetch(url, tag, process)` for downloads, and
  `notifyProgress` for resolve/fetch progress events).

## Module identity

The host and its plugins must share a single copy of `@fabr-build/core`: class identities (`instanceof`)
and the `Computable`/`FileSet`/etc. machinery a rule builds on must be the host's own. (The rule
tables themselves are *not* global — they are built per load from core's and the active plugins'
contributions and carried by the build model — but a plugin's `evaluate` still runs against the
host's core classes.) An installed plugin shares the host's `node_modules`, so importing `@fabr-build/core`
directly from plugin code is safe and normal (node resolves it to the host's instance). What a
plugin must never do is bundle or vendor its own copy of core.

Code that a plugin arranges to run in *client* processes — such as `@fabr-build/js`'s test runner, which
executes inside test working directories — is a different matter: it cannot reach the host's core
at runtime at all, and must be dependency-free (type-only imports of `@fabr-build/core` are fine, since
they erase at compile time).

## Anatomy of a plugin package

```
my-plugin/
  package.json          main -> the module exporting activate()
  index.js              activate(): returns rules + lib files
  lib/
    MYTHING.fabr        targetdefs, defaults, convenience targets
  ...rule modules...
```

Projects then write:

```
plugin @my/plugin;
include MYTHING.fabr;

my_thing hello {
  srcs = src:**;
}
```

## Current limitations

- No build-plugin-from-source: the package must be installed, because a plugin reaches `@fabr-build/core`
  by ordinary module resolution (a direct import). (A future variant may allow a plugin to be built
  by fabr itself and loaded from the build cache — but the cache directory has no `node_modules`, so
  it would first need a way to hand the cache-loaded module the host's own `@fabr-build/core` instance,
  the seam the old injected `api` argument once provided.)
- A plugin builds on `@fabr-build/core` only. It cannot build on another plugin's exports (e.g.
  `@fabr-build/js`'s compile-pipeline helpers) without loading a second copy of that plugin, so
  cross-plugin extension isn't supported yet.
- The available surface is the whole of `@fabr-build/core`, imported directly, and is not yet versioned or
  stable.
