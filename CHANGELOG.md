Notable changes in each release of fabr. The CLI (`@fabr-build/cli`), the engine
(`@fabr-build/core`), the JavaScript plugin (`@fabr-build/js`), its tools (`@fabr-build/js-tools`)
and the Sass importer (`@fabr-build/sass-pnp-importer`) are released together and share a version
number.

## Fabr 0.4.0
@fabr-build/core:
- Introduce fabr_plugin target + move rule/repository decls out to spec.
- Make the actual working dir a subdir, with the tree pool link (if present) outside - fixes excessive tree scanning.
- Add TEST_NAME_PATTERN / -t support for running specific tests.
- Add zip target.
- Add bash-style string edit patterns.
- Re-check version lists and other mutable downloads at most once a day; add --refresh to re-check them now.
- Add @host search-path as the 'authorised' hermetic escape route.
- Add targetdef inheritance: derived targets inherit their base's rules but can extend and override.
- Add support for map splices in target properties.
- Breaking: Cache failed test runs like passing ones; add --retry-failed to run failed tests again.
- Test targets now complete normally whether or not tests fail; top-level 'fabr test'
still reports non-zero exit code with failures.
- Add `fabr test --report FILE [--format ctrf|junit]`: every tested target's results in one CTRF or JUnit XML file
- Write a failing test run's coverage report too.
- Add vulnerability audit via osv.
- Add --trace[=FILE] to build, test and run: a trace of the run's work for Perfetto or chrome://tracing.
- Allow 'fabr build' of run-only targets, and cat/ls of run and test only targets.
- list-targets shows each target's operations, takes globs over target names, and lists only one operation's targets with --operation.
- Add `private` declarations: a target or global property only its own build file sees.
- Test output is now reported the same way as other build steps.
- `patched` now takes an optional `run` command to modify files in place (after any `patches`).
- Fix joint resolution of catalog + non-catalog deps.
- `fabr test` of a name listing several test targets summarises all of their tests, not only the first target's.
- Fix: A test whose sources import a JSON file listed among its deps no longer fails on the compiled copy conflicting with it.
- Negative extglobs can now match multiple paths eg !(foo/bar)/**
- Add support for separate build + runtime resolution.

@fabr-build/aws:
- Add s3 download support.

@fabr-build/container:
- New container image support.
- Add container_program, to run an image with its environment, ports, network and host names.

@fabr-build/migration:
- New: `fabr-migrate` converts an npm, Yarn or pnpm project to fabr.

@fabr-build/java:
- New Java support.

@fabr-build/js:
- js_package now takes a compile_deps property for compile-only inputs.
- Load only the browser table from caniuse-lite, not every feature's data.
- js_script takes env, the environment variables its program is launched with.
- A package's dependency on a dist-tag (`latest`) is read as `*`, so the build's own requirement on the package selects it.
- Add sources operation.
- Allow any version of a package with eg @npm:debug? (instead of specific versions)
- Move bundling format out to a new property JS_BUNDLE_FORMAT (with target defaults)
- Add bundle splitting + metafile support.
- Support renaming bundled chunks + assets.
- dom dependency includes dom.iterator as well (for TS5.x, no effect on TS6.x)
- Handle node: imports in browser bundling (strip off the node:)
- Fix packages in both srcs + deps being left unbundled.
- Fix bundling cjs files with __dirname/etc.
- Fix bundles ignoring a package's `module` export condition (its build for bundlers), which esbuild otherwise honours.
- Fix resources not being mounted during package tests.
- js_package tests compile against the package's own build, checking and emitting only the tests.
- Run again only the test files a change can reach, coverage included.
- Add layout/pnp flag to run tests through a PnP table instead of node_modules.
- js_test takes compile_deps; dom there type-checks against the DOM and runs the tests under node.
- Fix setImmediate/MessageChannel being visible to jsdom tests (as under jest).
- Test processes end once their report is written, rather than waiting on what the tests left running.
- Incremental test compilation and execution.
- Support pnp for test execution.

@fabr-build/vscode-ext:
- New VSCode extension.
- Highlight single-quoted strings, and quoted strings across the lines they span.

## Fabr 0.3.1
@fabr-build/core:
- Resolve dependencies separately from fetching and building them, so a version conflict fails
  before anything is downloaded and `fabr deps` needs no package contents.
- Find dependency cycles in the computation graph itself, fixing some cycles that went unreported.
- Circular dependency errors list the written references making up the cycle, closing one first.
- Built packages now participate normally in dependency resolution, including `?` and `!` marks.
- Add the `PACKAGES` property type, for properties that take packages rather than plain files.
- A repository named on its own (`deps = @npm;`) is now an error rather than silently naming nothing.
- Generalize `fabr_home` to the whole installed tree (`@fabr-home:<package>`), with
  `@fabr-build/*` falling back to the installed packages.
- Allow `-` in property names.
- Optimize package downloading, and stop re-reading metadata for cached packages.
- Fix handling of constraints in variable substitutions and string lookups.
- Keep `fabr run` installs between runs, updating only what changed; `run -w` swaps between two.
- Add `incremental` and `changes` to the `generate` target.
- Rename the plugin API's `packageLibFile` to `getPackageLibFile`.

@fabr-build/cli:
- Add `fabr deps`: print the dependency tree of targets or packages, marking conflicting versions `(!)`.
- Add `fabr test --coverage[=DIR]`, writing an lcov report.
- `fabr ls` lists a namespace where its repository can enumerate one (`fabr ls @npm:glob`).
- `fabr build` and `fabr test` check every name before building anything, and refuse a path or a
  file selection.

@fabr-build/js:
- A sibling package depended on under a rename (`deps = mylib -> foo;`) is declared in npm's alias
  form (`"foo": "npm:mylib@1.2.3"`).
- Move the drivers and test runners into their own package, `@fabr-build/js-tools`, installed with
  fabr.
- Add `optional_provided_deps` (written as optional `peerDependencies`).
- Source maps name each source as a `fabr:` reference, by its path in the project where it has one.
- Sass and postcss steps recompile only when a stylesheet they read changes.
- postcss resolves `composes` from packages through the PnP table.
- Add test coverage reporting (`COVERAGE=on`).
- Add node distribution repository to download node.js.

## Fabr 0.3.0
@fabr-build/core:
- Add support for guarded properties.
- Add xz archive support.
- Add positional backrefs in rename templates.
- Add backtick command expressions.
- Add `2>&1` stream duplication to command pipelines (and its `1>&2` mirror).
- General optimizations, especially for cache-hits.
- Fix package aliases not working in catalogs.
- Add discovered dependencies + incremental state support.
- Add source index to reduce startup hashing.
- Add first cut of cache garbage collection (30-day)
- Fix strict resolution checking to apply at the collection point.
- Fix build file reloading orphaning running processes.
- Add env property to generate + serve targets.
- Fix rule selection ignoring `default` and declared globals (only explicit overrides counted).
- Add `targetProperties` to rule registrations, selecting a rule on the target's own properties.
- Fix a dependency cycle through something a rule reads (a tool global naming a target that
needs the reader) hanging the build instead of being reported.
- "required by" chains now name the target whose rule read a global (a tool setting), in start
lines and in error notes; they used to stop at the global.
- Fix local packages added to a catalog.
- Fix aliased package resolution.
- Add the `patched` target: a published package (or plain files) with a patch applied, retaining its shape.

@fabr-build/cli:
- Live progress display on terminal with progress bars and test status (suppressed with -q)

@fabr-build/js:
- BREAKING: TSC property has changed to TYPESCRIPT without the bin;
TSC=@npm:typescript:5.4.5:tsc becomes TYPESCRIPT=@npm:typescript:5.4.5.
- BREAKING: the test runner is chosen by a test_framework / framework property instead of test_runner. 
- Add Yarn PnP resolution support, enabled currently for our owned tools.
- Rewrite module-specifiers for ESM targets where required.
- `js_bundle` now requests ESM format inputs regardless of target.
- Add exports option for js_package.
- Add support for dual-format js package output.
- Add incremental TSC support.
- Add js/node_globals flag for bundling w/ node process/Buffer globals.
- Add postcss for more correct css-module processing.
- Rewrite __dirname/__filename globals for ESM targets and vice-versa for import.meta in CJS targets.
- Rewrite self-package imports into relative imports.
- Split `css_compile` into separate `sass_compile` (lowering) + `css_postcss` steps.
- Add sass-pnp-importer
- Add yarn's package extensions.
- Fix provided package resolution to avoid forking.
- Node_modules (when used) now follows pnpm tree conventions
- Add vitest as a supported test framework (`JS_TEST_FRAMEWORK = vitest`)
- Add support for Jest environment docblock declarations.
- Add snapshot assertions (`t.assert.snapshot`) to the native test runner, updated with `fabr test -u`.

## Fabr 0.2.1
@fabr-build/core:
- `include` paths may now glob (`include lib/**/*.fabr;`).
- Cap maximum concurrent connections + executing processes.
- New 'fetch' download source for arbitrary http/https fetching.
- Enable automatic extraction and traversal of archive files.
- Add support for bash extended globs (eg !(expr) ).
- Add support for default targets and default target properties.
- Add support for package renaming using -> rename syntax.
- Add `repository_group` target for adding multiple scoped repositories and package overrides.
- Detect a plugin that loads its own nested copy of `@fabr-build/core` (a broken install) and report it clearly.
- Allow rename from wildcard to fixed name (if matched once only)
- Fix: generate command names resolved incorrectly.
- Fix: remove excessive synchronous mkdirs
- Fix: sync targets being unavailable to other build steps.

@fabr-build/js:
- Add a jest compatibility test runner (`JS_TEST_RUNNER = @fabr-build/js-tools/jest-runner;`)
- Generated package.json now strips build-only fields (devDependencies, scripts, …) from an imported manifest, and emits array metadata (keywords, os, cpu) as JSON arrays.
- Add support for package aliases in external dependencies.
- Add resources (copied as-is) inputs to js_package.
- Add ability to use package members as bundle entry points (like scripts)
- Add ts/experimental_decorators + ts/emit_decorator_metadata flags and cover the rest of the strict flags.
- Emitting below es2015 now also automatically enables downlevelIteration
- Handle package resolution edge cases with missing specified versions.
- Make esModuleInterop: true by default; ts/no_es_module_interop to disable.
- Revise MVS resolution to drop the 'independent major versions' concept we accidentally imported from Go.
- Generate resolution repair lists on resolution failures.
- Readd es* flags as source version dependency flags.
- Drop lightningcss; esbuild now handles css modules directly.
- Fix TS source importing local references using full package path.
- Fix esbuild resolver erroring on survivable misses.
- Fix sass errors to report positions in the original sources via source maps.
- Fix assorted dependency resolution issues.
- Fix creating hardlinks in NPM publish tarballs (rejected by NPM)

## Fabr 0.1.0

- First release - fully self hosting, with general support for JavaScript and TypeScript.

