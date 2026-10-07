---
title: Module resolution
description: How fabr decides what an import refers to, how that differs from npm and node_modules, and how to fix the errors you're most likely to meet.
---

Every tool in a fabr build, whether compiling, bundling, testing or running, has to answer the same
question for each `import` and `require()`: which file does this refer to? This page explains how
fabr answers it, what will feel familiar if you've worked with npm, and what won't.

## At a glance

- **Inside a package, nothing changes.** `exports` and `imports` maps, export conditions, `main`
  and `types` fields, extensionless imports and `index` files all work the way Node.js and your
  bundler already handle them.
- **Which package a name refers to is stricter.** There is no `node_modules` directory to search.
  Your code can import exactly the packages your target declares in `deps`, and each dependency can
  import exactly the packages it declares in its own `package.json`.
- **Most "cannot find module" errors are an undeclared dependency.** The fix is almost always to
  add the package to your target's `deps` (see [Troubleshooting](#troubleshooting)).

## Which package a name refers to

With npm, an import of a package name is found by searching the `node_modules` directories above
the importing file. Whatever happens to be installed there answers, whether or not it was declared.
Because npm hoists packages to the top level, code can often import packages it never declared and
get away with it, until an unrelated change moves them.

Fabr has no `node_modules` directory at build time. Each package is stored once, together with a
record of exactly which packages it depends on, and every import of a package name is answered from
that record:

- **Your sources** can import the packages listed in your target's `deps`, and nothing else.
- **Each dependency** can import the packages declared in its own `package.json`: `dependencies`,
  `optionalDependencies` and `peerDependencies`.
- **Nothing outside the build** is ever consulted. A `node_modules` directory elsewhere on your
  machine, even in a parent folder of your project, cannot answer an import.

If you've used pnpm or Yarn Plug'n'Play, this will be familiar: fabr is strict in the same way, and
for the same reason. A build then depends only on what was declared, so it behaves the same on
every machine.

### Undeclared imports in your dependencies

Many npm packages import something they forgot to declare, relying on npm's hoisting to supply it.
Fabr accommodates this without special configuration: **when a dependency imports a package it
didn't declare, the import resolves if your target declares that package.** The version used is
the one your target selected.

So a failing import inside a third-party package is fixed from your side, by adding the package it
needs to your target's `deps`. You don't need to patch the dependency.

Your own sources don't get this allowance. An undeclared import in your code is always an error,
because the fix (declaring the dependency) is in your hands.

