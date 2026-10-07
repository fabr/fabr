---
title: Publishing packages
description: What a js_package's generated package.json contains, how to control it, and how to publish packages to an npm registry with a sync target.
---

A `js_package` is built with a `package.json` that fabr generates from the target, and a `sync`
target publishes one or more of them to an npm registry. This page covers both: what ends up in
the package, and how it gets published.

```
VERSION = 1.4.0;

js_package @acme/widgets {
  srcs = src:**/*.ts README.md LICENSE;
  exports = src:index.ts;
  deps = @npm:lodash:^4.17.0;
  metadata = { description = Widgets for Acme; license = MIT; }
}

sync release {
  @npm:@acme/widgets:${VERSION} = @acme/widgets<BUILD_TYPE=release>;
}
```

```sh
fabr build release    # produce the package, without uploading
fabr sync release     # publish it
```

## Coming from npm publish

| With npm | In fabr |
|---|---|
| A hand-written `package.json` | Generated. The target's name, `deps`, `exports` and `metadata` supply its contents. |
| `"files"` and `.npmignore` | The package contains what the target builds: nothing more to list or exclude. |
| `"version"`, `npm version` | The version is written in the `sync` entry. Nothing bumps it or tags the repository for you. |
| `prepublishOnly`, `prepack` scripts | Not run. Building is what `fabr` does. |
| `npm publish --dry-run`, `npm pack` | `fabr build` on the `sync` target, then `fabr ls`, `cat` or `cp`. |
| `npm publish --tag next` | Not supported: every publish is tagged `latest`. |
| `npm publish --provenance` | Not supported. |
| `NPM_TOKEN` in `.npmrc` | The same; see [Credentials](#credentials). |
| Workspace packages published together | Several entries in one `sync`; dependencies between them get the right versions. |

## What a package contains

- The compiled JavaScript and its type declarations (`.js`, `.d.ts`).
- Source maps, in `debug` and `relwithdebinfo` builds. They include your TypeScript source.
  A `release` build has none.
- Stylesheets, compiled to CSS; see [Stylesheets](/reference/js/stylesheets/).
- Any other file in `srcs`, as it is: `README.md`, `LICENSE`, JSON data.
- The files in `resources`, as they are.
- The generated `package.json`.

It doesn't contain your TypeScript sources, your tests, or anything listed in `test_deps`,
`test_resources` or `test_expectations`.

Nothing is added automatically, so list the README and licence in `srcs`. A file from outside the
package's directory keeps only its own name: `srcs = src:**/*.ts ../../LICENSE;` puts `LICENSE`
at the root of the package.

## The generated package.json

For the target at the top of this page, built as ES modules:

```json
{
  "name": "@acme/widgets",
  "version": "1.4.0",
  "description": "Widgets for Acme",
  "license": "MIT",
  "type": "module",
  "main": "index.js",
  "types": "index.d.ts",
  "exports": {
    ".": { "types": "./index.d.ts", "default": "./index.js" },
    "./package.json": "./package.json"
  },
  "dependencies": {
    "lodash": "^4.17.0"
  }
}
```

| Field | Comes from |
|---|---|
| `name` | The target's name. |
| `version` | The `sync` entry when published. In an ordinary build, the target's `version` property, if it has one. |
| `type` | `JS_TARGET`: `"module"` for `esm`, `"commonjs"` for `commonjs` and `dual`. |
| `main`, `types` | `index.js` and `index.d.ts`, when the package has them at its root. |
| `exports` | The `exports` property; see [below](#entry-points). |
| `bin` | Scripts in the package's `bin/` directory; see [below](#command-line-programs). |
| `dependencies` | `deps`, with the version or range as you wrote it. |
| `peerDependencies` | `provided_deps`, likewise. |
| anything else | `metadata`. |

There are no `devDependencies`: test dependencies aren't recorded, and build tools aren't
dependencies.

### Entry points

Without an `exports` property, the package has no `exports` field, and every file in it can be
imported by path.

Set `exports` to the source files that are the package's public entry points. Each becomes an
entry named after the source, without its extension, and files not listed can no longer be
imported from outside:

```
exports = src:index.ts src:server.ts src:lib/api.ts;
```

```json
"exports": {
  ".":         { "types": "./index.d.ts",   "default": "./index.js" },
  "./lib/api": { "types": "./lib/api.d.ts", "default": "./lib/api.js" },
  "./server":  { "types": "./server.d.ts",  "default": "./server.js" },
  "./package.json": "./package.json"
}
```

A stylesheet or data file can be listed too, and is exported under its built name:
`src:theme.scss` as `"./theme.css"`.

### Both module formats

With a `dual` module format (`JS_TARGET = es2022-dual;`), the package holds both: CommonJS as
`.js` with `.d.ts`, and ES modules as `.mjs` with `.d.mts`. Each entry gets both conditions:

```json
".": {
  "import":  { "types": "./index.d.mts", "default": "./index.mjs" },
  "require": { "types": "./index.d.ts",  "default": "./index.js" }
}
```

With no `exports` property, a dual package still gets an `exports` field, mapping every file so
that `import` and `require` each reach the right format.

### Command-line programs

A script directly inside the package's `bin/` directory becomes a command named after the file:
`src/bin/acme.ts`, with `srcs = src:**/*.ts`, gives `"bin": { "acme": "bin/acme.js" }`. Fabr adds
the `#!/usr/bin/env node` line if the file doesn't start with one. `fabr run @acme/widgets` runs
it.

### Other fields

`metadata` supplies any other field. A value is a string, a block for an object, or several blocks
for an array; `keywords`, `os`, `cpu` and `libc` become arrays of their words:

```
metadata = {
  description = Widgets for Acme;
  license = MIT;
  keywords = widgets acme;
  repository = { type = git; url = https://github.com/acme/widgets.git; };
  engines = { node = ">=20"; };
}
```

Fields shared between packages can be kept in one map and included in each; see
[Map properties](/reference/syntax/#map-properties).

Two groups of fields can't be set, and are errors in `metadata`:

- Fields fabr generates: `name`, `version`, `type`, `main`, `types`, `exports`, `bin`,
  `dependencies`, `peerDependencies`.
- Fields that only mean something in a source checkout: `devDependencies`, `scripts`, `files`,
  `private`, `publishConfig`, `workspaces`, `overrides`, `resolutions` and
  `bundledDependencies`.

If you are converting a package, you can instead list its existing `package.json` in `srcs`.
Fields from it are carried into the generated one, except for those two groups, which are
replaced or dropped; `metadata` overrides the rest. Its `dependencies` are not read: declare
them in `deps`.

## Publishing with sync

A `sync` target lists what to publish. Each entry is the registry, package name and exact version
to publish as, and the target that supplies the package:

```
sync release {
  @npm:@acme/core:${VERSION}    = @acme/core<BUILD_TYPE=release>;
  @npm:@acme/widgets:${VERSION} = @acme/widgets<BUILD_TYPE=release>;
}
```

**Write `<BUILD_TYPE=release>` on each target.** It is a
[constraint](/reference/syntax/#constraints): it makes the entry a release build whatever the
build type of the run. Without it, `sync` publishes whatever build type it is run with, and the
default is `debug`, whose source maps contain your TypeScript sources.

The name in the entry is the name published. Keep it the same as the target's name, so that other
packages' dependencies on the target match it.

### Check, then publish

`fabr build` on the target produces exactly what would be uploaded, a tarball and its
`package.json` for each entry, and uploads nothing:

```sh
fabr build release
fabr ls release
#   @npm/@acme/core/1.4.0/@acme/core-1.4.0.tgz
#   @npm/@acme/core/1.4.0/package.json
#   …
fabr cat release/@npm/@acme/widgets/1.4.0/package.json
fabr cp release ./to-publish
```

`fabr sync` uploads them:

```sh
fabr sync release
```

- **Packages are uploaded in dependency order**, one at a time, with a line for each:
  `Published …`, or `… is already synced`.
- **A version that is already on the registry is skipped**, not an error, so a `sync` that failed
  part-way can be run again.
- **If a package fails to upload**, the packages that depend on it are skipped, the others are
  still published, and `fabr sync` exits with a failure.
- **Every publish is tagged `latest`**, prereleases included.

### Dependencies between the packages

When one entry depends on another, the published `package.json` requires the version being
published: `"@acme/core": "^1.4.0"` in `dependencies`, and the exact version in
`peerDependencies`. That is why the packages don't need `version` properties of their own.

A package that depends on another package of the project has to be published together with it.
If `@acme/widgets` depends on `@acme/core` and only `@acme/widgets` is in the `sync`, there is no
version to record:

```
cannot publish @acme/widgets: no version to record for '@acme/core' — a dependency built here must be published by this sync (at a single version) for its dependants to be resolvable
```

Add the dependency to the `sync`, or give it a `version` property, which is then what dependants
require.

### Versions

The version is whatever the entry says. Keeping it in a property, as `${VERSION}` above, lets one
line change the version of every package and lets it be set from the command line:

```sh
fabr sync -DVERSION=1.5.0-beta.1 release
```

Fabr doesn't choose versions, write a changelog, check that the working tree is clean, or create
a tag. Do those around the `fabr sync` step.

### Credentials

Credentials are read from `.npmrc`, in the project's root directory and then your home directory,
in npm's format:

```
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
```

`${NPM_TOKEN}` is taken from the environment. Use a token that can publish without a second
factor, such as an npm granular access token, when publishing from CI.

On a terminal, a registry that asks for a second factor is handled interactively: fabr opens the
browser for a passkey, or asks for a one-time password. Without a terminal that isn't possible,
and the publish fails saying so.

### Other registries, and private packages

`@npm` publishes to the public npm registry, with public access. To publish somewhere else, or
privately, declare a registry and name it in the entries:

```
npm_repository @internal {
  url = https://npm.example.com/;
  access = private;
}

sync release {
  @internal:@acme/widgets:${VERSION} = @acme/widgets<BUILD_TYPE=release>;
}
```

`access` is `public` or `private`. One `sync` can publish to several registries.

## What isn't supported

- **Dist-tags.** Every publish becomes `latest`. Publishing a prerelease or a patch to an old
  release line moves `latest` to it.
- **Provenance attestations** and npm's trusted publishing.
- **A one-time password from a flag or environment variable.** Use a token that doesn't need one.
- **Lifecycle scripts** (`prepublishOnly`, `prepack`, `prepare`).
- **Version bumping, changelogs and git tags.**
- **Publishing a `js_bundle`.** A bundle isn't a package.

## Troubleshooting

| What you see | Cause | What to do |
|---|---|---|
| `publish coordinate '…' must pin an exact version` | A range or a missing version in a `sync` entry | Write an exact version: `@npm:name:1.4.0`. |
| `no version to record for 'x'` | A dependency on a package of the project that this `sync` doesn't publish | Add it to the `sync`, or give it a `version`. |
| `'1.0' is not a valid package version` | A `version` that isn't `major.minor.patch` | Write `1.0.0`. |
| `metadata key 'x' is set by fabr and cannot be overridden` | A generated field in `metadata` | Remove it; set the corresponding property instead. |
| `metadata key 'x' is not carried into a published package` | A checkout-only field in `metadata` | Remove it. |
| `'x' is named in exports, but produces nothing importable in the built package` | An `exports` entry such as a `.d.ts` file | List a source that compiles to JavaScript. |
| `publishing … failed (401)` or `(403)` | No credential for the registry, or one that can't publish this package | Check the `.npmrc` entry and that the environment variable it names is set. |
| `requires a second factor (2FA), and this run has no terminal` | A token that needs a one-time password, used in CI | Use a token that publishes unattended. |
| The published package has `.js.map` files containing sources | The `sync` entry doesn't require a release build | Write `<BUILD_TYPE=release>` on the entry's target. |
