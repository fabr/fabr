# Fabr for VS Code

Shows VS Code's TypeScript, and its Java support, a [fabr](https://fabr.build/) project as fabr
builds it. Fabr builds from its build files, not from a `node_modules` directory or a
`tsconfig.json`, so without this extension the editor finds nothing useful, or a different project
of the same name above it.

- Every import resolves to what the build resolves it to: a dependency to the version the build
  selected, a package the project builds to its source, an import the build would refuse to
  nothing.
- A package's tests are checked as its test run compiles them, with their test dependencies.
- Go-to-definition, completions and auto-import work across the project's packages, and an
  unsaved edit in one package shows at once in the packages that import it.
- A TypeScript file's auto-import offers only what its own target can import.
- With Red Hat's Java extension installed, each `jar_package` is a Java project of the editor's:
  its sources, the jars the build compiles them against, and its tests with their own test
  dependencies.

A project that is not fabr's, around or beside a fabr project, keeps VS Code's ordinary behaviour.

## Requirements

A workspace holding a `PROJECT.fabr`, trusted, and fabr installed: in the project's
`node_modules`, on the `PATH`, or named by the `fabr.command` setting. The extension runs that
fabr's `fabr build-server` to describe the project.

## Settings

- `fabr.command`: the command running the project's fabr, as a list of arguments; a leading `./`
  is the workspace folder. Empty (the default): the fabr installed in the project's
  `node_modules`, else `fabr` on the `PATH`.

To start VS Code's TypeScript server through fabr's wrapper, the extension sets the user settings
`js/ts.tsdk.path` and `typescript.tsdk` to a copy of VS Code's own TypeScript under
`~/.fabr/vscode/tsdk`. The wrapper changes nothing outside a fabr project. Remove the two settings
to undo it.

## Limitations

- The editor's TypeScript is VS Code's own, not the version the build compiles with; where the two
  differ, the editor may report an error the build does not, or miss one.
- TypeScript, JavaScript and Java only: stylesheets are left to VS Code's own support.

See [VS Code support](https://fabr.build/guides/vscode/) in fabr's documentation.
