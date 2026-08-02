Notable changes in each release of fabr. The CLI (`@fabr-build/cli`), the engine
(`@fabr-build/core`) and the JavaScript plugin (`@fabr-build/js`) are released together and share a
version number.

## Fabr 0.1.1
@fabr/core:
- `include` paths may now glob (`include lib/**/*.fabr;`).
- Fix: generate command names resolved incorrectly.
- Cap maximum concurrent connections + executing processes.

@fabr/js:
- Generated package.json now strips build-only fields (devDependencies, scripts, …) from an imported manifest, and emits array metadata (keywords, os, cpu) as JSON arrays.
- Add support for package alises in external dependencies.
- Handle package resolution edge cases with missing specified versions.
- Make esModuleInterop: true by default; ts/no_esmodule_interop to disable.
- Revise MVS resolution to drop the 'independent major versions' concept we accidentally imported from Go.

@fabr/cli:

## Fabr 0.1.0

- First release - fully self hosting, with general support for JavaScript and TypeScript.

