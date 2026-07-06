# Fabr plugins

Rule packages beyond the core engine are fabr *plugins*: ordinary npm packages, installed
alongside fabr, that register their build rules and `.fabr` library files into the host when a
project declares them. `@fabr/js` — the JavaScript/NPM ecosystem support — is itself a plugin and
the canonical example.

## Declaring

```
plugin @fabr/js;
include JS.fabr;
```

- `plugin <packagename>;` may appear in any build file. Each plugin is activated exactly once per
  build, in declaration order.
- Plugins are resolved by **module resolution only**: the package must be installed alongside the
  fabr host (for `@fabr/*` packages, they ship with the fabr installation). There is currently no
  option to build a plugin from source as part of the build that uses it. A plugin that cannot be
  resolved is an error.
- Activation happens at **parse time, before include resolution** — so the include directories a
  plugin registers are searchable by the rest of the very file that declared it (as above: the
  `include JS.fabr;` is satisfied by the `@fabr/js` plugin's own library directory).

## The plugin contract

A plugin package's main entry point must export:

```ts
import type * as fabr from "@fabr/core";

export function activate(api: typeof fabr): void {
  api.registerSystemIncludeDir(api.packageLibDir("@my/plugin"));
  api.registerRule("my_thing", { BUILD_OPERATION: "build" }, buildMyThing);
  api.registerRepositoryType("my_repository", createMyRepository);
}
```

- `activate(api)` is called once, and performs all of the plugin's registrations. The `api` object
  is the **host's own `@fabr/core` module instance** (the full module namespace).
- `registerSystemIncludeDir(dir)` puts a directory on the system include path: bare include names
  (`include FOO.fabr;` — no `/` in the name) resolve against these directories in declaration
  order, before falling back to the including file's own directory. By convention a plugin ships
  its `.fabr` files in `lib/`, next to its entry point, and registers
  `packageLibDir("<its-own-name>")` — which locates the directory beside the package's resolved
  entry point, i.e. within the *built* package content, never a source tree. The `lib/` directory
  must therefore be packaged alongside the compiled code.
- `registerRule(type, constraints, evaluate)` registers the implementation of a target type. The
  *schema* for a declared type (its `targetdef`) lives in the plugin's `.fabr` library files, not
  in code. Rule selection picks the registered rule whose constraints most specifically match the
  active configuration (`{}` is a wildcard); the `BUILD_OPERATION` constraint carries the build
  verb (`fabr test x` ≡ `x[BUILD_OPERATION=test]`), and an operation-specific rule must explicitly
  request `BUILD_OPERATION: "build"` for its dependencies, since constraints otherwise propagate.

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
    `@fabr/js`'s `js:test-run`).
  - **To compose builds**, use `context.subTarget(type, inputs, {label, constraints})`. It builds
    an anonymous target of `type` and returns its cached output as a `Computable<FileSet>`, which
    you wire into a later action's inputs or reshape into final content. Actions never nest;
    composition is always via sub-targets.

  The evaluation/caching model these hang off is described in `CLAUDE.md` and
  `DESIGN-rules-and-caching.md`; this document covers only the registration surface.
- `registerRepositoryType(type, provider)` registers a repository type — repositories resolve
  requirements and are not rule-built targets: the provider is constructed lazily per build
  configuration against a narrow `RepositoryContext` (declared config properties,
  `memoize(tag, key, fn)` for resolution memos, `fetch(url, tag, process)` for downloads, and
  `notifyProgress` for resolve/fetch progress events).

## Module identity

The host and its plugins must share a single copy of `@fabr/core`: core's rule registry, class
identities (`instanceof`), and include-path registry are process-global. An installed plugin
shares the host's `node_modules`, so importing `@fabr/core` directly from plugin code is safe and
normal (node resolves it to the host's instance). What a plugin must never do is bundle or vendor
its own copy of core.

Code that a plugin arranges to run in *client* processes — such as `@fabr/js`'s test runner, which
executes inside test working directories — is a different matter: it cannot reach the host's core
at runtime at all, and must be dependency-free (type-only imports of `@fabr/core` are fine, since
they erase at compile time).

## Anatomy of a plugin package

```
my-plugin/
  package.json          main -> the module exporting activate()
  index.js              activate(api): register rules + include dir
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

- No build-plugin-from-source: the package must be installed. (A future variant may allow a plugin
  to be built by fabr itself and loaded from the build cache — such a plugin would have to keep
  its `@fabr/core` imports type-only and work purely through the `activate` api, since the cache
  directory has no `node_modules`.)
- The api injects only `@fabr/core`. A plugin cannot build on another plugin's exports (e.g.
  `@fabr/js`'s compile-pipeline helpers) without loading a second copy of that plugin, so
  cross-plugin extension isn't supported yet.
- The api surface is currently the whole of `@fabr/core` and is not yet versioned or stable.
