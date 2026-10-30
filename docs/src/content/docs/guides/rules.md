---
title: Writing your own rules
description: Write a rule in a .fabr file, out of targets you could declare yourself, to say how targets of a type are built under an operation.
---

Every target has a **target type**, declared with
[`targetdef`](/reference/syntax/#targetdef-declarations), and a **rule** says how targets of one
type are built under one operation: how a `js_package` is built, or how it is tested. The standard
rules come with fabr and its plugins, written in code. You can also write a rule in your own
`.fabr` files, out of targets you could declare yourself: run a tool over a target's sources,
generate a file from its properties, or build it with another target's rule. The target type can
be one a plugin provides or one you declare, and the operation one it already has or a new one.

You don't call a rule: fabr applies it to every target of its type whose operation and guard it
matches, as it does the standard rules, so each target gets its own copy of the rule's targets,
built from that target's properties.

| To… | See |
|---|---|
| build a target in one step | [A rule of one step](#a-rule-of-one-step) |
| chain several steps | [A rule of several steps](#a-rule-of-several-steps) |
| add an operation, such as `lint` | [A rule for another operation](#a-rule-for-another-operation) |
| read the target's own properties | [Reading the target's properties](#reading-the-targets-properties) |
| choose what the target is | [What the target is](#what-the-target-is) |
| build a step under another operation or configuration | [Configuration](#configuration) |
| replace a plugin's rule | [Choosing between rules](#choosing-between-rules) |
| fix an error | [Troubleshooting](#troubleshooting) |

## A rule of one step

This rule says how a `version_module` is built: by generating a TypeScript module from the
target's `version`.

```
script stamp { entry = tools:stamp.sh; }

targetdef version_module {
    # The version to record.
    version = REQUIRED STRING;
}

rule version_module v<BUILD_OPERATION=build> = generate gen {
    run = stamp ${v.version} > version.ts;
}

version_module app_version { version = 1.4.0; }

js_package app { srcs = src:**/*.ts app_version:version.ts; }
```

- `rule version_module v<BUILD_OPERATION=build>` says the rule builds a `version_module` under the
  `build` operation, and calls the target it builds `v`.
- `= generate gen { … }` says the target is built as the
  [`generate`](/reference/standard-rules/#generate) written after the `=`, one whose properties are
  written as any target's are. `${v.version}` is the `version` of whichever `version_module` is
  being built.

`tools/stamp.sh` prints `export const VERSION = "$1";`, so `app` compiles a `version.ts` holding
`1.4.0`.

## A rule of several steps

A rule can be made of several targets, declared in a block after the `=`, with the name of the one
the target is written before it. This rule generates a TypeScript client from an API description
and compiles it, with any hand-written sources, into a package:

```
script gen_client { entry = tools:gen-client.sh; }

targetdef api_client {
    # The API description the client is generated from.
    spec = REQUIRED FILES;
    # Hand-written sources compiled with the generated client.
    srcs = FILES;
    # Packages the client's code imports.
    deps = PACKAGES;
}

rule api_client c<BUILD_OPERATION=build> = client {
    generate code {
        srcs = c.spec;
        run = gen_client *.json > index.ts;
    }
    sources = code:index.ts c.srcs;
    js_package client {
        srcs = sources;
        deps = c.deps;
    }
}

api_client weather {
    spec = api:weather.json;
    srcs = api:retry.ts;
}

js_package app {
    srcs = src:**/*.ts;
    deps = weather;
}
```

- `code` runs the generator over the target's `spec`.
- `sources` is a property of the block: the file `code` wrote, named as `code:index.ts` as any
  reference names a file another target built, and the target's own `srcs`. A property of the
  block is written as a global is, and read the same way.
- `client` compiles `sources` against the target's `deps`.
- `= client` makes each `api_client` the package `client` builds. That package is named after the
  `api_client` (`weather`), so `app`'s sources import it as `import { … } from "weather"`.

:::note[Packages are named after the target]
Every target in a rule's block is built under the name of the target the rule is building, so a
package one of them builds is named after that target: `weather` here, not `client`. So is
anything else its rule names after its target, such as a jar's file name. Two targets in one block
that both build packages therefore build two packages of the same name, which can't be used
together as packages.

To give the result another package name, rename it on the result: `= client -> ${c}-api { … }`
makes each `api_client` a package named after it with `-api` added, so `weather` is used as
`"weather-api"`. A rename
changes only the name the package is used under, not the files the step built from the target's
name: the package's own `package.json` still says `"name": "weather"`.
:::

The one-step rule above is the short form of this: `= generate gen { … }` means
`= gen { generate gen { … } }`.

`fabr build app` builds the client first, reporting its steps as `code weather` and
`Compiling weather`.

## A rule for another operation

A rule can also give a target type an operation of its own. This one gives every `js_package` a
`lint` operation that runs a checker over the package's sources:

```
script checker { entry = tools:check.sh; }

rule js_package pkg<BUILD_OPERATION=lint> = report<BUILD_OPERATION=build> {
    generate report {
        srcs = pkg.srcs;
        run = checker **/*.ts > lint.txt;
    }
}

js_package app { srcs = src:**/*.ts; }
```

The targets in a block are built under the rule's own operation, `lint` here, and `generate` has a
rule for `build` and none for `lint`. So `report<BUILD_OPERATION=build>` says the linted target is
`report`, built under `build`; [Configuration](#configuration) has the details. This is also why
the rule can't be written in the short form.

The operation's name is a command, as `build` and `test` are, and a `<…>` constraint asks for the
operation where another command is given, quoted for the shell:

```sh
fabr lint app
fabr cat 'app<BUILD_OPERATION=lint>:lint.txt'
```

Every `js_package` now has its own report, built from its own sources, and
`fabr list-targetdefs` lists `lint` among the operations of `js_package`.

## Reading the target's properties

Inside the block, the name after the rule's type (`pkg`, `v`) stands for the target being built.
Its properties are read through it:

| Written in the block | Means |
|---|---|
| `srcs = pkg.srcs;` | The target's `srcs`. The property it is written in decides how it is read: as files, as packages, or as a string. |
| `srcs = pkg.srcs extra.ts;` | The target's values, then the block's own. |
| `srcs = pkg.srcs:**/*.ts;` | Only the files the target's `srcs` names that match `**/*.ts`. |
| `run = stamp ${v.version} > version.ts;` | The target's string value, substituted as any `${…}` is. |
| `run = stamp ${v} > version.ts;` | The target's name (`app_version`). |
| `defines = pkg.defines;` | The target's `MAP` property, as one map property naming another is read. A `COMMAND` property is read the same way. |
| `srcs = pkg.srcs<BUILD_TYPE=release>;` | The target's `srcs` as it declares them for that configuration, with what they name built in it. |
| `deps = pkg<BUILD_OPERATION=build>;` | The target itself, built under another operation. |

A value the target wrote means what it means where the target is declared: a relative path is
relative to the target's own file, and a name is the name in that file, whatever the block declares.
A guarded property of the target (`srcs<TARGET=*-linux-*> = …`) is chosen by the configuration the
target is being built in.

A name in the block that starts with the parameter and a `.` always reads the parameter's property,
so a file named that way is written with a `./` (`./pkg.json`). Where the rule has a type, every
property read this way must be one the type declares, and fabr reports one that isn't when it reads
your files.

## What the target is

The reference between the `=` and the block says what the target is:

- **One whole target** (`report`, `report<BUILD_OPERATION=build>`) makes the target that one: a
  package if it builds a package, and files otherwise. What depends on the target gets what that
  one builds, and what it requires.
- **Anything else** makes the target the files it names: a selection such as `report:lint.txt`, or
  a property of the block listing several targets (`contents = classes:** docs:**;` with
  `= contents { … }`).

The block's targets and properties belong to the rule: they are looked up before your files'
names, and nothing outside the rule can name them. A block declares only targets and properties,
guarded ones included.

A target in the block is built under the name of the target the rule is building, as that target's
own work, so whatever its rule names after its target is named after the target being built (see
[Packages are named after the target](#a-rule-of-several-steps)). The block's name for a target is
how the block refers to it, and how fabr's progress output and errors name its work: `Building
report for app`, `Compiling report for app failed`.

Since every target in the block is a package of the target's name, and a property read as packages
takes one package of each name, a target of the block can list only one other target of the block
as a package (or the target itself under other constraints, `pkg<BUILD_OPERATION=build>`): two
fail with `'<name>' is required here as two different packages`. Give one of them a name of its
own with `->` (`deps = api -> app-api impl;`), or, where you want their files rather than the
packages, name them for their files (`classes:classes/**`).

## Package versions

The result, and every target of the block it reaches through what each target requires, resolve
their packages together, as the parts of one target do. A target is reached when another one
names it among what it requires, for its package (`deps = api`) or only for its files
(`resources = classes:classes/**`). So in a war rule, the `deps` that `classes` compiles against
and the jars `libs` lays into `WEB-INF/lib` are the same versions, and a package any reached
target adds beside `w.deps` raises a version for all of them.

A target of the block that the result doesn't reach this way, such as a program another target
runs as a command, has its versions chosen for it alone, as any tool's are. A target in the block whose own
type is built by a rule written in `.fabr` is reached like any other, and the targets of its rule's
block join the same resolution.

Versions that conflict are an error for a target in the block that uses them together, unless its
type collects its packages permissively, as `java_program` does.

## What `fabr deps` shows

`fabr deps` on a target a rule builds shows that resolution from the target's side: a section for
each of the target's own properties the block reads (`deps`, `provided_deps`), holding what it
resolved to, and a section `required by <type> rule` for what the block adds itself. The block's
own targets aren't shown; what they pass on is in those sections. Where the result is a target
outside the block, such as the target itself under another operation, it's shown under the rule's
section, as what the target is made from.

## Configuration

A target in the block is built in the configuration the rule applies in, as any target a reference
names is: under the rule's own operation, and with the same settings. A rule for an operation other
than `build` must therefore ask for the operation its steps have a rule for, as the lint rule does
with `report<BUILD_OPERATION=build>`. The short form has nowhere to write that, so it suits a rule
whose operation its one target's type has a rule for, such as a `build` rule.

A `<…>` constraint on a reference in the block applies to that target alone: the lint rule's `report`
is built under `build` while the `js_package` it reports on is still being linted.

## Choosing between rules

A rule written in `.fabr` is chosen as any rule is. Each rule's guard (the `<…>` after its
parameter) says where it applies, and of the rules that apply to a target, the one with the most
guard keys builds it. Two equally specific rules are an error.

To build some of a plugin's targets your own way, give your rule a guard with more keys than the
plugin's rule, such as a property of the target:

```
rule js_package pkg<BUILD_OPERATION=build, pkg.flavour=legacy> = … { … }
```

A rule with the same guard as a plugin's is an error rather than a replacement.

## Troubleshooting

**`Cannot perform 'lint' on 'report': no rule matches target type 'generate'`**

A target in the rule's block is built under the rule's own operation, and its type has no rule for
that operation. Ask for one it has a rule for on the result: write
`= report<BUILD_OPERATION=build> { generate report { … } }` instead of the short form
`= generate report { … }`. The `help:` line's `fabr build report` doesn't apply: `report` is a name
only the rule can use.

**`'pkg.sources' reads a property 'js_package' does not declare`**

The block reads a property of the target that its type doesn't have. Check the property's name
against `fabr list-targetdefs`.

**`'rule …' is applied inside its own application`**

A target the rule's block declares, or one built from it, is of a type and configuration the same
rule matches, so the rule would be applied to it again without end. Give that target a type or a
configuration the rule doesn't match, or narrow the rule's guard.

**`'g.whom' has no value`**

A `${…}` in the block reads a property the target doesn't set, or that its type doesn't have. Set
it on the target, or give it a default in the targetdef.
