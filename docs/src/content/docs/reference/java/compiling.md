---
title: Compiling
description: How fabr compiles Java — the JDK it uses, the Java release it compiles for, annotation processors and modules.
---

Fabr compiles a target's Java sources with `javac` from a JDK it downloads, for the Java release
you choose, against the jars its dependencies resolve to. This page covers what replaces
`maven-compiler-plugin`'s and Gradle's `java { }` configuration.

## Coming from Maven or Gradle

| With Maven or Gradle | In fabr |
|---|---|
| `maven.compiler.release` / `options.release` | [`JVM_TARGET`](#the-java-release), or a `java<release>` flag on the target. |
| A Maven toolchain / Gradle `toolchain { languageVersion }` | [`JDK`](#the-jdk). |
| `<annotationProcessorPaths>` / `annotationProcessor` | [`processors`](#annotation-processors). |
| `module-info.java` with the module path | Recognised, as Gradle does it; see [Modules](#modules). |
| `project.build.sourceEncoding` | Always UTF-8. |
| `<compilerArgs>` / `options.compilerArgs` | Not supported; see [Known issues](#known-issues). |

## What the compiler is given

For every compile fabr runs:

```sh
javac --release <N> -encoding UTF-8 -proc:none -implicit:none \
      -d classes -classpath <the jars> <the sources>
```

with `-processorpath <the processors>` in place of `-proc:none` where the target has
[annotation processors](#annotation-processors), and `--module-path` where it is a
[module](#modules). Only `.java` files may be among the sources; anything else is the error
`java_compile compiles .java sources only, and was given …`. Put other files in `resources`.

The classpath is the jars of the target's dependencies and everything they require, nearest
first, in the order they are declared.

## The Java release

`JVM_TARGET` is the Java release the compiled classes run on, written `jvm<release>`, and is
given to `javac` as `--release`. It is `jvm21` unless you set it:

```
JVM_TARGET = jvm17;
```

`--release` both sets the class-file version and compiles against that release's API, so code
built for `jvm17` can't call a method Java 21 added.

When a target's sources are written for an earlier release, say so with a flag in its `deps`:
`java8`, `java11`, `java17`, `java21` or `java25`. The target is then compiled for that release,
whatever `JVM_TARGET` says, so a library can keep supporting Java 11 while the rest of the project
moves on:

```
jar_package compat {
  srcs = src/main/java:**/*.java;
  deps = java11 @mvn:org.slf4j:slf4j-api:1.7.36;
}
```

A flag later than `JVM_TARGET` is an error, since the classes couldn't run:
`the sources are written for Java 21, which a JVM_TARGET of jvm17 cannot run`.

## The JDK

`JDK` names the [Eclipse Temurin](https://adoptium.net/) release the Java tools come from, which
fabr downloads from the Adoptium API for your platform and keeps in its cache. It is
`@jdk:21.0.12.1+1` unless you set it:

```
JDK = @jdk:17.0.13+11;
```

A release is named as Adoptium names it, without its `jdk-` prefix: `@jdk:17.0.13+11`, or
`@jdk:8u302-b08` for Java 8. `fabr ls @jdk` lists the releases published for your platform, newest
first. Fabr fetches the build for macOS, Linux (glibc or musl) or Windows, on x64 or arm64, where
Adoptium publishes one, and checks the archive's SHA-256.

Each tool is a setting of its own, taken from `JDK` by default: `JAVAC` is the compiler, `JAVA` the
runtime everything is run on (`fabr run`, tests, and Java tools in a build), and `JAVADOC` the
[javadoc](/reference/java/packaging/#javadoc-and-sources) generator. Set one to take it from another
release, as in `JAVA = @jdk:17.0.13+11:java;` to run on Java 17 what a Java 21 compiler built.

The JDK on your machine is never used, so `JAVA_HOME` makes no difference. To use a mirror of the
Adoptium API:

```
jdk_distribution @jdk { url = "https://adoptium.example.com"; }
```

## Annotation processors

`processors` names the annotation processors `javac` runs. They are resolved apart from the
sources' own dependencies, so a processor's own dependencies never reach your classpath. A
processor whose annotations your code uses, such as Lombok, also goes in `compile_deps`, which
puts it on the compile classpath without passing it on:

```
jar_package app {
  srcs = src/main/java:**/*.java;
  compile_deps = @mvn:org.projectlombok:lombok:1.18.34;
  processors = @mvn:org.projectlombok:lombok:1.18.34;
}
```

A target with no `processors` is compiled with `-proc:none`, so a processor that happens to be on
the classpath never runs. That matches what `javac` does by default from JDK 23, and differs from
earlier JDKs, which ran any processor they found.

## Modules

Sources that include a `module-info.java` are a named module. Their dependencies are placed as
[Gradle places them](https://docs.gradle.org/current/userguide/java_library_plugin.html#sec:java_library_modular):
a jar that is a module, because it holds a `module-info.class` or its manifest names an
`Automatic-Module-Name`, goes on the module path, and any other jar on the classpath. A target
without a `module-info.java` puts every jar on the classpath.

`fabr run` runs a modular program on the module path too; see
[Running programs](/reference/java/running/#modules).

## Known issues

- There is no way to pass further options to `javac`: `-parameters` (which Spring uses to bind
  parameters by name), `-Xlint`, `-Werror`, `-g` for local variable names in the debugger.
- The source encoding is always UTF-8.
