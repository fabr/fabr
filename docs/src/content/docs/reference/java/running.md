---
title: Running programs
description: How fabr runs Java programs — jar_package and java_program targets, JVM arguments, Java agents, modules, and Java tools in a build.
---

`fabr run <target>` builds a Java program and runs it on `JAVA`, in your current directory and with
your terminal. Two target types can be run: a `jar_package` with a main class, and a
`java_program`, which is a program and nothing else, such as a tool you run but don't ship.

## Coming from Maven or Gradle

| With Maven or Gradle | In fabr |
|---|---|
| `mvn exec:java` / `gradle run` | `fabr run <target> [args…]`. |
| `mainClass` | `main_class`. |
| `applicationDefaultJvmArgs`, `exec.args` | A `java_program`'s `jvm_args` and `args`. |
| Running a tool published to Maven Central | A `java_program` whose `deps` name it. |
| `-javaagent:` in the JVM arguments | `agents`. |
| A plugin that runs a Java tool during the build | A `java_program` used in a [`generate`](/reference/standard-rules/#generate) command. |

## Running a jar_package

A `jar_package` runs its `main_class`, or with none, the class its jar's manifest names:

```sh
fabr run app arg1 arg2
```

Everything after the target name is passed to the program; options for fabr go before it. The
program runs with the jar and everything it requires on the classpath. A `jar_package` with no main
class can't be run: `app has no main_class, so it cannot be run`. To run the jar with arguments or
JVM options of its own, declare a [`java_program`](#java_program) with the jar in its `deps`.

## java_program

A `java_program` is a program assembled from its own `srcs`, if it has any, and its `deps`:

```
java_program migrate {
  srcs = tools/migrate:**/*.java;
  deps = @mvn:org.flywaydb:flyway-core:10.15.0;
  main_class = com.example.Migrate;
  jvm_args = -Xmx1g "-Dflyway.cleanDisabled=true";
  args = --verbose;
}
```

`jvm_args` are given to the JVM, and `args` to the program before any you give `fabr run`.

`main_class` may be left out where it is obvious: the class of the program's one source file, or,
with no sources, the `Main-Class` of its one dependency's jar. That makes a tool published as an
executable jar a program in one line:

```
java_program spotbugs {
  deps = @mvn:com.github.spotbugs:spotbugs:4.8.6;
  args = -textui;
}
```

Otherwise it is the error `<target> names no main class`.

## Java agents

`agents` lists the Java agents the program runs with: each package's jar is given the JVM as a
`-javaagent:`, and what the agent requires joins the classpath.

```
java_program app {
  deps = mylib;
  agents = @mvn:io.opentelemetry.javaagent:opentelemetry-javaagent:2.5.0;
}
```

A `jar_package` takes `agents` too, for `fabr run`.

## Modules

A program whose own classes include a `module-info.class`, or, with no classes of its own, whose
first dependency is a module, runs on the module path: the jars that are modules go on
`--module-path` with `--add-modules ALL-MODULE-PATH`, and the rest on the classpath, as they were
placed for [compiling](/reference/java/compiling/#modules).

## Java tools in a build

A `java_program` can be a command in a [`generate`](/reference/standard-rules/#generate) target, to
run a Java tool on files during the build, such as a code generator:

```
java_program openapi_gen {
  deps = @mvn:org.openapitools:openapi-generator-cli:7.6.0;
}

generate api_client {
  srcs = api:openapi.yaml;
  run = openapi_gen generate -i openapi.yaml -g java -o out;
  output = out:**;
}
```
