Notable changes in each release of fabr. The CLI (`@fabr-build/cli`), the engine
(`@fabr-build/core`) and the JavaScript plugin (`@fabr-build/js`) are released together and share a
version number.

## Fabr 0.1.1
@fabr/core:

@fabr/js:
- Generated package.json now strips build-only fields (devDependencies, scripts, …) from an imported manifest, and emits array metadata (keywords, os, cpu) as JSON arrays.

@fabr/cli:

## Fabr 0.1.0

- First release - fully self hosting, with general support for JavaScript and TypeScript.

