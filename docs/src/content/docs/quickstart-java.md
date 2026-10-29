---
title: Quick start (Java)
description: Build, test, and run a Java library or program with fabr.
---

This guide takes you from an empty directory to a Java jar that is compiled, tested with JUnit 5
and runnable. The whole project is a `PROJECT.fabr` file and your sources: there is no
`pom.xml`, `build.gradle` or wrapper script to write, and you don't need a JDK installed, because
fabr downloads one.

## Coming from Maven or Gradle

| With Maven or Gradle | In fabr |
|---|---|
| `pom.xml` / `build.gradle` | A `jar_package` target in `PROJECT.fabr`. |
| `src/main/java`, `src/main/resources` | Wherever you like: the target's `srcs` and `resources` say where. The usual layout works unchanged. |
| `<dependencies>` / `implementation` | The target's `deps`, written `@mvn:<group>:<artifact>:<version>`. |
| `<scope>test</scope>` / `testImplementation` | `test_deps`. |
| `<scope>provided</scope>` / `compileOnly` | `provided_deps`, or `compile_deps` for a jar nothing needs at run time; see [Dependencies](/reference/java/dependencies/). |
| `maven.compiler.release` / `toolchain` | `JVM_TARGET`, and the `JAVAC`/`JAVA` settings; see [Compiling](/reference/java/compiling/). |
| `mvn package` / `gradle jar` | `fabr build`. |
| `mvn test` / `gradle test` | `fabr test`. |
| `mvn exec:java` / `gradle run` | `fabr run`. |
| `war`, `ear` packaging | The `war_package` and `ear_package` targets; see [Packaging](/reference/java/packaging/). |

## Install

Fabr needs Node.js 22.19 or later to run. Install the `fabr` command and the Java plugin together,
globally:

```sh
npm install -g @fabr-build/cli @fabr-build/java
```

The JDK isn't part of the install. On the first build fabr downloads an Eclipse Temurin JDK, 21
unless you choose another, and compiles, runs and tests with it, so the Java on your machine
doesn't affect what is built; see [The JDK](/reference/java/compiling/#the-jdk).

## A minimal project

Create `PROJECT.fabr` in an empty directory:

```
plugin @fabr-build/java;

jar_package greeter {
  srcs = src/main/java:**/*.java;
  deps = @mvn:org.apache.commons:commons-text:1.11.0;
  main_class = com.example.Greeter;
}
```

and a source file, `src/main/java/com/example/Greeter.java`:

```java
package com.example;

import org.apache.commons.text.WordUtils;

public final class Greeter {
    public static String greet(String name) {
        return "Hello, " + WordUtils.capitalize(name) + "!";
    }

    public static void main(String[] args) {
        System.out.println(greet(args.length > 0 ? args[0] : "world"));
    }
}
```

Then build it:

```sh
fabr build greeter
```

Fabr downloads the JDK and `commons-text` (with `commons-lang3`, which it requires), compiles the
source and packs `greeter.jar`, whose manifest names `com.example.Greeter` as its `Main-Class`.
The jar isn't written into your project; it is kept in fabr's cache, and you look at it with
`fabr`:

```sh
fabr ls greeter               # list the files the target produces: greeter.jar
fabr cp greeter ./out         # copy them to ./out/greeter/
```

`srcs = src/main/java:**/*.java` means "the `.java` files under `src/main/java`, named without that
prefix", so `com/example/Greeter.java` compiles to `com/example/Greeter.class` in the jar.

## Running it

```sh
fabr run greeter ada
```

prints `Hello, Ada!`. `fabr run` starts the `main_class` with the jar and everything it requires on
the classpath, in your current directory and with your terminal. Everything after the target name
is passed to the program; options for fabr itself go before the target.

## Testing

Add `tests` naming the test sources, and `test_deps` for what only the tests need. Fabr runs tests
on the [JUnit Platform](https://junit.org/junit5/docs/current/user-guide/#launcher-api), and the
platform's launcher is one of your `test_deps`, of the same JUnit release as the engine:

```
jar_package greeter {
  srcs = src/main/java:**/*.java;
  deps = @mvn:org.apache.commons:commons-text:1.11.0;
  main_class = com.example.Greeter;
  tests = src/test/java:**/*.java;
  test_deps = @mvn:org.junit:junit-bom:5.11.4
              @mvn:org.junit.jupiter:junit-jupiter
              @mvn:org.junit.platform:junit-platform-launcher;
}
```

`junit-bom` is JUnit's bill of materials: it gives the versions of the other two, so they are
written without one. A test, `src/test/java/com/example/GreeterTest.java`:

```java
package com.example;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class GreeterTest {
    @Test
    void greetsByName() {
        assertEquals("Hello, Ada!", Greeter.greet("ada"));
    }
}
```

```sh
fabr test greeter
```

prints `greeter: 1 test passed`, and a failing test fails the build. A passing run is cached, so
running `fabr test` again without changes reports the result without running the tests again.
[Testing](/reference/java/testing/) covers other engines and what each failure means.

## The commands you'll use

| Command | What it does |
|---|---|
| `fabr build <target>` | Build the target. |
| `fabr test <target>` | Compile and run the target's tests. |
| `fabr run <target> [args…]` | Build a program and run it. |
| `fabr doc <target>` | Generate a jar's javadoc. |
| `fabr ls <reference>` | List the files a target produces. |
| `fabr cat <reference>` | Print them. |
| `fabr cp <reference…> <dir>` | Copy them into a directory. |
| `fabr deps <target>` | Show the dependency versions the target resolves to. |

Two options work with most of them:

- `-D<NAME>=<VALUE>` changes a setting for one run: `fabr build -DJVM_TARGET=jvm17 greeter`.
- `-w` keeps fabr running and rebuilds, retests or restarts as your sources change; see
  [Watch mode & dev servers](/guides/watch/).

The [command-line reference](/reference/command-line/) has the rest.

## Next steps

- [Dependencies](/reference/java/dependencies/): Maven references, how versions are chosen, BOMs
  and dependency scopes.
- [Compiling](/reference/java/compiling/): the JDK, the Java release, annotation processors and
  modules.
- [Testing](/reference/java/testing/): JUnit engines and test failures.
- [Running programs](/reference/java/running/): `java_program`, JVM arguments and Java agents.
- [Packaging](/reference/java/packaging/): the jar's manifest, wars, ears, Spring Boot executable
  jars, and layouts of your own.
- [Targets and configuration](/reference/java/targets/): every Java target and setting.
- [Projects with several packages](/guides/multi-package/): targets that depend on each other.
- [A Spring Boot server with a React front end](/examples/spring-boot-react/): a worked example
  combining a Java server and a TypeScript front end in one project.
- [Known limitations](/known-limitations/): rough edges worth knowing about up front.
