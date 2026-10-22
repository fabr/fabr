---
title: Plugin reference
description: The fabr plugin contract — how a plugin is installed and loaded, and the rules, repository types and .fabr files it contributes.
---

A plugin is an npm package that adds target types to fabr. It contributes the rules that build
them, any repository types they need, and the `.fabr` files that declare them. Everything
language-specific in fabr works this way: `@fabr-build/js`, which builds JavaScript and
TypeScript, is a plugin like any other.

This page is the reference for the plugin contract: how a plugin is installed and loaded, what it
exports, and the rule and repository types it registers. To build a plugin step by step, start
with [Writing a plugin](/developer/writing-a-plugin/).

## Using a plugin

A build file loads a plugin with a `plugin` declaration:

```
plugin @example/text-lint;
```

The declaration brings in the plugin's own `.fabr` files, so its target types can be used straight
away, with no `include`. A plugin declared in several files is loaded once. Core's own library is
always present, so the `flag`, `script`, `generate`, `patched`, `serve` and `sync` target types,
and the `catalog`, `fetch`, `repository_group` and `fabr_home` repository types, need no
declaration.

Fabr finds a plugin the way Node.js finds a module: from where fabr itself is installed. Install
the plugin in the same place as `@fabr-build/cli`, for example in your project:

```sh
npm install --save-dev @fabr-build/cli @example/text-lint
npx fabr build
```

A plugin that cannot be found is an error (`Plugin '@example/text-lint' is not installed`). So is
one installed where it would load its own copy of `@fabr-build/core` rather than fabr's: a
separately installed global package does, so a plugin cannot be added to a global install of
fabr. `@fabr-build/js` is a dependency of `@fabr-build/cli`, so it is installed with it.

## The plugin package

An installed plugin package looks like this:

```
@example/text-lint/
  package.json      its main module, and a peer dependency on @fabr-build/core
  index.js          exports activate()
  lib/
    LINT.fabr       target types, globals, the plugin's own tool targets
    linter.sh       files those targets name
```

The `.fabr` files go in a `lib/` directory beside the package's main module. Fabr can build the
package itself, as a `js_package`:

```
plugin @fabr-build/js;

js_package @example/text-lint {
  srcs = src:**/*.ts lib/**;
  exports = src:index.ts;
  provided_deps = @npm:@fabr-build/core:^0.3.1;
}
```