For third-party packages known to import something they don't declare, fabr repairs the declaration
for you. It uses the same curated
list of manifest fixes as Yarn and pnpm ([`@yarnpkg/extensions`](https://www.npmjs.com/package/@yarnpkg/extensions)),
which adds the dependencies and peer dependencies those packages leave out. For example, `reactcss`
uses `react` without declaring it; fabr treats `react` as one of its peer dependencies, so it shares
the `react` your build uses wherever `reactcss` appears, and nothing needs declaring on your side.

### Importing your own package by name

A package can import itself by its own name. In a `js_package` named `@acme/widgets`, both
`import "@acme/widgets"` and `import "@acme/widgets/util/format"` resolve into the package's own
sources, just as they would for a consumer of the published package. When fabr compiles TypeScript,
it writes these imports as relative paths in the output; see
[TypeScript compilation](/reference/js/typescript/#imports-of-your-own-package-are-written-as-relative-paths).

### Aliases

An npm alias in a dependency's `package.json`, such as `"string-width-cjs": "npm:string-width@^4"`,
works as it does with npm: the dependency imports the package under the alias name.

In your own `deps`, you can give a package a different name with `->`:

```
deps = @npm:typescript:6.0.0-beta -> typescript-6;
```

Your code then imports the package as `typescript-6`, and the name is written back as an npm alias
in the `package.json` fabr generates for your package.

## Which version you get

Each target resolves its dependencies together, including the ones its dependencies bring with
them, and uses **one version of each package** throughout. Where the declared version ranges can't
agree on one version, fabr reports the conflict and suggests how to resolve it.
[Dependencies](/reference/js/dependencies/) covers how versions are chosen, how that differs from
npm, and catalogs, which pin versions for a whole project.

### Peer dependencies

A peer dependency is resolved against the packages its consumer uses. If `react-dom` declares
`react` as a peer, it gets the `react` your target uses.

More precisely, a package gets the copy that the package depending on it uses, as with Yarn and
pnpm. Where that dependent doesn't use the peer itself, the search continues up through its own
dependents to your target, and finally falls back to the version the build selected.

It gets that copy even when it's outside the peer's declared range. For example, `react-sortable-hoc` 2.0.0 declares `react` `^16.3.0 || ^17.0.0`, and in a build that uses
React 18 it shares React 18, rather than getting a React 16 of its own that would break React's
single-copy assumption. Whether the package works with that version is then a question of
compatibility, as it is under those tools; if it doesn't, update the package or use a version of
the peer it supports.

To choose which copy a package's peer uses, declare a package under that name in the target that
uses it. For example, `typia` peers on `typescript`; this gives it TypeScript 6 whatever version
the rest of the project uses, here by renaming a catalog entry:

```
js_script typia_tool {
  entry = @dep:typia;
  deps = @dep:typescript-6 -> typescript;
}
```

One consequence is worth knowing. When a package reaches its peer through two different routes
that end at different copies of the peer (for example, where you've allowed two versions of
the peer in one build), fabr keeps a separate copy of the package for each. That's correct
behaviour, but, as with nested copies under npm, the copies don't share module state. Singletons,
`instanceof` checks and React contexts created from one copy aren't recognised by the other. If
you see this, bringing the peer down to one version removes the extra copy.

An optional peer dependency (`peerDependenciesMeta: { "x": { "optional": true } }`) is connected
only when the build already includes that package; declaring it optional never adds it.

Some packages name an optional peer only in `peerDependenciesMeta`, with no entry in
`peerDependencies`; `sequelize` declares its database drivers this way. Fabr reads that as an
optional peer that accepts any version, as Yarn and pnpm do. npm ignores the entry and relies on
hoisting to find the package.

## Inside a package

Once fabr knows which package a name refers to, finding the file inside it follows the rules
Node.js uses for `require()`, whichever module format you're producing:

1. **An `exports` map, if the package has one, decides.** Only the paths it lists can be imported,
   and its conditions are matched in the order the package lists them. Each target names a file
   exactly: no extension is added and no `index` file is looked for.
2. **Otherwise, the package's files decide.** The bare name resolves through the `main` field (or
   `types`, when looking for type declarations), and a subpath such as `lodash/merge` names a file
   in the package. The extension may be left off, and a directory resolves to its `index` file.
3. **`#` names** (`#internal/util`) resolve through the `imports` map of the package containing the
   importing file, taken from its nearest `package.json`.

### Export conditions by tool

Which conditions in an `exports` map apply depends on what's reading the package:

| Tool | Conditions |
|---|---|
| TypeScript compilation | `types`; `import` for ES-module output or `require` for CommonJS output; `module-sync` |
| Bundling (`js_bundle`) | esbuild's usual conditions for the platform in `JS_TARGET` (`browser` or `node`), plus `module-sync` |
| Sass stylesheets | `sass`, `style` |
| Tests and `fabr run` | Node.js's own conditions (`node`, `import`/`require`, `module-sync`, `default`) |

Tests and programs started with `fabr run` execute from a generated `node_modules` directory
containing exactly the packages the build resolved, so Node.js's own resolution applies to them
unchanged. The directory is laid out the way pnpm lays one out:

- The top level holds only the packages the target declares.
- Each package is stored once, under `node_modules/.fabr/`, with links to its own dependencies
  beside it. Every package that depends on it loads that one copy, so module state (singletons,
  `instanceof` checks) is shared, including when the build holds two versions of a package.
- A package that imports something it didn't declare still finds it if the package is anywhere
  in the build. This is more lenient than compiling and bundling, where such an import resolves
  only if your target declares the package.

A file's real location is therefore under `node_modules/.fabr/`, which is what `__dirname` and
stack traces show.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Cannot find module 'x'" in your own code | `x` isn't in your target's `deps` | Add it to `deps` |
| "Cannot find module 'x'" inside a dependency | The dependency imports `x` without declaring it | Add `x` to your target's `deps` |
| An import that works with npm fails under fabr | It relied on hoisting: the package was installed, but not declared by the importer | Add the package to your target's `deps`, whether the import is in your code or in a dependency |
| "Cannot find module 'pkg/sub'" where the file exists | `pkg` has an `exports` map that doesn't list `./sub` | Import a path the package exports; the file is internal to the package |
| Two copies of a package; `instanceof` or context checks fail | Two versions of one of its peer dependencies are in the build | Bring the peer dependency down to one version |
| A version conflict error | Declared version ranges can't agree on one version | Follow the suggestion in the error; see [Dependencies](/reference/js/dependencies/#when-versions-conflict) |
