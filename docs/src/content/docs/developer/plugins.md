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
always present, so the `flag`, `script`, `generate`, `patched`, `zip`, `serve` and `sync` target
types, and the `catalog`, `fetch`, `repository_group`, `fabr_home` and `host_searchpath` repository
types, need no declaration.

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
it without being installed after each change. A `fabr_plugin` target declares it. The type
[extends](/reference/syntax/#extending-a-type) `js_package`, so you write the plugin's code as you
would any package's, and list its `.fabr` files as `libs`.

```
plugin @fabr-build/js;
plugin @example/text-lint;

fabr_plugin @example/text-lint {
  srcs = src:**/*.ts;
  exports = src:rules/*.ts;
  libs = lib/LINT.fabr;
}

text_lint docs { srcs = docs/**/*.md; }
```

Where a `plugin` declaration names a `fabr_plugin` target, fabr reads the target's `libs` with the
project's own files, before anything is built, and loads no installed copy. So `libs` and
`optional_libs` must be literal paths or patterns, relative to the file declaring the target, with
no `${…}` substitution or [splice](/reference/syntax/#splicing-a-map-into-a-target). The plugin's
code is built, for the machine fabr runs on, the first time a rule or repository it implements is
used; a run that uses none of them builds none of it.

A plugin whose `resources` include something its own rules build depends on itself, and fails
with `Circular dependency: '@example/text-lint' depends on itself`. Build it in two stages, with a
property of your own: the project uses the plugin without those resources, and the copy you build
and publish has them:

```
STAGE = 1;

plugin @example/text-lint<STAGE=0>;

fabr_plugin @example/text-lint {
  srcs = src:**/*.ts;
  exports = src:rules/*.ts;
  libs = lib/LINT.fabr;
  resources<STAGE=1> = lint-rules;
}

text_lint lint-rules { srcs = rules/**; }
```

Built (`fabr build @example/text-lint`), the target is the plugin as a package: the package its
`js_package` properties build, with its `libs` and any [`optional_libs`](#optional-fabr-files)
added, and a `package.json` naming it as the plugin and listing its `.fabr` files, which is what an
installed copy is read from. A project including one of the target's `optional_libs` reads it from
the project, as it does `libs`. Every other operation is `js_package`'s: `fabr test
@example/text-lint` runs the plugin's tests.

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
declarations, `plugin` declarations of the plugins it builds on, and
[`private`](/reference/syntax/#private-declarations) declarations, which only that file sees. Any
other declaration there is an error that asks you to write it as a `default`, and so is a `fabr_plugin`: only a project declares a plugin it builds.
So a project's own declaration of a name always takes precedence, and a plugin used later never
changes what was read before it.

### Optional .fabr files

A plugin can also provide `.fabr` files that a project reads only where it includes them: target
types and rules for a framework some projects use, such as the Java plugin's Spring Boot
executable jar. List them as `optional_libs`, beside `libs`:

```json
"@fabr-build/plugin": { "libs": ["lib/LINT.fabr"], "optional_libs": ["lib/markdown.fabr"] }
```

A project using the plugin includes one by the plugin's package name and the file's path within
the package, whatever name its `plugin` declaration uses:

```
plugin @fabr-home:@example/text-lint;
include @example/text-lint:lib/markdown.fabr;
```

An optional file follows the same rules as the plugin's other `.fabr` files: it declares only
defaults, and its rules name the plugin's implementations as they do. Its own `include`s of paths
are relative to it, within the package.

Fabr builds such a package from a [`fabr_plugin`](#a-plugin-built-in-the-project) target, which
writes the `package.json` for it: the target is a `js_package` of the plugin's code, with its
`.fabr` files added.

```
plugin @fabr-build/js;

fabr_plugin @example/text-lint {
  srcs = src:**/*.ts;
  exports = src:rules/*.ts;
  provided_deps = @npm:@fabr-build/core:^0.4.0;
  libs = lib/LINT.fabr;
  optional_libs = lib/markdown.fabr;
  resources = lib/linter.sh;
}
```

Each of `libs` and `optional_libs` is listed in the `package.json` by its path relative to the
file declaring the target, which is its path in the package.

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
  optional_provided_deps = @npm:@fabr-build/core:^0.4.0;
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
A rule that only combines targets of existing types can instead be written in `.fabr`, with no
code at all; see [Writing your own rules](/guides/rules/).

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
    return { build: { srcs: context.getFileProperty("srcs") } };
  },
  evaluateMaterialized(context, { srcs }) {
    /* … */
  },
});
```

| Field | Meaning |
|---|---|
| `requirements` | Returns what resolution needs to know of the target (what it requires, and what it builds), or a `Computable` of it: see [Requirements](#requirements). |
| `evaluateMaterialized` | Builds the target from its requirements, each given its content first: see [Evaluate](#evaluate). |
| `evaluateResolved` | Builds the target from its requirements as resolved, giving them content when it asks. A rule has this or `evaluateMaterialized`, not both. |
| `describe` | Describes the target for an editor, as the rule would build it, without building it: see [Describe](#describe). Optional. |
| `value` | `true` for a target that is a value with nothing to build, such as a flag: the rule is evaluated where the target is read, and its result stands for the target. |

Fabr loads an implementation the first time its rule builds a target, so a rule that builds nothing
in a run loads nothing.

### Which rule builds a target

A guard is matched as a declaration's guard is: the configuration's properties are read, so a
`default`, a declared global and a `-D` option on the command line all count, and the patterns are
globs. A key with no value makes the rule not apply. Of the rules that apply, the one naming the
most keys across its two guards is chosen, and two equally specific rules are an error. A type's
own rules are preferred to the rules of a type it [extends](/reference/syntax/#extending-a-type),
those to the rules of the type that one extends, and all of them to default rules. A rule is chosen
from its declaration alone: nothing is loaded to choose it.

**Building on the extended type's rule.** A target of a type that
[extends](/reference/syntax/#extending-a-type) another has every property the extended type's
rules read, so a rule for the new type can call the extended type's implementation with its own
context and add to what it builds. `fabr_plugin[build]` builds the
plugin's code with `js_package[build]`'s implementation, its requirements with two of its own
beside them:

```ts
import jsPackage from "./BuildJSPackage";

export default defineRule({
  requirements(context) {
    const stated = jsPackage.requirements!(context);
    return (stated instanceof Computable ? stated : Computable.resolve(stated)).then(spec => ({
      ...spec,
      build: {
        ...(Object.fromEntries(spec.build instanceof Map ? spec.build : Object.entries(spec.build ?? {})) as Record<string, RequiredSources>),
        libs: context.getFileProperty("libs"),
        optional_libs: context.getFileProperty("optional_libs"),
      },
    }));
  },
  evaluateResolved(context, requirements) {
    return jsPackage.evaluate(context, requirements).then(built => /* add the .fabr files */);
  },
});
```

Both sets of requirements are the target's own, so they are resolved together, as one rule's
are. A rule written in `.fabr` builds on the extended type's rule by
[splicing the target](/guides/rules/#splicing-the-targets-properties) into a target of the
extended type in its block.

The build verb is the `BUILD_OPERATION` property: `fabr test x` builds `x` with
`BUILD_OPERATION=test`, so `<BUILD_OPERATION=test>` makes a rule that runs under `fabr test`
only. Configuration propagates to what a target depends on, so a rule for one operation
reads its dependencies under `build` explicitly (`context.getFileProperty("deps", BUILD_OVERRIDE)`).

### Requirements

`requirements(context)` reads the properties and globals that name the target's file
dependencies (files, packages and other targets), and returns a `ResolutionSpec`, or a
`Computable` of one where it depends on a value read first: `{ build?, run?, permissive?, result?
}`, where `build` and `run` each map a name of the rule's choosing to the sources read. Nothing is
fetched or built here: fabr resolves the requirements, and they are given content for the rule's
evaluation. Use a `Map` where the names come from the user.

**Building with and running with.** `build` holds what the target is built with: what it compiles
against, and what it passes on. `run` holds what it installs or runs. Each is resolved as a
collection of its own, for that operation, because an ecosystem may answer them differently: a
Maven package requires its `compile`-scoped dependencies to compile against, and its `runtime`
scope as well to run (Gradle's `java-api` and `java-runtime` variants). A rule that does both
reads the property once for each, under two names, since a name is one requirement whichever
collection holds it:

```ts
requirements(context) {
  return {
    build: { srcs: context.getFileProperty("srcs"), deps: context.getPackageProperty("deps") },
    run: { classpath: context.getPackageProperty("deps") },
  };
},
```

The evaluation receives both collections' requirements by name. The two are resolved apart, so
where a dependency only one of them reaches raises a version, the other may select a different one,
as Gradle's compile and runtime classpaths may.

Only `FILES` and `PACKAGES` properties are requirements. A string, map or command property has
nothing to resolve: it has one form, its value, which the evaluation reads directly from `context`
(`getString`, `getProperty`, `getMap`). The types enforce this: a value read that way does not
type-check as a requirement.

How a property is read says what its sources are for:

| Read with | What a target named there is | What a registry package (`@npm:foo:1.0.0`) is |
|---|---|---|
| `getFileProperty(name)` | Built, and its files used | That package's own files, nothing it requires |
| `getPackageProperty(name)` | The package it builds | A requirement, resolved with the target's others: one version of each package |
| `getLooseFileProperty(name)`, from `evaluate` | Left out, unbuilt | Left out |

`getLooseFileProperty` gives only the files in hand, and is for `evaluate`: what a rule reads
there is no requirement of its target, so a target the property names may itself depend on this
one. `js_package` reads `test_deps` this way, which lets a test-support package depend on the
package it supports.

A `targetdef` declares each property `FILES` or `PACKAGES`. `getPackageProperty` reads only a
`PACKAGES` property; `getFileProperty` reads either.

Six requirement names say what the target passes on to whatever depends on it:

- **`dependencies`**: what a package the target builds requires.
- **`provided`**: the same, for requirements the consumer supplies (npm's peer dependencies).
- **`optional_provided`**: as `provided`, for requirements the consumer may leave out (npm's
  optional peer dependencies). The target is built against them, and each is bound only to what
  the consumer supplies or already has installed.
- **`runtime`**: as `dependencies`, for requirements passed on to what a consumer runs with alone
  (its `run` collection): Maven's `runtime` scope, Gradle's `runtimeOnly`.
- **`compile`**: as `dependencies`, for requirements passed on to what a consumer compiles against
  alone (its `build` collection): Gradle's `compileOnlyApi`.
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
`"expected"` or `"optional"`. So do the edges from `runtime` and `compile`, which its `usedFor`
map names, `"run"` or `"build"`: a consumer's collection for the other leaves the edge out.

Everything a target depends on belongs in `requirements`, except the **tools** it runs, which are
read in the evaluation ([below](#running-a-tool)). Whatever the evaluation reads for itself is not part of
the resolved graph: `fabr deps` does not show it, and a dependency cycle through it is only found
when the target is built.

**Version conflicts.** The packages a target requires are resolved together, and where one
package would be used at two versions that are not both allowed (with a `?`), the requirements are
in conflict. The conflicts are found when the requirements are resolved, and a target fails when
it first materializes them. A rule that assembles a program to be run rather than linked against
sets `permissive`, and is not refused for them:

```ts
requirements(context) {
  return { run: { deps: context.getPackageProperty("deps") }, permissive: true };
},
```

**What the target builds.** Resolution places a target among what requires it before it is built,
so it needs to know what the target will be: a package, and under what name, or plain files. A
rule that knows says so with `result`, beside its requirements:

```ts
requirements(context) {
  return {
    build: { dependencies: context.getPackageProperty("deps"), srcs: context.getFileProperty("srcs") },
    result: { package: context.name, format: NPM_FORMAT },
  };
},
```

`result` is `{ package, format?, version? }` for a package (the format being the package format
of the registry the package belongs with, such as `NPM_FORMAT`), or `"files"`. A target declared to
build files claims no name among packages, so several can be required together; a package's
node takes the declared name and version. What the rule builds is checked against it, and a rule
that declares one thing and builds another fails with `'<target>' builds …, though its rule
declares …`. A rule that declares nothing is placed as a package named as its target, and what it
builds is found out when it is built.

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

Write the evaluation inline in the object passed to `defineRule`, as a method or an arrow
function. TypeScript gives the requirement names their types only once it has typed
`requirements`, so a separately declared function passed as `evaluateMaterialized` sees no names
at all.

#### Running a tool

A rule never runs a program itself. It reads the tool as a runnable with
`context.getGlobalRunnable(name)` (or `getRunnableProperty` for a tool named by a property), and
returns a `BuildAction` that runs it:

- `createExecAction(files, argv, outputs?, label?)` stages `files` in an empty working directory,
  runs `argv` there with an empty environment, and collects the files matching `outputs` as the
  result. A non-zero exit fails the target, with the program's output in the error.
- `new BuildAction(step, inputs, config, options?)` runs a step of your own,
  `{ id, version, run(action, ctx, report) }`, where `createExecAction` will not do. `options`
  gives the action a `label`, and a `reshape` function that turns the step's output into what the
  target is (a package with its name, say), applied whether the step ran or its result came from
  the cache.

An action's result is cached under its step's `id` and `version` and a digest of its `inputs`
(file content) and `config` (arguments, patterns, generated configuration). Bump `version` when
the step's behaviour changes.

#### Composing targets

`context.subTarget(type, inputs, { label, constraints })` builds an anonymous target of `type`
from the `inputs` you hand it, through the same rule a declared target of that type uses, and
returns its output for you to use in your own action or result. A rule reads a sub-target's
inputs with the same property readers it uses for a declared target. Actions do not nest:
composition is always through sub-targets.

### Describe

`describe(context, requirements)` describes the target as the rule would build it under the
configuration it is asked in, for an editor or another tool that needs to know what the build would
do, without building it. [`fabr build-server`](/reference/command-line/#build-server) serves
each target's description over the [Build Server
Protocol](https://build-server-protocol.github.io/docs/specification). It receives the requirements
as `evaluateResolved` does, and returns the description's files (a `FileSet`, or a `BuildAction`
producing one, or a `Computable` of either):

- `describe.json`, a BSP `BuildTarget`, its `SourceItem`s and the directories they are named from,
  made with `describeTarget(context, requirements.resolved, options)` and
  `descriptionFile(description)` from `@fabr-build/core`: `options` names the target's sources
  and gives its `tags`, `languageIds`, its language payload as `dataKind` and `data`, and the
  answers to the language requests BSP makes of it (`javacOptions`);
- whatever files the payload and answers name, at the paths they name them by.

A description names a project file as `./<path from the project root>` and a file of the
description by its path within it; the server makes both absolute. The Java plugin, for instance,
lays the classpath's jars out in the description and names them in `javacOptions`.

`requirements.describeAll()` gives every requirement content as a description needs it: a target
whose rule describes it is given its description (a `DescribedPackage` where it builds a
package), and everything else its content. A package's description holds, beside the description
itself, the files the package ships as they are, at their paths in the package, so that a step
reading a dependency's files (Sass loading a partial) finds them in its description. So describing
a target builds none of the targets it requires, only fetching what they depend on.
`context.describeSubTarget(type, inputs, options)` is `subTarget`'s counterpart, describing an
anonymous target through its rule's `describe`.

A rule with no `describe` leaves its targets undescribed under that operation. A `describe` that
returns no `describe.json`, such as an empty `FileSet`, describes nothing for that target, and the
server serves no target for it: the JavaScript test rules do this for a package that declares no
`tests`, so that it has no test run in the editor.

## Repository types

A repository answers references such as `@npm:semver:7.6.0`. A repository type is declared in a
`.fabr` file, naming the module that implements it, and a build file declares a repository of that
type (`npm_repository @npm { … }`):

```
repository npm_repository = @fabr-build/js:NPMRepository;
```

The implementation is the module's default export, a `provider` function. It is called once per
build configuration that uses the repository, with the declaration's `TargetContext`: its property
readers, `memoize(tag, key, fn)` to cache the result of a resolution, `fetch(cacheKey, tag,
request, report, options?)` to download through fabr's cache, and `runTask` to report progress. It
returns a `Repository`, a plain `FileSource` for a repository that only holds files, or a
`Namespace` whose names are made when first asked for (`get(name)`), each a repository, a further
namespace or files: an `aws_account` is one, its services each a repository.

A namespace can hold repositories of types other plugins define, without importing them:
`context.makeRepository(type, { name, url, credential })` makes one as a declaration of that type
would be, and `context.hasRepositoryType(type)` says whether a plugin in use defines `type`. The
provider of the type made is then called with the `url` and `credential` as its second and third
arguments: the `url` is used where the repository's properties give none, and the `credential`
ahead of any its ecosystem would find for itself.

A `Repository` makes references from what is written (`getRepositoryRef`, and
`getRepositoryPublishRef` for [`sync`](/reference/js/publishing/)). Each reference carries the
interface that answers it:

| Interface | Answers | Example |
|---|---|---|
| `RepositoryReader` | A registry. The references to it that a target makes are resolved together, one version of each package. It supplies each version's requirements (`getRequirements`), the package (`fetch`), a package's own files (`fetchFiles`), and states the operation of the configuration it was made in (`operation`), which decides whether a reference to it is answered with the package, its files alone, or the program it is. | `npm_repository` |
| `RepositoryLookup` | Each reference on its own (`resolve`, optionally `resolveFiles`). | `fabr_home` |
| `RepositoryCollection` | A set the repository resolved itself (`member`). | `catalog` |
| `RepositoryWriter` | A destination [`sync`](/reference/js/publishing/) publishes to: it packages each member's content (`package`) and uploads it (`publish`). | `npm_repository`, an S3 bucket |

A repository named on its own, or with a scope of its names (`@fabr-home:@fabr-build`), is
not a package: `getRepositoryRef` may return a `PartialRepositoryRef` for a scope, from which a name
projected into it (`@fabr-build/js-tools`) goes on. A repository that can list a name's children
implements `children`, which is what `fabr ls` shows: npm lists a package's versions, S3 a
bucket's objects. This is what lets a property of a group's name
answer every name in the group; see
[Properties that stand in for a group of names](/reference/syntax/#properties-that-stand-in-for-a-group-of-names).

## Not supported

- A rule or repository declaration names an implementation of fabr's core or of a plugin the
  project uses, not of any other package.
- A plugin can build on `@fabr-build/core` only, not on another plugin's exports, since that would
  load a second copy of the other plugin.

## Known issues

- The interface is the whole of `@fabr-build/core`. It is not yet versioned or stable.
