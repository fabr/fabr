---
title: TypeScript compilation
description: How fabr compiles TypeScript and JavaScript, how to carry over the settings from your tsconfig.json, and every deliberate difference from running tsc yourself.
---

Fabr compiles the TypeScript and JavaScript sources of a `js_package` with the version of the
TypeScript compiler you pin (the `TYPESCRIPT` setting), using its own `tsc-driver` wrapper, which
provides Yarn PnP-style package resolution and more control over the emitted output. Fabr generates
the compiler configuration from your build file rather than reading a `tsconfig.json`, and you get
the same type errors, inferred types and output as `tsc` would produce with that configuration,
apart from the deliberate differences listed on this page.

If you're converting an existing project, start with [Coming from tsconfig.json](#coming-from-tsconfigjson).
If something compiles under `tsc` but not under fabr, or the other way round, the
[summary of differences](#summary-of-differences) and [Troubleshooting](#troubleshooting) are the
places to look.

## Coming from tsconfig.json

Each setting you'd normally put in `tsconfig.json` either has a fixed value in fabr or comes from
your build file:

| tsconfig.json option | In fabr |
|---|---|
| `target`, `module` | The `JS_TARGET` setting, written `<ES-version>-<module>-<environment>`, for example `JS_TARGET = es2022-esm;`. The module part is `commonjs`, `esm` or `dual` (both formats in one package); the default is `es6-esm`. |
| `lib` | Follows the ES version in `JS_TARGET`. To declare the level your sources are written against separately, add an ES-level flag (`es5`, `es2015` … `es2023`, `esnext`) to the target's `deps`; using a newer API is then a compile error, and sources declared below `es2022` keep assignment semantics for class fields whatever version is emitted. Add the `dom` flag for browser APIs. |
| `strict` and the options it enables | On. Relax them per target with `ts/…` flags in `deps` (see below). |
| `esModuleInterop` | On. Add `ts/no_es_module_interop` for code written with `import * as x` of a callable CommonJS module. |
| `experimentalDecorators`, `emitDecoratorMetadata` | Off. Add `ts/experimental_decorators` or `ts/emit_decorator_metadata` (which implies the first). |
| `noUncheckedSideEffectImports` | On wherever the compiler supports it (TypeScript 5.6 and later). Add `ts/allow_unchecked_side_effect_imports` to turn it off. |
| `jsx`, `jsxImportSource` | Set automatically when a target has `.tsx` or `.jsx` sources: the automatic runtime (`react-jsx`, or `react-jsxdev` in a `debug` build), imported from whichever of your direct dependencies publishes `./jsx-runtime`, such as `react` or `preact`. |
| `sourceMap` | On, with sources inlined, for `BUILD_TYPE=debug` (the default) and `relwithdebinfo`; off for `release`. |
| `moduleResolution` | Chosen for your compiler version. Imports resolve as described in [How imports resolve](#how-imports-resolve), whatever the output format. |
| `types`, `typeRoots` | Add the `@types` packages you need to the target's `deps`. |
| `declaration`, `allowJs`, `skipLibCheck`, `resolveJsonModule`, `allowArbitraryExtensions` | Always on. JavaScript sources are compiled but not type-checked (`checkJs` is off). |
| `rootDir`, `outDir`, `include` | Set by fabr from the target's `srcs`. |

Flags go in a target's `deps` alongside its packages:

```
js_package app {
  srcs = src:**/*.ts;
  deps = @npm:react:19.1.0 ts/no_strict_null_checks ts/experimental_decorators dom;
}
```

The strictness flags each turn off one option: `ts/no_strict` (all of `strict`),
`ts/allow_implicit_any`, `ts/allow_implicit_this`, `ts/no_strict_null_checks`,
`ts/no_strict_property_initialization`, `ts/no_strict_function_types`,
`ts/no_strict_bind_call_apply` and `ts/no_use_unknown_in_catch_variables`.

`TYPESCRIPT` names the compiler package, as a pinned version or a range
(`TYPESCRIPT = @npm:typescript:5.6.3;`).

## How fabr's output differs from tsc

The TypeScript project treats TypeScript as type annotations over JavaScript: removing the
annotations gives back the JavaScript you wrote, and making that JavaScript work where it runs (the
right import paths, the right module system) is left to you and your other tools. Fabr instead
treats your sources as something it **compiles** for the target named by `JS_TARGET`, so producing
output that runs correctly there is fabr's job.

That leads to three kinds of difference from `tsc`:

1. **Output fixes** make the compiled output correct for its target, or let an import work without
   extra configuration. For example, fabr adds the `.js` extension that Node.js requires on a
   relative import in ES-module output, where `tsc` leaves the import as you wrote it.
2. **Earlier errors** report, at compile time, code that is certain to fail when it runs. "Certain"
   means in *every* environment the output might be used in, bundlers included: a `require()` call
   in ES-module output fails under Node.js but works in a bundler, so fabr compiles it as `tsc`
   does. An `import type` statement is removed from the output and never runs, so none of these
   errors apply to it.
3. **Spec fixes** follow a specification `tsc` implements in the places where `tsc` departs from
   it, such as Node.js's rules for `exports` maps. Where fabr keeps `tsc`'s behaviour instead, this
   page says so.

Anything else that differs from `tsc` is a bug, and we'd like to hear about it.

## Summary of differences

| Difference | Kind | Details |
|---|---|---|
| Imports resolve by the same rules for ES-module and CommonJS output | Output fix | [How imports resolve](#how-imports-resolve) |
| `exports` maps are read as the specification requires | Spec fix | [`exports` maps](#exports-maps-are-read-as-the-specification-requires) |
| More packages' type declarations are found | Output fix | [Finding declarations](#more-packages-type-declarations-are-found) |
| Imports get the file extension their target needs | Output fix | [Import extensions](#imports-get-the-file-extension-their-target-needs) |
| Imports of your own package are written as relative paths | Output fix | [Own-package imports](#imports-of-your-own-package-are-written-as-relative-paths) |
| `__dirname` and `import.meta` convert between module systems | Output fix | [Module-system globals](#__dirname-and-importmeta-convert-between-module-systems) |
| Declaration files never contain build paths | Output fix | [Declaration files](#declaration-files-never-contain-build-paths) |
| Unresolvable side-effect imports are errors | Earlier error | [Side-effect imports](#unresolvable-side-effect-imports-are-errors) |
| Imports of files that don't exist are errors | Earlier error | [Missing files](#imports-of-files-that-dont-exist-are-errors) |
| `@types` packages can't type paths a package doesn't export | Earlier error | [Unexported paths](#types-packages-cant-type-paths-a-package-doesnt-export) |
| An export that names a missing file is an error | Earlier error | [Missing export targets](#an-export-that-names-a-missing-file-is-an-error) |

## How imports resolve

Imports resolve as described in [Module resolution](/reference/js/module-resolution/): packages come
only from your target's declared dependencies, never from a `node_modules` directory, and files
inside a package are found by Node.js's `require()` rules, whatever the output format.

**tsc:** with `moduleResolution: "bundler"`, resolves inside a package in the same way, using the
`import` condition. Before TypeScript 6, though, `bundler` is only allowed with ES-module output;
CommonJS output is limited to `node10`, which ignores `exports` maps entirely, so an import can
resolve to a file the package doesn't make available and then fail in `require()` at runtime.
**fabr:** resolves as `bundler` does for every output format and compiler version, with the
conditions for the output: `types`, `import` for ES-module output or `require` for CommonJS output,
and `module-sync`.

### `exports` maps are read as the specification requires

**tsc:** implements most of Node.js's
[`exports` specification](https://nodejs.org/api/esm.html#resolution-algorithm-specification), but
departs from it in three places. **fabr:** follows the specification in each:

- **Targets are URLs.** A target is resolved as a URL relative to the package, so `"./a%20b.js"`
  names the file `a b.js`, and a malformed escape (`"./100%.js"`) or an encoded `/` or `\`
  (`%2F`, `%5C`) isn't a valid target. `tsc` reads targets as literal file paths, so it looks for
  `a%20b.js` and doesn't find the package's declarations. (The general case is
  [microsoft/TypeScript#41730](https://github.com/microsoft/TypeScript/issues/41730).)
- **An excluded or invalid target ends the search.** When the first condition matching an import
  has a `null` target (meaning "deliberately not exported") or an invalid one (such as
  `"../outside.js"`), the import doesn't resolve, where `tsc` moves on to the next condition.
- **A wildcard must match something.** A pattern key such as `"./foo*"` doesn't match `pkg/foo`,
  because the `*` has to stand for at least one character, where `tsc` lets it match nothing.

Node.js refuses all three imports too, so code that compiles under `tsc` but not under fabr would
fail when Node.js loads it. Change the import to a path the package exports.

Fabr keeps `tsc`'s behaviour for **trailing-slash "folder" keys** such as
`"./features/": "./src/features/"`. They aren't part of the specification (Node.js removed them in
version 17), but `tsc` and esbuild both still honour them and older packages rely on them.

### More packages' type declarations are found

**tsc:** in its modern resolution modes, finds declarations only where it expects them: it looks for
`index.d.cts` beside `index.cjs`, and when a package has an `exports` map it uses a `types`
condition inside the map but not the package's top-level `"types"` field. A package that publishes
its declarations any other way is treated as untyped (error TS7016), even though it runs correctly.

**fabr:** when a package's code resolves but `tsc` finds no declarations for it, also looks for
declarations beside the implementation under the plain `.d.ts` name (`index.d.ts` next to
`index.cjs` or `index.mjs`), and, for the package's main entry, the `types` (or `main`) field when
its `exports` map has no `types` condition.

### Library replacements and global type packages

A dependency named `@typescript/lib-<name>` (for example `@typescript/lib-dom`) replaces the
compiler's built-in library of that name, as it would when installed in `node_modules`.

Global type packages (`@types/node` and the like) are looked up once for the whole compilation,
from your target's own dependencies first, so two versions of the same `@types` package can't both
declare the same globals.

## The compiled output

### Imports get the file extension their target needs

**tsc:** leaves import paths as written, so `import { x } from "./util"` stays `"./util"` in the
output, and Node.js's ES-module loader, which requires a full file name, fails to load it.

**fabr:** in ES-module output, rewrites each relative import to the file the compiler emitted for
it:

```ts
// Source
import { format } from "./format";
import { parse } from "./parser";   // parser/index.ts

// ES-module output
import { format } from "./format.js";
import { parse } from "./parser/index.js";
```

Imports you already wrote with the output extension (`"./format.js"`) are left unchanged, and so
is an import that names an existing file exactly, such as `"./theme.css"`, even where a module of a
similar name sits beside it (`theme.css.ts`). A target's `rewrite_imports` rules are applied at the
same step.

The same applies to a package path that an `exports` map publishes by pattern. With
`"./src/*": "./src/*"`, the map turns `three/src/math/MathUtils` into `./src/math/MathUtils`, which
doesn't exist, because the pattern copies what you wrote and nothing adds an extension. `tsc`
reports the import as not found, and Node.js and bundlers fail to load it. Fabr finds the file the
import means (`MathUtils.js`) and writes that path into the output, in ES-module and CommonJS output
alike:

```ts
// Source
import { floorPowerOfTwo } from "three/src/math/MathUtils";

// Output
import { floorPowerOfTwo } from "three/src/math/MathUtils.js";
```

Fabr completes the path only when the completed path resolves through the same `exports` map to
that same file; otherwise the import stays unresolved, as it does with `tsc`.

### Imports of your own package are written as relative paths

**tsc:** leaves an import of your own package by name, such as
`import { pad } from "@acme/widgets/util/pad"` inside `@acme/widgets`, as you wrote it. Node.js
resolves a package's import of its own name only through the package's `exports` map, so the
import fails when Node.js loads it if the package has no `exports` map, or if the map doesn't list
that path.

**fabr:** writes the import as the relative path to the same file. It's then handled like any other
relative import: it gets the extension ES-module output needs, and an import of a stylesheet names
the module fabr generates for it.

```ts
// Source: src/app/main.ts in @acme/widgets
import { pad } from "@acme/widgets/util/pad";
import styles from "@acme/widgets/app/Card.module.scss";

// ES-module output: app/main.js
import { pad } from "../util/pad.js";
import styles from "./Card.css.js";
```

CommonJS output is rewritten the same way, without the added extension. Bundlers resolve the relative
form exactly as they did the original, so you can keep writing whichever form you prefer.

### `__dirname` and `import.meta` convert between module systems

**tsc:** compiles `__dirname` in ES-module output, or `import.meta.url` in CommonJS output, without
complaint, although neither exists in that module system, so the code fails at runtime.

**fabr:** converts them to their equivalents in the output's module system, so the same source
works in either:

| In your source | ES-module output | CommonJS output |
|---|---|---|
| `__dirname` | `import.meta.dirname` | unchanged |
| `__filename` | `import.meta.filename` | unchanged |
| `import.meta.dirname` | unchanged | `__dirname` |
| `import.meta.filename` | unchanged | `__filename` |
| `import.meta.url` | unchanged | a `file:` URL built from `__filename` |
| `import.meta.main` | unchanged | `require.main === module` |

A variable of your own named `__dirname` isn't touched, and neither is the name directly after
`typeof`, so guards such as `typeof __dirname !== "undefined"` keep working. Anything without an
exact equivalent compiles as it does with `tsc`, including `require`, `module` and `exports` in
ES-module output and `import.meta.resolve` in CommonJS output.

### Declaration files never contain build paths

**tsc:** when a declaration file refers to a type from a dependency, works out an import path from
where that dependency sits on disk. Fabr's packages live in its own store rather than
`node_modules`, so that path would point into fabr's build directory, which means nothing to anyone
who installs your package.

**fabr:** writes the dependency's package name instead, and refuses to produce a declaration file
that still refers to a build path.

## Errors fabr reports that tsc does not

These errors apply only to imports that run. An `import type` statement never runs, so none of them
apply to it.

### Unresolvable side-effect imports are errors

A side-effect import such as `import "./polyfill"` that can't be resolved would fail as soon as the
module loads, so fabr reports it. `tsc` reports these only when `noUncheckedSideEffectImports` is
set (TypeScript 5.6 and later), and fabr sets it whenever the compiler supports it. Add the
`ts/allow_unchecked_side_effect_imports` flag to a target's `deps` to turn the check off.

For a file the compiler can't read as a module, such as a stylesheet or an image, `tsc` reports
every side-effect import, because it can never resolve one. Fabr checks whether the file is there
instead, with no declarations needed: the import is accepted if the file exists and is an error if
it doesn't. This includes such files in a dependency, as long as the package makes them available.

```ts
import "./global.css";               // accepted if global.css exists; an error if it doesn't
import "some-widget/dist/theme.css"; // likewise, if the package exports it
```

An import that uses a value from such a file (`import logo from "./logo.svg"`) still needs a
declaration, as it does with `tsc`, and your own `declare module "*.svg"` patterns apply as usual.

### Imports of files that don't exist are errors

A `declare module` pattern such as `declare module "*.svg"` tells `tsc` what any matching import
looks like, so `tsc` accepts the import whether or not the file exists, and before TypeScript 5.6 it
doesn't check side-effect imports at all. Either way, an import of a missing file compiles cleanly
and then fails in the bundler or at runtime.

Fabr reports `error TS79001: Cannot find file './missing.svg'.` when the file certainly isn't there:

- for a relative import with a file extension (`"./missing.svg"`, `"./theme.css"`), or an import of
  your own package by name, which is checked as the relative path it names. An import without an
  extension is left to `tsc`, because a bundler may complete the path itself;
- for an import of a path inside one of your dependencies that the package doesn't make available,
  or whose file is missing.

An import of a name that isn't a package in your build isn't checked, because patterns such as `declare module "virtual:*"` are how a
bundler plugin's virtual modules are typed. A target with `ts/allow_unchecked_side_effect_imports`
doesn't get this error for side-effect imports.

### `@types` packages can't type paths a package doesn't export

When a package has an `exports` map, only the paths it lists can be imported. `tsc`, having failed
to resolve such a path in the package, falls back to the matching `@types` package and compiles the
import if that package happens to include declarations for it. The import still fails when it runs,
because it loads the package, not its types, so fabr doesn't make that fallback:

```ts
// "some-lib" exports only "."; @types/some-lib happens to include internal.d.ts
import { helper } from "some-lib/internal"; // error: not exported by some-lib
```

Import from a path the package exports instead.

### An export that names a missing file is an error

When the first `exports` condition matching an import names a file that isn't in the package,
Node.js and bundlers fail to load it rather than falling back to a later condition. Fabr reports the
import as unresolved, where `tsc` takes type declarations from a later condition. This is a problem
in the package itself; if a newer version doesn't fix it, report it to the package's maintainers.

## Troubleshooting

| Error | Likely cause | Fix |
|---|---|---|
| `Cannot find module 'x' or its corresponding type declarations.` | `x` isn't in your target's `deps` | Add it to `deps`; see [Module resolution](/reference/js/module-resolution/#troubleshooting) |
| `Cannot find module 'pkg/sub' …` where the file exists, or where `@types/pkg` declares it | `pkg`'s `exports` map doesn't list `./sub` | Import a path the package exports ([Unexported paths](#types-packages-cant-type-paths-a-package-doesnt-export)) |
| `Cannot find module './polyfill' or its corresponding type declarations.` on a side-effect import (`import "./polyfill"`) | The file doesn't exist; fabr turns on `noUncheckedSideEffectImports` | Fix the path, or add `ts/allow_unchecked_side_effect_imports` to `deps` ([Side-effect imports](#unresolvable-side-effect-imports-are-errors)) |
| `error TS79001: Cannot find file './x.css'.` | The imported file doesn't exist, although a `declare module` pattern matches it | Fix the path, or add the missing file ([Missing files](#imports-of-files-that-dont-exist-are-errors)) |
| `Could not find a declaration file for module 'x'.` (TS7016) | The package publishes no declarations that `tsc` or fabr can find | Add the matching `@types` package to `deps`, or declare the module yourself |
| Type errors that `tsc` didn't report with your old `tsconfig.json` | Your old configuration relaxed `strict` or one of its options | Add the matching `ts/…` flags to `deps` ([Coming from tsconfig.json](#coming-from-tsconfigjson)) |
| `No JSX runtime specified in dependencies, and is needed to compile TSX files` | A target with `.tsx` or `.jsx` sources has no dependency that publishes `./jsx-runtime` | Add `react`, `preact` or your JSX library to `deps` |
| `Multiple JSX runtimes in dependencies (…)` | More than one direct dependency publishes `./jsx-runtime` | Keep one JSX library in the target's direct `deps` |