A plugin depends on `@fabr-build/core` as a **peer dependency** (`provided_deps`, written to the
package's `package.json` as `peerDependencies`). It must use fabr's own copy of core, never a copy
of its own: the classes and values a rule exchanges with fabr are core's, and a second copy of
core would make them a different, incompatible set. A plugin imports what it needs from
`@fabr-build/core` directly. [Writing a plugin](/developer/writing-a-plugin/) builds, tests and
publishes a plugin this way.

Code a plugin arranges to run in another process, such as `@fabr-build/js`'s test runner, which
runs inside the test's own working directory, cannot reach fabr's core at all. It must have no
runtime dependency on `@fabr-build/core`; type-only imports are fine.

## activate()

The main module exports a function `activate` that returns the plugin's contribution:

```ts
import { packageLibFile, PluginContribution } from "@fabr-build/core";

export function activate(): PluginContribution {
  return {
    rules: [textLint],
    repositories: [],
    includes: [packageLibFile("@example/text-lint", "LINT.fabr")],
  };
}
```

`activate` takes no arguments, registers nothing and has no side effects: fabr calls it to learn
what the plugin provides, once per load of a project.

| Field | What it holds |
|---|---|
| `rules` | The rules that build the plugin's target types: see [Rules](#rules). |
| `repositories` | Repository types: see [Repository types](#repository-types). |
| `includes` | Absolute paths of the plugin's `.fabr` files. `packageLibFile(name, file)` gives the path of `file` in the `lib/` directory of the installed package `name`. |

A target type's schema, its `targetdef`, is declared in a `.fabr` file, not in code: see
[Targetdef declarations](/reference/syntax/#targetdef-declarations).

## Rules

A rule is the code that builds targets of a type. Write one with `defineRule`, which types what
the rule's evaluation receives from what `requirements` returns:

```ts
const textLint = defineRule({
  type: "text_lint",
  properties: {},
  requirements: context => ({ srcs: context.getFileProperty("srcs") }),
  evaluateMaterialized: (context, { srcs }) => /* … */,
});
```

| Field | Meaning |
|---|---|
| `type` | The target type the rule builds. Omit it for a default rule, consulted for any type that has no rule of its own that applies. |
| `properties` | A guard on the build configuration: property name → glob pattern, such as `{ BUILD_OPERATION: "test" }`. `{}` applies everywhere. |
| `targetProperties` | A guard on the target's own string properties, such as `{ framework: "vitest" }`. Each key must be a string property of the type's `targetdef`. |
| `requirements` | Returns what the target requires, or a `Computable` of it: see [Requirements](#requirements). |
| `evaluateMaterialized` | Builds the target from its requirements, each given its content first: see [Evaluate](#evaluate). |
| `evaluateResolved` | Builds the target from its requirements as resolved, giving them content when it asks. A rule has this or `evaluateMaterialized`, not both. |
| `value` | `true` for a target that is a value with nothing to build, such as a flag: the rule is evaluated where the target is read, and its result stands for the target. |

### Which rule builds a target

A guard is matched as a declaration's guard is: the configuration's properties are read, so a
`default`, a declared global and a `-D` option on the command line all count, and the patterns are
globs. A key with no value makes the rule not apply. Of the rules that apply, the one naming the
most keys across its two guards is chosen, and two equally specific rules are an error. A type's
own rules are preferred to default rules.

The build verb is the `BUILD_OPERATION` property: `fabr test x` builds `x` with
`BUILD_OPERATION=test`, so `properties: { BUILD_OPERATION: "test" }` makes a rule that runs under
`fabr test` only. Configuration propagates to what a target depends on, so a rule for one operation
reads its dependencies under `build` explicitly (`context.getFileProperty("deps", BUILD_OVERRIDE)`).

### Requirements

`requirements(context)` reads the properties and globals that name the target's file
dependencies (files, packages and other targets), and returns them as a map from a name of the
rule's choosing to the sources read, or a `Computable` of that map where it depends on a value
read first. Nothing is fetched or built here: fabr resolves the requirements, and they are given
content for the rule's evaluation. Use a `Map` where the names come from the user.

Only `FILES` and `PACKAGES` properties are requirements. A string, map or command property has
nothing to resolve: it has one form, its value, which the evaluation reads directly from `context`
(`getString`, `getProperty`, `getMap`). The types enforce this: a value read that way does not
type-check as a requirement.

How a property is read says what its sources are for:

| Read with | What a target named there is | What a registry package (`@npm:foo:1.0.0`) is |
|---|---|---|
| `getFileProperty(name)` | Built, and its files used | That package's own files, nothing it requires |
| `getPackageProperty(name)` | The package it builds | A requirement, resolved with the target's others: one version of each package |
| `getLooseFileProperty(name)` | Built, and its files used, unless it builds a package | Left out |

A `targetdef` declares each property `FILES` or `PACKAGES`. `getPackageProperty` reads only a
`PACKAGES` property; `getFileProperty` reads either.

Three requirement names say what the target passes on to whatever depends on it:

- **`dependencies`**: what a package the target builds requires.
- **`provided`**: the same, for requirements the consumer supplies (npm's peer dependencies).
- **`extends`**: the package the target is made from; where that is one package, the target passes
  on its version and requirements.

These must be read with `getPackageProperty`. Every other name is private to the target's build.
Stating what a target passes on is what lets whatever depends on it be resolved, and shown by
`fabr deps`, before it is built. A rule that states none of these says its target passes nothing
on, and a package it builds that requires something it did not state is refused where it is
depended on.

A package the rule returns lists what it requires as its `dependencies`: `{ reference, package }`
pairs, the edges `requirements.packages("dependencies")` hands the evaluation — each package among
the requirement with the reference it was resolved for.

Everything a target depends on belongs in `requirements`, except the **tools** it runs, which are
read in the evaluation ([below](#running-a-tool)). Whatever the evaluation reads for itself is not part of
the resolved graph: `fabr deps` does not show it, and a dependency cycle through it is only found
when the target is built.

**Version conflicts.** The packages a target requires are resolved together, and where one
package would be used at two versions that are not both allowed (with a `?`), the requirements are
in conflict. The conflicts are found when the requirements are resolved, and a target fails when
it first materializes them. A rule that assembles a program to be run rather than linked against
returns its requirements wrapped in `permissive(…)`, and is not refused for them:

```ts
requirements: context => permissive({ deps: context.getPackageProperty("deps") }),
```

### Evaluate

`evaluateMaterialized(context, materialized)` receives every requirement with its content, by
name: each a list of `FileSet`s, one for each source written. `evaluateResolved(context,
requirements)` receives them resolved and without content, and gives them content with
`requirements.materializeAll()`, or `requirements.materialize(name)` for one of them, so that a
requirement it does not need is never fetched or built; `requirements.packages(name)` gives the
packages among one as the edges to them, each with the reference it was resolved for.

Either returns the target's content directly (a `FileSet`) or a `BuildAction` that produces it,
or a `Computable` of one. The rule is evaluated on every build; a `BuildAction` is what fabr
caches.

Write the evaluation as an arrow function, as above. TypeScript gives the requirement names
their types only once it has typed `requirements`, so a named function passed as
`evaluateMaterialized` beside an inline `requirements` arrow sees no names at all.

#### Running a tool

A rule never runs a program itself. It reads the tool as a runnable with
`context.getGlobalRunnable(name)` (or `getRunnableProperty` for a tool named by a property), and
returns a `BuildAction` that runs it:

- `createExecAction(files, argv, outputs?, label?)` stages `files` in an empty working directory,
  runs `argv` there with an empty environment, and collects the files matching `outputs` as the
  result. A non-zero exit fails the target, with the program's output in the error.
- `new BuildAction(step, inputs, config, discoverable?, label?)` runs a step of your own,
  `{ id, version, run(action, ctx, report) }`, where `createExecAction` will not do.

An action's result is cached under its step's `id` and `version` and a digest of its `inputs`
(file content) and `config` (arguments, patterns, generated configuration). Bump `version` when
the step's behaviour changes.

#### Composing targets

`context.subTarget(type, inputs, { label, constraints })` builds an anonymous target of `type`
from the `inputs` you hand it, through the same rule a declared target of that type uses, and
returns its output for you to use in your own action or result. A rule reads a sub-target's
inputs with the same property readers it uses for a declared target. Actions do not nest:
composition is always through sub-targets.

## Repository types

A repository answers references such as `@npm:semver:7.6.0`. A plugin contributes a repository
type as `{ type, provider }`, and a build file declares a repository of that
type (`npm_repository @npm { … }`).

The `provider` is called once per build configuration that uses the repository, with the
declaration's `TargetContext`: its property readers, `memoize(tag, key, fn)` to cache the result of
a resolution, `fetch(url, tag, process, report)` to download, and `runTask` to report progress. It
returns a `Repository`, or a plain `FileSource` for a repository that only holds files.

A `Repository` makes references from what is written (`getRepositoryRef`, and
`getRepositoryPublishRef` for [`sync`](/reference/js/publishing/)). Each reference carries the
interface that answers it:

| Interface | Answers | Example |
|---|---|---|
| `RepositoryReader` | A registry. The references to it that a target makes are resolved together, one version of each package. It supplies each version's requirements (`getRequirements`), the package (`fetch`), a package's own files (`fetchFiles`), and states the operation of the configuration it was made in (`operation`), which decides whether a reference to it is answered with the package, its files alone, or the program it is. | `npm_repository` |
| `RepositoryLookup` | Each reference on its own (`resolve`, optionally `resolveFiles`). | `fabr_home` |
| `RepositoryCollection` | A set the repository resolved itself (`member`). | `catalog` |

A namespace can answer names it does not declare through a repository: a property of the
namespace's own name is its fallback, and a name under the namespace that nothing declares is a
reference into the property's value. STD.fabr makes packages installed with fabr available as
`@fabr-build/<package>` this way, with `fabr_home @fabr-home { }` and
`default @fabr-build = @fabr-home:@fabr-build;`. `@fabr-home:@fabr-build` names the scope rather
than a package: `getRepositoryRef` may return a `NamespaceRef` naming a namespace of the
repository's names, which a name projected into it goes on from.

## Current limitations

- A plugin must be installed beside fabr; fabr cannot build a plugin from source and load it in
  the same build.
- A plugin can build on `@fabr-build/core` only, not on another plugin's exports, since that would
  load a second copy of the other plugin.
- The interface is the whole of `@fabr-build/core`. It is not yet versioned or stable.
