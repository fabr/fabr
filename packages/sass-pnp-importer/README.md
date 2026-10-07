# @fabr-build/sass-pnp-importer

A [Sass](https://sass-lang.com) importer for projects installed with
[Yarn Plug'n'Play](https://yarnpkg.com/features/pnp). It lets a stylesheet load another package's
stylesheets by package name, in a project that has no `node_modules` directory for Sass to search.

```scss
@use "@acme/design-system/colors";
```

```js
// build.js
const sass = require("sass");
const { sassPnpImporter } = require("@fabr-build/sass-pnp-importer");

const result = sass.compile("src/app.scss", { importers: [sassPnpImporter()] });
console.log(result.css);
```

```sh
yarn node build.js
```

It works with `sass` and with `sass-embedded`, and with `compile`, `compileString` and their async
forms. With `sass-embedded`, use the async forms; see [Using sass-embedded](#using-sass-embedded).

This package is part of the [fabr](https://fabr.build) build tool, which uses it to compile Sass,
but it has no dependency on fabr and can be used on its own in any Yarn PnP project. See
[About this package](#about-this-package).

## Install

```sh
yarn add --dev @fabr-build/sass-pnp-importer sass
```

It needs Node.js 22.19 or later. It is tested with `sass` and `sass-embedded` 1.100, under Yarn 4.

## What it resolves

A load of a package name, with or without Sass's `pkg:` prefix, is resolved by this importer:

```scss
@use "@acme/design-system/colors";
@use "pkg:@acme/design-system/colors";   // the same load
```

- **The package is looked up from the file doing the loading.** Which package a name refers to is
  whatever Yarn's dependency table says for that file. A stylesheet inside a dependency therefore
  sees the packages that dependency declares, not yours, and a package the loading file's own
  package doesn't declare can't be loaded. This holds for Yarn's virtual packages too: where a
  package is installed more than once, for different peer dependencies, a load resolves through
  the copy that is doing the loading.
- **Inside the package, Sass's own rules for packages apply:**
  1. the package's `exports` map, under the `sass` and `style` conditions;
  2. for the package's root, the `sass` and `style` fields of its `package.json`;
  3. Sass's usual search for the path: partials (`_colors.scss`), `index` files, and the `.scss`,
     `.sass` and `.css` extensions, with `.import` files preferred under `@import`.

  An `exports` map is tried first but doesn't hide other files. Many packages write `exports`
  for their JavaScript only, and their stylesheets remain loadable by path.
- **Packages inside zip archives work.** The importer reads files through Node.js's `fs`, which
  Yarn's runtime patches to read them.

Everything else is left to Sass: relative loads between your own files, and anything found through
`loadPaths`. A name that isn't one of the loading file's dependencies is also passed on, so the
importer can sit beside others in the `importers` list.

Webpack's `~` prefix (`@use "~bootstrap/scss/functions"`) is refused with an error telling you to
remove it. It isn't part of Sass.

## Running under Yarn's runtime

The importer gets Yarn's dependency table, the `.pnp.cjs` file at the root of the project, by
asking Node.js for the table that governs each file. That works when Yarn's runtime is loaded in
the process, which your build script needs in any case in order to `require("sass")`. Any of these
loads it:

```sh
yarn node build.js              # also: any script run with `yarn run`
node -r ./.pnp.cjs build.js     # loading the runtime yourself
```

```js
// or as the first line of build.js, so that plain `node build.js` works
require("./.pnp.cjs").setup();
```

Packages that Yarn keeps inside zip archives load in all three cases, because the runtime patches
Node.js's `fs`, which is what the importer reads files with.

### Using sass-embedded

With `sass-embedded`, use the asynchronous API:

```js
const sass = require("sass-embedded");
const { sassPnpImporter } = require("@fabr-build/sass-pnp-importer");

sass.compileAsync("src/app.scss", { importers: [sassPnpImporter()] }).then(result => {
  console.log(result.css);
});
```

Its synchronous `compile` didn't return under `yarn node` when this was written (Yarn 4.5,
Node.js 24), with or without this importer. If you need the synchronous API, unplugging the
`sync-child-process` package (`dependenciesMeta` in `package.json`) made it work.

## Options

`sassPnpImporter(options)` returns an importer for Sass's `importers` list. Both options are
optional.

| Option | Default | Meaning |
|---|---|---|
| `pnpApi` | The table Yarn's runtime finds for each loading file (`module.findPnpApi`) | The dependency table to resolve through. Pass one to use a particular table, or another implementation of the [PnP runtime API](https://yarnpkg.com/advanced/pnpapi), in place of the one Yarn's runtime would find. |
| `entryPointDirectory` | The working directory | Where a package load is resolved from when the stylesheet has no file location, which happens for source passed to `compileString` without a `url`. |

```js
sassPnpImporter({
  pnpApi: require("pnpapi"),          // Yarn's API for the running process
  entryPointDirectory: __dirname,
});
```

## Troubleshooting

| What you see | Cause | What to do |
|---|---|---|
| `Cannot find module 'sass'` | The script is run with plain `node`, without Yarn's runtime | Run it with `yarn node`, or one of the other ways in [Running under Yarn's runtime](#running-under-yarns-runtime). |
| The script never finishes | `sass-embedded`'s synchronous `compile` under `yarn node` | Use `compileAsync`; see [Using sass-embedded](#using-sass-embedded). |
| `Can't find stylesheet to import` for a package load | The package isn't a dependency of the package whose stylesheet loads it | Add it to that package's dependencies. For a third-party package that forgot to declare it, use Yarn's [`packageExtensions`](https://yarnpkg.com/configuration/yarnrc#packageExtensions). |
| `uses the webpack '~' prefix, which Sass does not define` | `@use "~pkg/…"` or `@import "~pkg/…"` | Remove the `~`. |
| `It's not clear which file to import` | Two files match one load, such as `_colors.scss` and `colors.scss` | This is Sass's own rule; the package needs to keep one. |

## About this package

`@fabr-build/sass-pnp-importer` is developed as part of [fabr](https://fabr.build), a build tool
for JavaScript and TypeScript projects, in the [fabr repository](https://github.com/fabr/fabr).
Fabr resolves packages the way Yarn PnP does, and uses this importer for the Sass in the projects
it builds. The importer talks only to the public PnP runtime API, so it works the same under Yarn.
It is released together with fabr, under the same version numbers.

Bug reports and contributions go to the
[fabr issue tracker](https://github.com/fabr/fabr/issues).

## License

[GNU General Public License v3.0 or later](https://www.gnu.org/licenses/gpl-3.0.html)
(GPL-3.0-or-later).
