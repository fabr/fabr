---
title: Plugin reference
description: The fabr plugin contract — how a plugin is installed and loaded, and the rules, repository types and .fabr files it contributes.
---

A plugin is an npm package that adds target types to fabr. Its `.fabr` files declare the types, the
rules that build them and any repository types they need, and its code implements the rules and
repository types. Everything
language-specific in fabr works this way: `@fabr-build/js`, which builds JavaScript and
TypeScript, is a plugin like any other.

This page is the reference for the plugin contract: how a plugin is installed and loaded, what it
exports, and the rule and repository types it registers. To build a plugin step by step, start
with [Writing a plugin](/developer/writing-a-plugin/).

## Using a plugin

A build file loads a plugin with a `plugin` declaration:

```
plugin @fabr-home:@example/text-lint;
```

The declaration brings in the plugin's own `.fabr` files, so its target types can be used straight
away, with no `include`. A plugin declared in several files is loaded once. Core's own library is
always present, so the `flag`, `script`, `generate`, `patched`, `serve` and `sync` target types,
and the `catalog`, `fetch`, `repository_group` and `fabr_home` repository types, need no
declaration.

A plugin's name is read like any other reference. Fabr's own plugins are named as they are
published, `@fabr-build/js` and `@fabr-build/java`: names in the `@fabr-build` scope mean the
packages installed alongside fabr. Any other plugin installed alongside fabr is named through
`@fabr-home`, the set of packages installed with it, and found the way Node.js finds a module:
from where fabr itself is installed. Install the plugin in the same place as `@fabr-build/cli`, in
your project or globally:

```sh
npm install --save-dev @fabr-build/cli @example/text-lint
npx fabr build
```

```sh
npm install -g @fabr-build/cli @example/text-lint
```

```
plugin @fabr-home:@example/text-lint;
```

A plugin can also be named through a repository: `plugin @npm:@example/text-lint:1.2.0;` fetches
that version from npm, once a plugin declaring `@npm` (`@fabr-build/js`) is in use. A name is
resolved once what it starts with is declared, by the project or by a plugin already in use, so the
order the `plugin` declarations are written in means nothing; a name nothing declares is an error
(`Plugin '@example/text-lint' names nothing the project declares`). A name the project declares can
stand for an installed plugin: with `@boot = @fabr-home:@fabr-build;`, `plugin @boot/js;` uses the
installed `@fabr-build/js`. The plugin's rules still name it as itself, so using one package under
two names is an error.
`@fabr-build/js` is a dependency of `@fabr-build/cli`, so it is installed with it.

### A plugin built in the project

A project can build a plugin it uses, so a plugin can be developed beside the projects that test
it without being installed after each change. A `fabr_plugin` target declares it: the package that
is its code, and its `.fabr` files.

```
plugin @fabr-build/js;
plugin @example/text-lint;

js_package text_lint_code {
  srcs = src:**/*.ts;
  exports = src:rules/*.ts;
}

fabr_plugin @example/text-lint {
  srcs = text_lint_code;
  libs = lib/LINT.fabr;
}

text_lint docs { srcs = docs/**/*.md; }
```

Where a `plugin` declaration names a `fabr_plugin` target, fabr reads the target's `libs` with the
project's own files, before anything is built, and loads no installed copy. The plugin's code is
built, for the machine fabr runs on, the first time a rule or repository it implements is used; a
run that uses none of them builds none of it.

Built (`fabr build @example/text-lint`), the target is the plugin as a package: its code with its
`libs` and any `resources` added, and a `package.json` naming it as the plugin and listing its
`libs`, which is what an installed copy is read from.

## The plugin package

An installed plugin package looks like this:

```
@example/text-lint/
  package.json      marks the package a plugin, and lists its .fabr files
  rules/
    TextLint.js     a rule's implementation
  lib/
    LINT.fabr       target types, rules, globals, the plugin's own tool targets
    linter.sh       files those targets name
```

What makes the package a plugin is its `package.json`, which lists the plugin's `.fabr` files
under `"@fabr-build/plugin"`, as paths within the package:

```json
{
  "name": "@example/text-lint",
  "@fabr-build/plugin": { "libs": ["lib/LINT.fabr"] },
  "exports": { "./rules/*": "./rules/*.js" }
}
```

Using a plugin reads those files and runs none of its code; `exports` makes importable each module
a rule or repository declaration names. A package without the field is not a plugin, and naming
it in a `plugin` declaration is an error.

