Notable changes in each release of fabr. The CLI (`@fabr-build/cli`), the engine
(`@fabr-build/core`) and the JavaScript plugin (`@fabr-build/js`) are released together and share a
version number.

## Fabr 0.2.0
@fabr/core:
- `include` paths may now glob (`include lib/**/*.fabr;`).
- Cap maximum concurrent connections + executing processes.
- New 'fetch' repository source for arbitrary http/https fetching.
- Enable automatic extraction and traversal of archive files.
- Fix: generate command names resolved incorrectly.
- Fix: remove excessive synchronous mkdirs
- Add support for bash extended globs (eg !(expr) )
- Add support for bash extended globs (eg !(expr) ).
- Add support for default targets and default target properties.
- Add support for package renaming using -> rename syntax.

@fabr/js:
- Generated package.json now strips build-only fields (devDependencies, scripts, …) from an imported manifest, and emits array metadata (keywords, os, cpu) as JSON arrays.
- Add support for package aliases in external dependencies.
- Add resources (copied as-is) inputs to js_package.
- Add ability to use package members as bundle entry points (like scripts)
- Handle package resolution edge cases with missing specified versions.
- Make esModuleInterop: true by default; ts/no_esmodule_interop to disable.
- Revise MVS resolution to drop the 'independent major versions' concept we accidentally imported from Go.
- Generate resolution repair lists on resolution failures.
- Readd es* flags as source version dependency flags.
- Drop lightningcss; esbuild now handles css modules directly.
- Fix TS source importing local references using full package path.
- Remove lightningcss and rely on esbuild's native css support.

@fabr/cli:

## Fabr 0.1.0

- First release - fully self hosting, with general support for JavaScript and TypeScript.

