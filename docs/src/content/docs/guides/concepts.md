---
title: Conceptual model
description: The underlying concepts that drive fabr.
---


In fabr, everything (almost) is either a file set, or a property. Generally speaking, file sets are what
we're building and manipulating, and properties are parameters within which it works. All properties
can be assigned only once (single static assignment), and are resolved lazily on-demand.

## File sets

The simplest fileset is a set of real files:
 - `src` - all files recursively in the src directory
 - `src/**/*.ts` - all files recursively in the src directory that end in `.ts`
 - `./src/*.[jt]s` - all files directly in the src directory ending in `.js` or `.ts`
 - `bin/script.ts` - a single script file.

All the usual shell globbing syntax is supported, plus `**` (globstar) for recursive matching.

A build target then is just a set of derived files. For example this declaration provides a fileset
containing an NPM package:

```
js_package hello {
    srcs = index.ts;
}
```

Target names can contain alphanumeric characters plus '@', '/', '_', '-' and '.'. Targets
themselves carry only their inputs - sources and dependencies. 
The built form of the package can then be accessed exactly like a directory:

- `hello` - the package itself as a whole
- `hello/package.json` - the package.json file inside the package
- `hello/**/*.js` - All `.js` files inside the package.

:::note
target and property names are _global_ throughout the project, while source files are resolved relative to
the fabr file they're included from. In the event of a conflict between a target name and a real directory,
the target is used in preference. 

Recommended style is generally to prefix directories with `./` for clarity.
:::

Artifact repositories (eg npm) are accessed in exactly the same way. The default JS rules provide an
`@npm` repository for the central `npmjs.com` repository, which takes package and version (colon separated):
- `@npm:@parcel/watcher:2.6.0` - the package as a whole
- `@npm:picomatch:4.0.5:package.json` - extract the package.json file from the package

Now, having picked up some files, you might want to rename them as well. For the common case of stripping prefixes,
the ':' operator replaces '/', and means 'remove the left hand side from the resulting names'. For example:

- `./src/*.ts` - file set with 'src/a.ts, src/b.ts, etc'
- `./src:*.ts` - file set with `a.ts, b.ts, etc`

This doesn't affect the resolution of the files themselves, only how they appear to subsequent consumers of the
fileset - each file set behaves as a virtual filesystem, that connects an arbitrary name to the real underlying file.

:::note
Any leading ./ and ../ path segments are stripped off completely, so `../scripts/index.ts` is legal (as long as its
still inside the project tree), but will be named `scripts/index.ts`
:::

For more complex renames, there's the -> rename operator which does pattern match replacement:

- `./src/**/*.cts -> **/*.ts` - Name eg `src/foo/bar.cts` to `foo/bar.ts`
- `hello/*.js -> src/hello_vendored/*.js` - Name eg `hello/index.js` to `src/hello_vendored/index.js`
- `@npm:picomatch:4.0.5:package.json -> pico.json` - Name the package's `package.json` as `pico.json`.

## Properties

Properties live in the same namespace as targets, but must contain identifier 
characters only (ie alphanumeric, '_' and '@')
Properties come in a handful of different types, but the most common is a string:

- `VERSION=4.0;`
- `DESCRIPTION='Starter example';`
- `TEST_DEPS = @npm:chai:4.0.5 @npm:@types/chai:4.0.1;`
- `MY_DEPS = @npm:package:${VERSION};`

String values can be single or double-quoted (shell rules), and substituted with ${VAR},
where VAR is another property.

## Constraints

'Constraints' is the way in which targets can request their dependencies in a particular form. You might think of them as property overrides, but creating an _additional_ 'version' of the project, rather than replacing it. The basic
syntax is

- `hello<JS_TARGET=es6-esm,BUILD_TYPE=release>` - the hello target release built against es6-esm
- `@npm:esbuild:0.28.1<TARGET=x86_64-linux-gnu>` - The x64 esbuild build

An example might be in order:

```
JS_TARGET=es2021-commonjs;

js_package base {
    srcs = ./base:*.ts;
}

js_package second {
    srcs = ./second:*.ts;
    deps = base;
}

js_package third {
    srcs = index.ts second<JS_TARGET=es6-esm>:*.js -> second_esm/*.js;
    deps = base;
}
```

Running fabr build yields:
```
info:Building base (required by third)
info:Compiling base
info:Building base [JS_TARGET=es6-esm] (required by second < third)
info:Compiling base [JS_TARGET=es6-esm]
info:Building second [JS_TARGET=es6-esm] (required by third)
info:Compiling second [JS_TARGET=es6-esm]
info:Building third
info:Compiling third
info:Built third
```

Note that base was built twice - once in JS_TARGET=es201-commonjs and once in JS_TARGET=es6-esm, just by requesting it in that format.

Standard properties commonly used in constraints include
- `BUILD_TYPE` normally one of `debug`, `relwithdebinfo`, or `release`
- `BUILD_OPERATION` normally one of `build`, `test`, `run`, `files` - this is the main
  extension point for adding new kinds of rules for existing target types.

## Rules

Currently build rules are handwritten and live in the fabr core + plugins. There may
be multiple rules applicable to any given target - the rule to use is determined by the
most specific match against the target type and the active constraints/properties.

The rules job is essentially - transform the input into the format requested by the currently active properties/constraints.

## Packages

Now, we said that everything is a file set, and while that's true it's not quite the complete story - A package is a file set that specifically represents a particular
software ecosystems packaging unit (eg NPM for javascript). In addition to its files, it also carries a name, and direct dependencies on other packages.

This means that packages will automatically end up in the right place for the module
system to recognize them, under their burned-in name, and their dependencies will similarly be brought into the runtime. On the other hand if you extract them (eg packge:**) they'll
be treated as plain files.

Transitive resolution of external dependencies is performed at each target individually by default using the MVS algorithm. Different targets may receive a different resolution. For serious projects, you can use a catalog:

```
catalog @pkgs {
   deps = @npm:esbuild:0.28.1
}

... deps = @pkgs:esbuild
```

which both forces everything to be resolved once and for all, together, it lets you
ensure that all parts of your project are using the exact same versions.

:::note
You don't have to name catalogs and repositories with a leading '@', but we find it makes a nice convention.
:::