---
title: Bundling
description: How to bundle JavaScript and TypeScript for a browser or for Node.js with fabr's js_bundle target — entries, what is included, output files, assets, and what isn't supported.
---

A `js_bundle` target combines an entry file and everything it imports into one JavaScript file,
or [split into chunks](#splitting-into-chunks) that the entry loads, using
[esbuild](https://esbuild.github.io/). Use it for code that runs somewhere there are no
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
[Not supported](#not-supported) before converting an application. Where you need them, run the
bundler itself, with its plugins, configuration and dev server; see
[Vite, Next.js and other frameworks](/guides/tools/#vite-nextjs-and-other-frameworks).

## Coming from esbuild, webpack or Vite

| With a bundler | In fabr |
|---|---|
| Entry points | `entry`. Several entries give several bundles, independent unless [split](#splitting-into-chunks). |
| Resolving imports from `node_modules` | A package must be listed in the bundle's `srcs` to be included. |
| `external` | Packages listed in `deps` are left as imports. |
| `--platform`, `--target` | The [`JS_TARGET`](#format-and-platform) setting. |
| `--format`, `--splitting` | The [`JS_BUNDLE_FORMAT`](#format-and-platform) setting. |
| `--entry-names`, `--chunk-names`, `--asset-names` | `output`, a rename of each kind's default name. Entries, chunks and assets are all named with a content hash by default; see [Renaming the output](#renaming-the-output). |
| `--metafile` | Always written, as `metafile.json`; see [Output](#output). |
| `--minify`, `--sourcemap` | The `BUILD_TYPE` setting: `debug`, `relwithdebinfo` or `release`. |
| `define` | `defines`. |
| TypeScript through a loader, without type checking | Sources are compiled by the TypeScript compiler first, so type errors fail the build. |
| CSS, Sass and css-modules loaders | Built in; see [Stylesheets](/reference/js/stylesheets/#in-a-bundle). |
| Images and fonts | Copied to the output with a content hash in the name. |
| A dev server with hot module reload | A [`serve`](#serving-a-bundle-during-development) target, which replaces the files on each rebuild. There is no hot module reload. |
| An HTML plugin, plugins | Not supported. |

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
its dependencies as well, unless something in `srcs` also needs them. When a package is in both
lists, the one that names it more directly wins:

| The package is | Result |
|---|---|
| Listed in both `srcs` and `deps` | Bundled |
| Listed in `deps`, and a dependency of a package in `srcs` | Left as an import |
| A dependency of packages in both lists | Bundled |

Within a package, the file bundled is the one its `exports` map names for the bundle's platform,
with a package's build for bundlers (its `module` condition) among the conditions that match; see
[Export conditions by tool](/reference/js/module-resolution/#export-conditions-by-tool).

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

Each entry is bundled on its own. Code that two entries both import is included in both, unless
the bundle is [split into chunks](#splitting-into-chunks).

### TypeScript and JSX

TypeScript and JSX sources in `srcs` are compiled as they are for a `js_package`, with the same
[settings and flags](/reference/js/typescript/), and the result is what esbuild bundles. Flags such
as `dom` and `ts/no_strict` go in the bundle's `srcs` or `deps`. For JSX, list the package that
provides the JSX runtime (`react`, `preact`) directly in `srcs` or `deps`.

Plain JavaScript sources aren't type-checked, and go to esbuild as they are.

## Output

Each entry produces a `.js` file named after it and a hash of its contents: `src:main.tsx` gives
`main-JYX2JBNH.js`. The hash changes whenever the file does, so a browser or CDN can cache it for
good; to name it without one, [rename it](#renaming-the-output). With it come:

| File | When |
|---|---|
| `main-JYX2JBNH.js.map` | In `debug` and `relwithdebinfo` builds. It maps back to your TypeScript, and includes the sources' text. |
| `main-5LDD4WYL.css`, `main-5LDD4WYL.css.map` | When the entry imports stylesheets. All the CSS it reaches is in this one file, named by its own hash. |
| `logo-OKA4D3M3.png` | For each imported asset; see [Assets](#assets). |
| `chunks/route-XS2Q5WTK.js` | In a [split bundle](#splitting-into-chunks), for code shared between entries and for each dynamic `import()`. |
| `metafile.json` | Always. esbuild's [metafile](https://esbuild.github.io/api/#metafile), described below. |

The source maps name each of your sources by its path from the project root, such as
`fabr:./src/main.tsx`, and each file from a package by the package and the file within it, such
as `fabr:@npm:react:19.1.0:cjs/react.development.js`. Without the `fabr:` prefix, each is a name
you can pass to `fabr cat` from the project root. The
[TypeScript page](/reference/js/typescript/#source-maps) explains the form.

`metafile.json` is esbuild's description of the build: each output, the inputs that went into
it, and the outputs it imports. It names inputs the way the source maps do, without the `fabr:`
prefix (`./src/main.tsx`, `@npm:react:19.1.0:cjs/react.development.js`), and outputs by their
names in the bundle (`main-JYX2JBNH.js`, `chunks/route-XS2Q5WTK.js`). In a `release` build, which makes no
source maps, your own sources are named by their compiled files instead (`main.js`). A
deployment step that needs the
chunk graph, to preload a page's chunks or to write a manifest of hashed names, reads it from
here.

`metafile.json` is part of the bundle's output, so a reference to the whole output, such as
`web:** -> static/assets/**` in a served directory or a jar, ships it too. To leave it out, select
the files you mean to ship:

| Reference | Selects |
|---|---|
| `web:**/!(metafile.json)` | Every file but `metafile.json`, chunks and assets included. |
| `web:**/!(metafile.json)* -> static/assets/**/*` | The same files, moved under `static/assets/`. |
| `web:main-*` | Only the files named after the entry `main`: its JavaScript, its CSS and their source maps. |

`BUILD_TYPE` decides minification and source maps:

| `BUILD_TYPE` | Minified | Source maps |
|---|---|---|
| `debug` (the default) | no | yes |
| `relwithdebinfo` | yes | yes |
| `release` | yes | no |

```sh
fabr build -DBUILD_TYPE=release web
```

### Renaming the output

To rename the output, set `output` to a [rename](/reference/syntax/#projection-and-renaming) from
the default name, `main-[hash].js`, in which `[hash]` stands for the hash esbuild writes. A rename
keeps the hash by replaying it, or drops it. The stylesheet and source map follow the new name:

```
js_bundle web {
  entry = src:main.tsx;
  output = main-*.js -> app.$1.min.js;    # app.JYX2JBNH.min.js, app.5LDD4WYL.min.css, …
}
```

```
js_bundle web {
  entry = src:main.tsx;
  output = main-*.js -> app.min.js;       # app.min.js, app.min.css, app.min.js.map
}
```

The name must end in `.js`. A bundle's entries are named by one pattern, so with several entries
the rename must keep the hash in every name, with the same text after it, or drop it from all:
`*-'[hash]'.js -> $1.'[hash]'.min.js` for each entry's `<name>.<hash>.min.js`, or
`*-'[hash]'.js -> $1.js` for its plain name. The rename is made to the name before esbuild fills in
the hash, so it matches `[hash]` as written, quoted so that it is not read as a character class; a
bare `*-*.js` would split a name such as `service-worker-[hash].js` at its first `-`. A `*` matches
within one directory, so for entries in subdirectories write `**/*-'[hash]'.js -> **/*.js`, which
also drops the hash from the [chunks](#splitting-into-chunks)' names. Renames that would need two
patterns are an error.

### Format and platform

The platform and the language level come from `JS_TARGET`, written
`<ES version>-<module format>-<environment>`; the form the bundle is written in comes from
`JS_BUNDLE_FORMAT`:

| `JS_BUNDLE_FORMAT` | The bundle is |
|---|---|
| `esm` | One ES module per entry: in a browser, load it with `<script type="module">`. |
| `esm-split` | ES modules, with the code they share in chunks they import; see [below](#splitting-into-chunks). |
| `iife` | A script, wrapped in a function so that it adds no globals. |
| `cjs` | A CommonJS module. |

Unless you set it, `JS_BUNDLE_FORMAT` follows `JS_TARGET`: `esm` for an `esm` or `dual` module
format, otherwise `iife` for the browser and `cjs` for Node.js. So `es2020-esm-browser` gives an
ES module for browsers and `es2020-commonjs-browser` a script. The module format defaults to
`commonjs` and the environment to `node` when left out, so a browser bundle has to say
`-browser`.

`JS_TARGET` is usually set once for the project. To build one bundle differently, declare what
the bundle should have where it is used, with a [constraint](/reference/syntax/#constraints):
`web<JS_TARGET=es2015-commonjs-browser>`, or `web<JS_BUNDLE_FORMAT=esm-split>`.

For Node.js, built-in modules such as `fs` and `node:path` are left as imports, and in a `cjs`
bundle `import.meta.url`, `import.meta.dirname` and `import.meta.filename` are given their
CommonJS values, since the sources are compiled as ES modules before they are bundled. For a
browser, built-in modules aren't available; see
[Node.js APIs in a browser bundle](#nodejs-apis-in-a-browser-bundle).

### Splitting into chunks

With `JS_BUNDLE_FORMAT=esm-split`, esbuild's [code splitting](https://esbuild.github.io/api/#splitting)
is on. Each dynamic `import()` of your own code becomes a file of its own, loaded when the import
runs, and code that several entries or imported files share goes into a chunk they all import, so
it is loaded once and a page that loads two entries has one copy of each module. Chunks are
written as `chunks/<name>-<hash>.js`, the hash taken from their content; the entries keep their
names.

To name the chunks differently, rename their pattern, `chunks/[name]-[hash].js`, with `output`.
Each wildcard captures one of esbuild's placeholders, which esbuild then fills in for each chunk:

```
output = chunks/*-*.js -> js/$2.$1.js;   # js/<hash>.<name>.js
```

The rename applies to every chunk alike, since it is made before the build; a rename for one
chunk, such as `chunks/route-*.js -> …`, matches nothing. The entries import their chunks by
these names, so only `output` can change them: renaming files after the build breaks the
imports.

```
js_bundle app {
  entry = src:main.tsx;
  srcs = src:** @npm:react:19.1.0 @npm:react-dom:19.1.0;
}

site_files = app<JS_BUNDLE_FORMAT=esm-split>:** -> assets/**;
```

Serve every file of the bundle, not only the entry: the entry imports its chunks by relative
URL, so they must sit beside it as the bundle lays them out. `metafile.json` lists which chunks
each entry and each dynamic import needs.

How esbuild divides the code follows from the imports alone: a split bundle has as many chunks
as there are distinct sets of entries and dynamic imports that reach some module, and none for an
entry that shares nothing.

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
no other environment variable reaches the code unless you define it. (A bundler you run yourself,
such as Vite, can read a `.env` file you list among its inputs; see
[The command's directory and environment](/guides/tools/#the-commands-directory-and-environment).)

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

To put assets elsewhere in the output, rename their pattern, `[name]-[hash].[ext]`, with `output`,
as for [chunks](#splitting-into-chunks): `output = *-*.* -> assets/$1-$2.$3;` writes
`assets/logo-OKA4D3M3.png`. The rename must keep the `.[ext]`.

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

Every package in the bundle that imports `path` or `node:path` then gets it: in a browser bundle,
the `node:` prefix is dropped before the import is resolved.

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
  `js_script worker { entry = worker_bundle:main.js; }`, the bundle renamed to drop the hash
  (`output = *-'[hash]'.js -> $1.js;`). It runs on the Node.js release that the
  [`NODE` setting](/reference/js/dependencies/#the-nodejs-version) names.
- **Put it in a larger set of files**, such as a site, by selecting and renaming:
  `web:**/!(metafile.json)* -> assets/**/*`, which leaves out
  [`metafile.json`](#output).

### Serving a bundle during development

A [`serve`](/reference/standard-rules/#serve) target puts a bundle and a hand-written HTML page
behind a static server. The page names the bundle's files, so the bundle drops the hash from its
entry's name:

```
js_bundle web {
  entry  = src:main.tsx;
  srcs   = src:** @npm:react:19.1.0 @npm:react-dom:19.1.0;
  output = *-'[hash]'.js -> $1.js;   # main.js and main.css
}

serve site {
  tool  = @npm:http-server:14.1.1;
  files = public:** web:**/!(metafile.json)* -> assets/**/*;
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

## Not supported

These are limits of `js_bundle`. A bundler run as itself, such as Vite, has its own features, hot
module reload among them; see [Vite, Next.js and other frameworks](/guides/tools/#vite-nextjs-and-other-frameworks).

- **HTML.** There is no HTML entry point and nothing generates or rewrites an HTML page. Write the
  page by hand, as above.
- **Hot module reload** and live reload.
- **esbuild plugins and options.** Only what this page describes can be set. That rules out
  `alias` and tsconfig `paths`, `banner` and `footer`, a global name for a script bundle, `drop`,
  inline source maps, and marking a path or a pattern as external.
- **Older browsers.** The JavaScript language level is the ES version in `JS_TARGET`, and no
  polyfills are added. (`BROWSER_TARGET` sets the browsers that
  [stylesheets are prefixed for](/reference/js/stylesheets/#browser-support), and nothing else.)
- **Inlining assets** as data URLs, and a public path or CDN prefix for asset URLs.
- **WebAssembly and workers.** A `.wasm` import is an asset URL, and `new Worker(new URL(…))` isn't
  recognised. Bundle a worker as an entry of its own and load it by its output name.
- **PostCSS plugins** other than autoprefixer, such as Tailwind CSS; see
  [Stylesheets](/reference/js/stylesheets/#not-supported).
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
