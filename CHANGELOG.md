Notable changes in each release of fabr. The CLI (`@fabr-build/cli`), the engine
(`@fabr-build/core`) and the JavaScript plugin (`@fabr-build/js`) are released together and share a
version number.

## Fabr 0.3.0
@fabr-build/core:
- Add support for guarded properties.
- Add xz archive support.
- Add positional backrefs in rename templates.
- Add backtick command expressions.
- Add `2>&1` stream duplication to command pipelines (and its `1>&2` mirror).
- General optimizations, especially for cache-hits.
- Fix package aliases not working in catalogs.

@fabr-build/cli:
- Live progress display on terminal with progress bars and test status (suppressed with -q)

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

