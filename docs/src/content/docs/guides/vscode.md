---
title: VS Code support
description: Use VS Code on a fabr project, its TypeScript and Java resolved exactly as the build resolves them.
---

Fabr builds a project from what its build files say, not from a `node_modules` directory or a
`tsconfig.json`, so an editor that reads those finds nothing useful, or worse, a different project
of the same name above it. Fabr's VS Code extension shows VS Code's TypeScript, and its Java
support where you have it installed, the project as fabr builds it:

- every import resolves to what the build resolves it to: a dependency to the version the build
  selected, a package the project builds to its source, an import the build would refuse to
  nothing;
- a package's tests are checked as its test run compiles them, with the test dependencies the
  build gives them;
- go-to-definition, completions and imports work across the project's packages, and an unsaved
  edit in one package shows in the packages that import it at once;
- a TypeScript file's auto-import offers only what its own target can import;
- no package is compiled to show it: fabr describes each target from its build files, fetching
  the packages it depends on and compiling only its stylesheets, whose declarations the editor
  needs.

A project that is not fabr's, around or beside a fabr project, keeps VS Code's ordinary behaviour.
In a pnpm or Yarn checkout that holds a fabr project in a subdirectory, the fabr project's files
are answered by fabr and the rest of the checkout by its own `node_modules` and `tsconfig.json`.

The editor sees what the build sees as long as the build compiles the project with a TypeScript
VS Code also understands; the differences are listed under [Known issues](#known-issues).

## Installing

Install [Fabr](https://marketplace.visualstudio.com/items?itemName=fabr-build.fabr) from the
Visual Studio Marketplace, from the Extensions view or on the command line:

```sh
code --install-extension fabr-build.fabr
```

A project can recommend it to everyone who opens it, in `.vscode/extensions.json`:

```json
{
  "recommendations": ["fabr-build.fabr"]
}
```

It starts in any window whose workspace holds a `PROJECT.fabr`, once the workspace is trusted:
describing a project runs its build code.

## Java

Java needs Red Hat's [Language Support for Java](https://marketplace.visualstudio.com/items?itemName=redhat.java)
extension, which fabr's extension adds to. Each `jar_package` becomes a Java project in the
editor: its sources, the jars the build compiles them against, and the packages of the project it
requires, read from their sources. Its tests are test sources of the same project, so a test
dependency such as JUnit is visible to the tests and not to the main sources. The Java release
the editor checks against is the one the build compiles for (`JVM_TARGET`, or a `java<release>`
flag).

The projects live in the Java language server's own workspace, not in yours: no `.project`,
`.classpath` or `.settings` files are written. A change to a build file, such as a dependency
added or removed, reaches the editor without reloading the window.

## Build files

The extension also knows fabr's own build files (`PROJECT.fabr`, `BUILD.fabr` and the rest):

- their syntax is highlighted;
- the Outline view and breadcrumbs list each file's targets, properties and target types;
- **Go to Definition** on a reference opens the target or property it names, on a `${NAME}` the
  property it substitutes, on a target's type its `targetdef`, and on an `include` the file;
- a reference into a catalog, such as `@pkg:@sentry/cli`, is two names: `@pkg` opens the
  catalog's declaration, and `@sentry/cli` the entry in its `deps` that provides it;
- hovering a property shows its type and documentation from its target's `targetdef`, and
  hovering a reference shows the declaration it names;
- completion offers a target type's properties in a target's body, the project's targets and
  properties after `=`, its properties after `${`, and the target types at the top level;
- a syntax error is shown as you type, and any other error in a build file, such as a property
  its target's type does not declare, once the file is saved;
- **Build** above each target builds it, and **Test**, above a target that has tests, tests it.

What a file says is read as it is typed; what its names refer to is the project as last saved.

## Building and testing

**Fabr: Build Target** and **Fabr: Test Target** in the Command Palette build or test a target
you choose, as `fabr build` and `fabr test` would, in the same fabr the editor already runs, so
what is already built is not built again. A build that fails is shown in the Problems view at
the declaration that failed.

The Testing view lists the project's targets that have tests: a `js_test`, or a package that
declares `tests`. Running one runs its tests and shows each test beneath it, passed or failed,
with a failure's message.

## How it works

The extension runs `fabr build-server` in the workspace (see the
[command line reference](/reference/command-line/#build-server)): a fabr process that watches the
project and describes each of its targets over the
[Build Server Protocol](https://build-server-protocol.github.io/), telling the extension when a
description changes. For each package and each test run, the description holds its compilation
unit: the sources it compiles, the compiler options it compiles them with, and where each package
it imports is. The same process serves the build files' language features, and builds and tests
targets when you ask.

For TypeScript, VS Code's TypeScript server is started through a small wrapper that shows it a `tsconfig.json` and
`package.json` in each unit's source directory, as if they were there, and loads a plugin that
resolves the unit's imports through fabr's own resolution. Nothing is written into the project.

For Java, the extension adds an importer to the Java language server, which asks the same fabr
process for the project's Java targets.

To start its TypeScript server through the wrapper, the extension sets the user settings
`js/ts.tsdk.path` and `typescript.tsdk` to `~/.fabr/vscode/tsdk`, which runs VS Code's own
TypeScript, once a fabr project has TypeScript or JavaScript targets. The wrapper changes nothing in
a window with no fabr project open, so every other window keeps its ordinary behaviour. Remove the
two settings to undo it.

## Settings

| Setting | Meaning |
|---|---|
| `fabr.command` | The command running the project's fabr, as a list of arguments; a leading `./` is the workspace folder. A lone `.js` file, such as an installation's `node_modules/@fabr-build/cli/bin/fabr.js`, runs on VS Code's own Node.js, so starting it needs nothing from the `PATH`. Empty (the default): the fabr installed in the project's `node_modules`, run the same way, else `fabr` on the `PATH`. |

While the project loads, the status bar shows how far it has got (`fabr: initializing 34/70
targets`), then how many targets the editor shows. A target fabr cannot describe, say because a
`generate` target it is made from fails, is counted there (`fabr: 68 targets, 2 failed`) and
reported in full in the **Fabr** output channel, which a click on the status opens. Everything
else is still shown: a package that imports the failed one keeps its own sources, and only its
imports of the failed package do not resolve. Fixing the failure brings the target back without
reloading the window.

A large project can need more memory than VS Code gives its TypeScript server by default
(3 GB): checking slows to a crawl, or the server restarts. Raise
`typescript.tsserver.maxTsServerMemory`, in megabytes, to 6144 or more.

## Not supported

- **Editors other than VS Code, and languages other than TypeScript, JavaScript, Java and fabr's
  build files.** VS Code's own Sass and CSS support resolves a package's stylesheets through
  `node_modules`.

## Known issues

- **The editor's TypeScript is VS Code's own** (TypeScript 6 in current VS Code), not the
  version the build compiles with. Where the two differ — a library type added in one, a check
  tightened in the other — the editor may report an error the build does not, or miss one.
- **While VS Code's TypeScript server loads a project**, go-to-definition doesn't follow an
  `export * from` line, or an import inside a package the build installs more than one way (for
  example, against two versions of a peer dependency). Other imports resolve as the build
  resolves them, and both work once loading finishes, with nothing to reopen.
- **Java**: annotation processors do not run in the editor, and the sources a processor would
  generate are missing; a module's sources (`module-info.java`) are checked on the classpath.
- A package whose sources are all generated (the output of a `generate` target) is not shown
  in your tree: an import of it resolves, and go-to-definition opens its generated sources from
  fabr's cache.
