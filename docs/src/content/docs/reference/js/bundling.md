---
title: Bundling
description: How to bundle JavaScript and TypeScript for a browser or for Node.js with fabr's js_bundle target — entries, what is included, output files, assets, and what isn't supported.
---

A `js_bundle` target combines an entry file and everything it imports into one JavaScript file,
using [esbuild](https://esbuild.github.io/). Use it for code that runs somewhere there are no
packages to import from: a browser, a serverless function, a script you want to ship as a single
file.

```
js_bundle web {
  entry = src:main.tsx;
  srcs = src:** @npm:react:19.1.0 @npm:react-dom:19.1.0
         @npm:@types/react:19.1.0 @npm:@types/react-dom:19.1.0 dom;
}
```

```sh
fabr build web
fabr ls web        # main.js, main.js.map, main.css, …
```

A bundle is deliberately simple compared with webpack or Vite: there are no plugins and no
configuration file, and several things those tools do aren't available. Check
[What isn't supported](#what-isnt-supported) before converting an application.

## Coming from esbuild, webpack or Vite

| With a bundler | In fabr |
|---|---|
| Entry points | `entry`. Several entries give several independent bundles. |
| Resolving imports from `node_modules` | A package must be listed in the bundle's `srcs` to be included. |
| `external` | Packages listed in `deps` are left as imports. |
| `--platform`, `--format`, `--target` | The [`JS_TARGET`](#format-and-platform) setting. |
| `--minify`, `--sourcemap` | The `BUILD_TYPE` setting: `debug`, `relwithdebinfo` or `release`. |
| `define` | `defines`. |
| TypeScript through a loader, without type checking | Sources are compiled by the TypeScript compiler first, so type errors fail the build. |
| CSS, Sass and css-modules loaders | Built in; see [Stylesheets](/reference/js/stylesheets/#in-a-bundle). |
| Images and fonts | Copied to the output with a content hash in the name. |
| A dev server with hot module reload | A [`serve`](#serving-a-bundle-during-development) target, which replaces the files on each rebuild. There is no hot module reload. |
| An HTML plugin, code splitting, plugins | Not supported. |

## What goes into a bundle

Three properties decide it:

| Property | What it is |
|---|---|
| `entry` | The file to bundle. Its imports are followed from there. |
| `srcs` | What may be included: your source files, and the packages to build in. |
| `deps` | Packages that will be present where the bundle runs. Imports of them stay as imports, and their code is left out. |

An import of a package that is in neither `srcs` nor `deps` is an error:

```
Could not resolve "lodash"
fabr: 'lodash' is neither bundled (add it, or its package, to 'srcs') nor a declared dependency (add it to 'deps')
```

Listing a package in `srcs` includes its own dependencies too. Listing one in `deps` leaves out
its dependencies as well, unless something in `srcs` also needs them.

**Every source file in `srcs` is compiled**, whether or not the entry reaches it. Give each bundle
a pattern that matches only its own sources; a file meant for another bundle, importing packages
this one doesn't list, fails to compile here.

### Entries

An entry can be a source file, or a file in a package:

```
entry = src:main.ts;                 # a source file; it needn't also be in srcs
entry = src:main.ts src:admin.ts;    # two bundles
entry = src:pages/*.entry.ts;        # one bundle for each matching file
entry = @acme/app:index.js;          # the compiled index.js of a js_package
```

Each entry is bundled on its own. Code that two entries both import is included in both; there is
no shared chunk.

### TypeScript and JSX

TypeScript and JSX sources in `srcs` are compiled as they are for a `js_package`, with the same
[settings and flags](/reference/js/typescript/), and the result is what esbuild bundles. Flags such
as `dom` and `ts/no_strict` go in the bundle's `srcs` or `deps`. For JSX, list the package that
provides the JSX runtime (`react`, `preact`) directly in `srcs` or `deps`.

Plain JavaScript sources aren't type-checked, and go to esbuild as they are.

## Output

Each entry produces a `.js` file named after it: `src:main.tsx` gives `main.js`. With it come:

| File | When |
|---|---|
| `main.js.map` | In `debug` and `relwithdebinfo` builds. It maps back to your TypeScript. |
| `main.css`, `main.css.map` | When the entry imports stylesheets. All the CSS it reaches is in this one file. |
| `logo-OKA4D3M3.png` | For each imported asset; see [Assets](#assets). |

`BUILD_TYPE` decides minification and source maps:

| `BUILD_TYPE` | Minified | Source maps |
|---|---|---|
| `debug` (the default) | no | yes |
| `relwithdebinfo` | yes | yes |
| `release` | yes | no |

```sh
fabr build -DBUILD_TYPE=release web
```

To rename the output, set `output` to a [rename](/reference/syntax/#projection-and-renaming) from
the default name. The stylesheet and source map follow the new name:

```
js_bundle web {
  entry = src:main.tsx;
  output = main.js -> app.min.js;     # also app.min.css, app.min.js.map
}
```

The name must end in `.js`.

### Format and platform

The module format, the platform and the language level come from `JS_TARGET`, written
`<ES version>-<module format>-<environment>`:

| `JS_TARGET` | The bundle is |
|---|---|
| `es2020-esm-browser` | An ES module for browsers: load it with `<script type="module">`. |
| `es2020-commonjs-browser` | A script for browsers, wrapped in a function so that it adds no globals (esbuild's `iife` format). |
| `es2022-esm-node` | An ES module for Node.js. |
| `es2022-commonjs-node` | A CommonJS module for Node.js. |

The format defaults to `commonjs` and the environment to `node` when left out, so a browser bundle
has to say `-browser`. A `dual` format is read as `esm`, since a bundle is one file.

`JS_TARGET` is usually set once for the project. To build one bundle differently, declare the
target the bundle should have where it is used, with a
[constraint](/reference/syntax/#constraints): `web<JS_TARGET=es2015-commonjs-browser>`.

For Node.js, built-in modules such as `fs` and `node:path` are left as imports. For a browser they
aren't available; see [Node.js APIs in a browser bundle](#nodejs-apis-in-a-browser-bundle).

## Constants

`defines` replaces names in the code with constants at build time. Each value is JavaScript source
text, so a string needs quotes of its own inside the fabr quotes:

```
js_bundle web {
  entry = src:main.tsx;
  defines = {
    API_URL = '"https://api.example.com"';
    DEBUG = false;
    process.env.RELEASE = "\"${VERSION}\"";
  }
}
```

Single quotes take their contents as written. To build a value from a property, use double quotes
and escape the inner ones, as the last line does.

In TypeScript, declare the name so that the compiler knows it: `declare const API_URL: string;`.

`process.env.NODE_ENV` is replaced without being listed: with `"production"` in a minified build
and `"development"` otherwise. Set it in `defines` to choose yourself. No `.env` file is read, and
no other environment variable reaches the code unless you define it.

## Assets

An import of a file that isn't JavaScript, TypeScript, CSS, JSON or text is treated as an asset.
The file is copied to the output under a name that includes a hash of its contents, and the import
evaluates to that name:

```ts
import logo from "./logo.png";      // "./logo-OKA4D3M3.png"
```

A `url()` in a stylesheet works the same way. The asset has to be in `srcs`, like any other source
(`src:**` covers it). For TypeScript, declare the import's type in a file beside the asset named
`logo.d.png.ts`:

```ts
declare const url: string;
export default url;
```

Asset URLs are relative to the bundle, so serve the output files from one directory. `.json`
imports give the parsed value, and `.txt` imports the text.

## Node.js APIs in a browser bundle

Packages written for Node.js often use its built-in modules and globals, which a browser doesn't
have. Fabr adds no substitutes automatically; you list the ones you want.

**Built-in modules.** Add a package that implements the module, renamed to the module's name:

```
srcs = @npm:path-browserify:1.0.1 -> path
       @npm:stream-browserify:3.0.0 -> stream;
```

Every package in the bundle that imports `path` then gets it.

**Globals.** For `process`, `Buffer` and `global`, add the `js/node_globals` flag together with
the `process` and `buffer` packages:

```
srcs = @npm:process:0.11.10 @npm:buffer:6.0.3 js/node_globals;
```

## Using a bundle

A bundle is a set of files, not a package: it has no `package.json`, and it can't be published
with `sync` or run with `fabr run`. Other targets use its files by reference.

- **Copy it out**, to deploy it: `fabr cp -DBUILD_TYPE=release web ./dist` writes the files to
  `./dist/web/`.
- **Run a Node.js bundle** by making it a `js_script`'s entry:
  `js_script worker { entry = worker_bundle:main.js; }`.
- **Put it in a larger set of files**, such as a site, by selecting and renaming:
  `web:** -> assets/**`.

### Serving a bundle during development

A [`serve`](/reference/standard-rules/#serve) target puts a bundle and a hand-written HTML page
behind a static server:

```
serve site {
  tool  = @npm:http-server:14.1.1;
  files = public:** web:** -> assets/**;
  args  = -c-1 .;
}
```

```html
<!-- public/index.html -->
<div id="root"></div>
<link rel="stylesheet" href="assets/main.css">
<script type="module" src="assets/main.js"></script>
```

```sh
fabr run -w site
```

Editing a source rebuilds the bundle and replaces the served files, without restarting the server.
Reload the page to see the change: nothing tells the browser. See
[Watch mode & dev servers](/guides/watch/).

## What isn't supported

- **Code splitting.** Each entry is one file. A dynamic `import()` of your own code is included in
  that file, not loaded on demand, and entries share no chunks.
- **HTML.** There is no HTML entry point and nothing generates or rewrites an HTML page. Write the
  page by hand, as above.
- **Hashed names for the bundle itself.** Assets get a content hash; `main.js` and `main.css`
  don't, and no manifest of output names is written.
- **Hot module reload** and live reload.
- **esbuild plugins and options.** Only what this page describes can be set. That rules out
  `alias` and tsconfig `paths`, `banner` and `footer`, a global name for a script bundle, `drop`,
  inline source maps, and marking a path or a pattern as external.
- **Older browsers.** The language level is an ES version. There is no `browserslist`, and no
  polyfills are added.
- **Inlining assets** as data URLs, and a public path or CDN prefix for asset URLs.
- **WebAssembly and workers.** A `.wasm` import is an asset URL, and `new Worker(new URL(…))` isn't
  recognised. Bundle a worker as an entry of its own and load it by its output name.
- **PostCSS plugins,** including autoprefixer and Tailwind CSS; see
  [Stylesheets](/reference/js/stylesheets/#what-isnt-supported).
- **esbuild's warnings** aren't shown; only its errors.

## Troubleshooting

| What you see | Cause | What to do |
|---|---|---|
| `'x' is neither bundled … nor a declared dependency` | An import of a package the bundle doesn't list | Add the package to `srcs` to include it, or to `deps` to leave it as an import. |
| `Cannot find module 'x'` from the TypeScript compiler, for a file the entry doesn't use | `srcs` matches source files that belong to something else | Narrow the `srcs` pattern to this bundle's sources. |
| `Could not resolve "path"` (or `fs`, `crypto`, …) in a browser bundle | A package uses a Node.js built-in module | Add a substitute renamed to the module's name; see [above](#nodejs-apis-in-a-browser-bundle). |
| `Could not resolve "buffer"` or `"process"` with `js/node_globals` | The flag is set without the packages it needs | Add `@npm:buffer` and `@npm:process` to `srcs`. |
| `process is not defined` in the browser | Code reads `process.env.X` for something other than `NODE_ENV` | Define it in `defines`, or add `js/node_globals`. |
| `No JSX runtime specified in dependencies` | `.tsx` sources without `react` or `preact` listed directly | Add it to `srcs`. |
| `js_bundle 'entry' resolved to no files` | The `entry` pattern matches nothing | Correct the path. |
| `js_bundle output '…' must end in '.js'` | An `output` rename to another extension | Rename to a `.js` name. |
| `Circular dependency: 'web' depends on itself` | The bundle has the same name as the directory its sources are in | Write the directory as `./web`, or rename the target. |
| `'js_bundle' targets support 'build'` | `fabr run` on a bundle | Wrap it in a `js_script`; see [Using a bundle](#using-a-bundle). |