A plugin's `.fabr` files declare only defaults: `default` properties and targets (`default flag
dom { }`, `default js_script TEXT_LINTER { … }`), along with target types, `rule` and `repository`
declarations, and `plugin` declarations of the plugins it builds on. An ordinary declaration there
is an error, and so is a `fabr_plugin`: only a project declares a plugin it builds. So a project's own declaration of a name always takes precedence, and a plugin used
later never changes what was read before it.

Fabr builds such a package from a [`fabr_plugin`](#a-plugin-built-in-the-project) target, which
writes the `package.json` for it: the plugin's code is a `js_package`, and the `fabr_plugin` adds
its `.fabr` files.

```
plugin @fabr-build/js;

js_package text_lint_code {
  srcs = src:**/*.ts;
  exports = src:rules/*.ts;
  provided_deps = @npm:@fabr-build/core:^0.3.1;
}

fabr_plugin @example/text-lint {
  srcs = text_lint_code;
  libs = lib/LINT.fabr;
  resources = lib/linter.sh;
}
```

A plugin depends on `@fabr-build/core` as a **peer dependency** (`provided_deps`, written to the
package's `package.json` as `peerDependencies`). A plugin imports what it needs from
`@fabr-build/core` directly, and always gets fabr's own copy, whatever copy its install holds: the
classes and values a rule exchanges with fabr are core's, and a second copy would make them a
different, incompatible set. So the version range a plugin declares for core must include the
version of the fabr that loads it, or loading it is an error. [Writing a plugin](/developer/writing-a-plugin/) builds, tests and
publishes a plugin this way.

### Tools in a package of their own

A program a plugin's rules run, such as a compiler driver or a test runner, runs in a process of
its own, staged by fabr, where fabr's core is not loaded. Its code must have no runtime dependency
on `@fabr-build/core`; type-only imports are fine. `@fabr-build/js` keeps its programs in a
separate package, `@fabr-build/js-tools`, and a plugin with tools of its own can do the same:

```
js_package @example/text-lint-tools {
  srcs = src:**/*.ts;
  optional_provided_deps = @npm:@fabr-build/core:^0.3.1;
}
```

Each program is a file under `src/bin/`, such as `src/bin/lint.ts`, which the generated
`package.json` declares as the bin `lint`. `optional_provided_deps` makes core an optional peer
dependency: the tools compile against core's types, and nothing has to install core beside them
where they run. The plugin package lists the
tools package in its `deps`, so installing the plugin installs the tools too.

The plugin's `.fabr` files then declare each tool as a target, naming the installed package
through `@fabr-home`, the set of packages installed alongside fabr:

```
default js_script TEXT_LINTER {
  entry = @fabr-home:@example/text-lint-tools:lint;
}
```

`@fabr-home:<package>` is the package installed alongside fabr, found as Node.js would find it
from fabr's own code, and `:lint` selects its `lint` bin. `@fabr-build/js` names its tools as
`@fabr-build/js-tools:fabr-tsc` and so on, through the standard `@fabr-build` property that stands
in for every installed `@fabr-build/*` package; see
[Properties that stand in for a group of names](/reference/syntax/#properties-that-stand-in-for-a-group-of-names).

## activate()

A plugin needs no code beyond its implementations. Where its package has a main module, that
module may export a function `activate`, which fabr calls once, when it first loads one of the
plugin's implementations, before loading it:

```ts
export function activate(): void {
  /* … */
}
```

A run that uses none of the plugin's rules or repository types loads none of its code, and so
does not call it.

A target type's schema, its `targetdef`, is declared in a `.fabr` file, not in code: see
[Targetdef declarations](/reference/syntax/#targetdef-declarations).

## Rules

A rule says how targets of a type are built. It is declared in a `.fabr` file, and names the
module that implements it:

```
rule text_lint t = @example/text-lint:rules/TextLint;
rule js_test t<BUILD_OPERATION=test, t.framework=mocha> = @example/mocha:rules/TestMocha;
default rule t<BUILD_OPERATION=files> = @fabr-build/core:rules/DefaultFilesRule;
```

A declaration names the target type, a name for the target, its guards, and its implementation.
`default rule` is a rule for every type, consulted for a type with no rule of its own that applies.

| Part | Meaning |
|---|---|
| `<BUILD_OPERATION=test>` | A guard on the build configuration: a property and a glob pattern its value must match. |
| `<t.framework=mocha>` | A guard on the target's own properties, through its name. Each must be a string property of the type's `targetdef`. |
| `@example/mocha:rules/TestMocha` | The implementation: an entry of a package, the module `rules/TestMocha` that `@example/mocha` exports. The package is a plugin the project uses, or `@fabr-build/core`; the name means the copy fabr loaded. |

The implementation is the module's default export. Write it with `defineRule`, which types what
the evaluation receives from what `requirements` returns:

```ts
export default defineRule({
  requirements(context) {
    return { srcs: context.getFileProperty("srcs") };
  },
  evaluateMaterialized(context, { srcs }) {
    /* … */
  },
});
```

| Field | Meaning |
|---|---|
| `requirements` | Returns what the target requires, or a `Computable` of it: see [Requirements](#requirements). |
| `evaluateMaterialized` | Builds the target from its requirements, each given its content first: see [Evaluate](#evaluate). |
| `evaluateResolved` | Builds the target from its requirements as resolved, giving them content when it asks. A rule has this or `evaluateMaterialized`, not both. |
| `value` | `true` for a target that is a value with nothing to build, such as a flag: the rule is evaluated where the target is read, and its result stands for the target. |

Fabr loads an implementation the first time its rule builds a target, so a rule that builds nothing
in a run loads nothing.

### Which rule builds a target

A guard is matched as a declaration's guard is: the configuration's properties are read, so a
`default`, a declared global and a `-D` option on the command line all count, and the patterns are
globs. A key with no value makes the rule not apply. Of the rules that apply, the one naming the
most keys across its two guards is chosen, and two equally specific rules are an error. A type's
own rules are preferred to default rules. A rule is chosen from its declaration alone: nothing is
loaded to choose it.

The build verb is the `BUILD_OPERATION` property: `fabr test x` builds `x` with
`BUILD_OPERATION=test`, so `<BUILD_OPERATION=test>` makes a rule that runs under `fabr test`
only. Configuration propagates to what a target depends on, so a rule for one operation
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

Four requirement names say what the target passes on to whatever depends on it:

- **`dependencies`**: what a package the target builds requires.
- **`provided`**: the same, for requirements the consumer supplies (npm's peer dependencies).
- **`optional_provided`**: as `provided`, for requirements the consumer may leave out (npm's
  optional peer dependencies). The target is built against them, and each is bound only to what
  the consumer supplies or already has installed.
- **`extends`**: the package the target is made from; where that is one package, the target passes
  on its version and requirements.

These must be read with `getPackageProperty`. Every other name is private to the target's build.
Stating what a target passes on is what lets whatever depends on it be resolved, and shown by
`fabr deps`, before it is built. A rule that states none of these says its target passes nothing
on, and a package it builds that requires something it did not state is refused where it is
depended on.

A package the rule returns lists what it requires as its `dependencies`: `{ reference, package }`
pairs, the edges `requirements.packages("dependencies")` hands the evaluation — each package among
the requirement with the reference it was resolved for. The edges from `provided` and
`optional_provided` go in the same list, and the package's `provided` map names each of them,
`"expected"` or `"optional"`.

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
requirements(context) {
  return permissive({ deps: context.getPackageProperty("deps") });
},
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

A repository answers references such as `@npm:semver:7.6.0`. A repository type is declared in a
`.fabr` file, naming the module that implements it, and a build file declares a repository of that
type (`npm_repository @npm { … }`):

```
repository npm_repository = @fabr-build/js:NPMRepository;
```

The implementation is the module's default export, a `provider` function. It is called once per build configuration that uses the repository, with the
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

A repository named on its own, or with a scope of its names (`@fabr-home:@fabr-build`), is
not a package: `getRepositoryRef` may return a `NamespaceRef` for a scope, from which a name
projected into it (`@fabr-build/js-tools`) goes on. This is what lets a property of a group's name
answer every name in the group; see
[Properties that stand in for a group of names](/reference/syntax/#properties-that-stand-in-for-a-group-of-names).

## Current limitations

- A rule or repository declaration names an implementation of fabr's core or of a plugin the
  project uses, not of any other package.
- A plugin can build on `@fabr-build/core` only, not on another plugin's exports, since that would
  load a second copy of the other plugin.
- The interface is the whole of `@fabr-build/core`. It is not yet versioned or stable.
