# @fabr-build/sass-pnp-importer

A [Sass](https://sass-lang.com) importer that loads package stylesheets through a
[Plug'n'Play](https://yarnpkg.com/advanced/pnp-spec) dependency table — Yarn PnP, or any
tool implementing the PnP runtime API. Works with `sass` and `sass-embedded`.

```js
const sass = require("sass-embedded");
const { sassPnpImporter } = require("@fabr-build/sass-pnp-importer");

sass.compile("src/app.scss", { importers: [sassPnpImporter()] });
```

```scss
@use "@acme/design-system/colors"; // or "pkg:@acme/design-system/colors"
```

## What it does

- **Resolves each load from the file that wrote it.** Which package a name means is the
  PnP table's answer for that file, so a package's own `@use "dep"` sees the dependencies
  *it* declares — including under Yarn's virtual packages, where one package is installed
  wired several ways.
- **Follows dart-sass's package rules below the package root**: the package's `exports` under
  the `sass`/`style` conditions as a first choice (not a boundary — a map describing the
  package's JavaScript does not hide its stylesheets), then its `sass`/`style` fields for
  the root, then Sass's ordinary search — partials, `index` files, `.scss`/`.sass`/`.css`,
  import-only files under `@import`, and Sass's error when two candidates match.
- **Reads through node's `fs`**, so under Yarn (whose runtime patches `fs`) packages inside
  zip archives load too — which a Sass `FileImporter` cannot do, since the compiler reads
  those files itself.

Project sources and `loadPaths` stay with Sass's own loading; a name the table does not
bind is left to them. The webpack `~` prefix is refused rather than stripped.

## Finding the dependency table

By default the importer asks node, per file, which PnP table governs it —
`module.findPnpApi(file)`. That function is not part of node itself: Yarn's PnP runtime adds it
when `.pnp.cjs` is loaded into the process, which happens when you run under Yarn:

- `yarn node build.js`, or any `yarn run` script (Yarn preloads `.pnp.cjs` through
  `NODE_OPTIONS`);
- `node -r ./.pnp.cjs build.js`, preloading it yourself.

For each file, Yarn's runtime uses an already-loaded table that owns the file, or else walks up
from the file's directory to the nearest `.pnp.cjs` and loads it. The answer is per file, so a
stylesheet inside a dependency resolves against the table that installed it.

Run outside Yarn's runtime — plain `node build.js` in a PnP project — and there is no
`module.findPnpApi`: the importer finds no table, resolves nothing, and Sass reports package
loads as "Can't find stylesheet". Either run under Yarn as above, or pass the table explicitly:

```js
const pnpApi = require("./.pnp.cjs"); // requiring (not preloading) returns the API without patching fs
sass.compile("src/app.scss", { importers: [sassPnpImporter({ pnpApi })] });
```

Passing it explicitly works for packages Yarn has unpacked on disk, but not for packages still
inside zip archives: reading those needs the `fs` patch that only preloading installs.

## Options

`sassPnpImporter()` is a factory: it takes an optional options object and returns an importer
to put in Sass's `importers` list. Every option may be omitted.

```js
sassPnpImporter({
  pnpApi: require("./.pnp.cjs"),
  entryPointDirectory: __dirname,
});
```

- `pnpApi` — the PnP API to resolve through: Yarn's `pnpapi`, or any implementation of the PnP
  runtime API. By default, the one `module.findPnpApi` finds for each loading file — see
  *Finding the dependency table*.
- `entryPointDirectory` — where a package load is resolved from when the stylesheet writing it
  has no file location: source text compiled from memory (`sass.compileString`) without a `url`
  option saying where it came from. Defaults to the working directory.
