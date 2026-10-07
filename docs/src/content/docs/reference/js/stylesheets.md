---
title: Stylesheets
description: How fabr builds CSS, Sass and css-modules as part of a JavaScript package or bundle — what each file produces, how imports are rewritten, and what isn't supported.
---

Stylesheets are ordinary sources. List them in a target's `srcs` beside the TypeScript that
imports them, and fabr compiles Sass to CSS, scopes css-modules, types their class names, and
rewrites the imports to match. There is no loader or plugin to configure and no separate target to
declare.

```
js_package ui {
  srcs = src:**/*.ts src:**/*.tsx src:**/*.scss src:**/*.css;
}
```

```ts
import styles from "./Card.module.scss";  // a css-module: the class names, scoped
import "./theme.scss";                    // an ordinary stylesheet, imported for its effect

element.className = styles.cardTitle;     // "card-title_FCiirPWT"
```

## Coming from a bundler

| With webpack, Vite or similar | In fabr |
|---|---|
| `sass-loader`, `css-loader`, a Vite CSS plugin | Built in. Listing the file in `srcs` is enough. |
| `*.module.css` and `*.module.scss` are css-modules | The same convention. |
| `typed-css-modules`, a `declare module "*.module.scss"` shim | Not needed: each css-module is typed from its own class names. |
| `import styles from "./x.module.scss"` works because the bundler handles it | The published JavaScript imports a generated `x.css.js`, so the package works without a bundler plugin. |
| Sass `@use "~pkg/file"` (webpack's `~` prefix) | Write `@use "pkg/file"`. The `~` prefix is refused. |
| `postcss.config.js`, autoprefixer, Tailwind | Not supported; see [What isn't supported](#what-isnt-supported). |
| Less, Stylus | Not compiled. |

## What each file produces

A stylesheet is recognised by its extension:

| Source | Output | Notes |
|---|---|---|
| `theme.css` | `theme.css` | Copied unchanged. |
| `theme.scss`, `theme.sass` | `theme.css` | Compiled by Sass. |
| `Card.module.css`, `Card.module.scss`, `Card.module.sass` | `Card.css`, `Card.css.js`, `Card.css.d.ts` | A css-module: the CSS with its class names scoped, and a JavaScript module exporting them. The `.module` part of the name isn't kept. |
| `_variables.scss` | nothing | A Sass partial, available to `@use` from the target's other stylesheets. |
| `.less`, `.styl` | the same file | Shipped as it is, not compiled. |

Source maps (`theme.css.map`) are written beside the CSS in `debug` and `relwithdebinfo` builds,
and point back to the Sass source.

Because a css-module's output drops `.module`, `Card.module.scss` and a `Card.scss` or `Card.css`
in the same directory would both produce `Card.css`. Fabr reports that as a conflict; rename one
of them.

## Importing stylesheets from TypeScript

Write the import as the file is named in your source tree. Fabr rewrites it in the compiled
output to name the file that ships:

| You write | The compiled JavaScript has |
|---|---|
| `import styles from "./Card.module.scss"` | `import styles from "./Card.css.js"` |
| `import "./theme.scss"` | `import "./theme.css"` |
| `import "./reset.css"` | `import "./reset.css"` |

`Card.css.js` exports the class names and itself imports `./Card.css`, so loading the module
brings its styles with it. What reads a `.css` import at run time is up to whoever consumes the
package: a bundler handles it, and so does fabr's own `js_bundle`. Node.js doesn't, so a package
containing stylesheets is meant for bundling.

An import of a stylesheet that doesn't exist is a compile error, including a side-effect import
such as `import "./typo.css"`.

## css-modules

A stylesheet with `.module.` before its extension is a css-module. Its class names are local to
the file: each is rewritten to a unique name, and the module's default export maps the names you
wrote to the names in the CSS.

```scss
/* Card.module.scss */
.card-title { font-weight: 600; }
.body { padding: 1rem; }
```

```ts
import styles from "./Card.module.scss";

styles.cardTitle;       // "card-title_FCiirPWT"
styles["card-title"];   // the same
styles.body;            // "body_FCiirPWT"
styles.missing;         // compile error: Property 'missing' does not exist
```

- **Class names are typed.** The import's type lists exactly the classes the stylesheet defines,
  so a misspelt or deleted class is a compile error where it is used, not `undefined` at run
  time.
- **Both spellings are available.** A class written `card-title` can be read as
  `styles["card-title"]` or `styles.cardTitle`.
- **There is a default export only.** `import { cardTitle } from "./Card.module.scss"` isn't
  available; use `styles.cardTitle`.
- **Scoped names are stable.** A scoped name is the class name followed by a hash of the package
  name and the file's path. It doesn't change when the stylesheet's contents change, and it is
  the same in every build. Moving or renaming the file, or renaming the package, changes it.

### `composes`

A class can include the rules of another with `composes`:

```css
.title { composes: heading from "./typography.module.css"; color: navy; }
```

The other stylesheet can be:

- the same file (`composes: heading;`);
- another stylesheet of the same target, written by its source name, so
  `from "./typography.module.scss"` works;
- a `.css` file from a package in the target's `deps`, written `from "design-system/base.css"`.

The composed rules are copied into the stylesheet that uses them. Composing from a Sass partial,
or from a package the target doesn't depend on, fails with
`composes: '…' does not name a stylesheet this target can reach`.

## Sass

`.scss` and `.sass` files are compiled with [Dart Sass](https://sass-lang.com/dart-sass/)
(`sass-embedded`), at the version named by the `SASS` setting.

Within a target, `@use` and `@import` find other stylesheets by relative path as usual, including
partials and `_index` files.

To load a stylesheet from a package, name the package:

```scss
@use "design-system/tokens";
@use "bootstrap/scss/functions";
```

The package must be in the target's `deps`; as with JavaScript imports, a stylesheet can use only
what its target declares (see [Module resolution](/reference/js/module-resolution/)). Inside the
package, fabr looks first at its `exports` map under the `sass` and `style` conditions, then at
the `sass` and `style` fields of its `package.json`, and then for the file itself, with Sass's
usual handling of partials, `_index` files and extensions. Sass's own `pkg:design-system/tokens`
form is accepted too.

There are no load paths, and webpack's `~` prefix isn't accepted:
`'~bootstrap/scss/functions' uses the webpack '~' prefix, which Sass does not define — write the package name directly`.

### Shipping Sass for other packages to use

A package's `.scss` sources are compiled, and only the CSS is shipped. To publish Sass that other
packages can `@use`, such as variables and mixins, list those files in the target's `resources`
instead of `srcs`: resources are shipped as they are.

## In a bundle

A [`js_bundle`](/reference/js/targets/#js_bundle) handles stylesheets the same way, and then
bundles the CSS that its entry points import: the stylesheets reachable from each entry are
combined into a CSS file emitted beside that entry's JavaScript. In `release` and
`relwithdebinfo` builds the CSS is minified.

- A `url()` that refers to a file among the bundle's `srcs`, such as a font or an image, is
  emitted with a content hash in its name, and the URL is rewritten. A `url()` that refers to
  nothing in the bundle is left as written, for the browser to resolve.
- CSS from a package listed in the bundle's `srcs` is bundled. A package listed in its `deps` is
  left out, with its imports kept, like the package's JavaScript.

## In tests

Tested code can import stylesheets under every test framework. A css-module that is one of the
target's own sources is built as it is for the package, so a test sees its real scoped class
names. Any other stylesheet import yields a stand-in whose every property is its own name. See
[Testing](/reference/js/testing/#stylesheets-and-other-assets).

## What isn't supported

- **PostCSS plugins.** There is no `postcss.config.js`, and no way to add a plugin, so
  autoprefixer, Tailwind CSS and `postcss-preset-env` can't be run as part of a fabr build.
  Vendor prefixes aren't added and `browserslist` isn't read.
- **Less and Stylus** aren't compiled.
- **Named exports from css-modules.** Only the default export exists.
- **css-modules options** such as a custom scoped-name pattern or a different naming convention.
- **Controls for Sass deprecation warnings,** such as `quietDeps` and `silenceDeprecations`.

## Troubleshooting

| What you see | Cause | What to do |
|---|---|---|
| `Cannot find file './x.scss'` when compiling | The stylesheet isn't matched by the target's `srcs`, or the path is wrong | Add it to `srcs` (`src:**/*.scss`), or correct the path. |
| `Property 'x' does not exist on type …` on a `styles.x` | The stylesheet has no class `x` | Correct the name; the type lists the classes that exist. |
| `'x.module.scss' is a css-module, and scoping consumes its '.module' marker — so it lowers to 'x.css', which the plain stylesheet beside it already produces` | A css-module and a plain stylesheet with the same base name | Rename one. |
| `uses the webpack '~' prefix` | `@use "~pkg/…"` or `@import "~pkg/…"` | Remove the `~`. |
| Sass can't find a stylesheet in a package | The package isn't in the target's `deps` | Add it. |
| `composes: '…' does not name a stylesheet this target can reach` | The file is a Sass partial, isn't in the target, or its package isn't in `deps` | Compose from a stylesheet of the target or of a declared package. |
| Class names in a snapshot or assertion don't match the literal name | css-modules are scoped | Compare against `styles.name` rather than a literal string. |
