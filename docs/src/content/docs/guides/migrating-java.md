---
title: Migrating a Maven or Gradle project
description: Convert an existing Maven or Gradle build to fabr by hand — what each part of a pom.xml or build.gradle becomes, how modules and repositories carry over, what to write in place of plugins and tasks, and what to check afterwards.
---

There is no tool that converts a Maven or Gradle build to fabr: you write the build files yourself,
from your `pom.xml` or `build.gradle` files. A fabr build file says much less than either. Each module becomes one target, usually a `jar_package`, that names its sources and
its dependencies; the compiler, test runner, packaging and publishing that plugins configure are
built in, and the JDK is downloaded for you. What a plugin did that isn't built in becomes a target
that runs the tool.

This page walks through the conversion, a section of your build at a time. It assumes you have read
the [Java quick start](/quickstart-java/), which shows a single `jar_package` built, run and tested.

| With Maven or Gradle | In fabr |
|---|---|
| A module's `pom.xml` or `build.gradle` | A target in a `BUILD.fabr` beside the module's sources; see [Converting a module](#converting-a-module). |
| The parent POM, or the root `build.gradle` and `settings.gradle` | `PROJECT.fabr` at the root, which includes each module's build file; see [Multi-module builds](#multi-module-builds). |
| `<properties>`, `gradle.properties`, `libs.versions.toml` | Properties and catalogs in `PROJECT.fabr`; see [Shared versions](#shared-versions). |
| `<repositories>`, `repositories { }` | `maven_repository` declarations; see [Repositories and credentials](#repositories-and-credentials). |
| `<plugins>`, custom tasks | Mostly built in; otherwise a target that runs the tool; see [Plugins and tasks](#plugins-and-tasks). |
| `mvnw`, `gradlew` | The `fabr` command, installed once. |
| `target/`, `build/` | Nothing is written into your project. Outputs are kept in fabr's cache; `fabr cp <target> <dir>` copies them out. |
| `mvn install` to share modules | Not needed: a module names a sibling's target and fabr builds it. |

Convert one module first, get it building and its tests passing, then do the rest. A useful order is
the order Maven's reactor builds them in, so that each module's dependencies are already converted.
[After migrating](#after-migrating) lists what to check for each, and
[Troubleshooting](#troubleshooting) the errors you are most likely to meet.

## Converting a module

Here is a typical library module, first as Maven and Gradle write it:

```xml
<!-- core/pom.xml -->
<project>
  <parent>
    <groupId>com.acme</groupId>
    <artifactId>acme-parent</artifactId>
    <version>1.4.0</version>
  </parent>
  <artifactId>core</artifactId>

  <dependencies>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>33.2.1-jre</version>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>
```

```kotlin
// core/build.gradle.kts
plugins { `java-library` }

dependencies {
    implementation("com.google.guava:guava:33.2.1-jre")
    testImplementation(platform("org.junit:junit-bom:5.11.4"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}
```

and as fabr writes it:

```
# core/BUILD.fabr
jar_package com.acme/core {
  srcs = src/main/java:**/*.java;
  resources = src/main/resources:**;
  deps = @mvn:com.google.guava:guava:33.2.1-jre;
  tests = src/test/java:**/*.java;
  test_resources = src/test/resources:**;
  test_deps = @mvn:org.junit:junit-bom:5.11.4
              @mvn:org.junit.jupiter:junit-jupiter
              @mvn:org.junit.platform:junit-platform-launcher;
}
```

### The target

| Maven | Gradle | Target type |
|---|---|---|
| `<packaging>jar</packaging>` | `java`, `java-library` | [`jar_package`](/reference/java/packaging/#the-jar) |
| `jar`, run with `exec-maven-plugin` | `application` | A `jar_package` with a `main_class`, or a [`java_program`](/reference/java/running/#java_program) |
| `<packaging>war</packaging>` | `war` | [`war_package`](/reference/java/packaging/#wars) |
| `<packaging>ear</packaging>` | `ear` | [`ear_package`](/reference/java/packaging/#ears) |
| `<packaging>pom</packaging>`, a parent or aggregator | The root project | No target: its settings go in `PROJECT.fabr`. |

**Name the target after the module's coordinate**, `<groupId>/<artifactId>`, as in
`com.acme/core`. The name is how other modules depend on it, and the jar is named after its last
part, `core.jar`. The name doesn't have to be the coordinate, but using it keeps names unique
across the project, and keeps a target from sharing its name with a directory (see
[Naming](/guides/multi-package/#naming)).

**The version and the published coordinate** aren't part of the target. They are written where the
jar is published, in a `sync` target; see [Publishing](/reference/java/publishing/). A project
whose modules share one version usually keeps it in a property, `VERSION = 1.4.0;`, and writes
`@corp:com.acme:core:${VERSION}` there.

### Sources and resources

Each directory Maven or Gradle reads by convention is a property you write. A path ending in `:` and
a pattern means "these files, named without the directory", so the standard layout carries over
unchanged:

| Maven / Gradle directory | Property |
|---|---|
| `src/main/java` | `srcs = src/main/java:**/*.java;` |
| `src/main/resources` | `resources = src/main/resources:**;` |
| `src/test/java` | `tests = src/test/java:**/*.java;` |
| `src/test/resources` | `test_resources = src/test/resources:**;` |
| `src/main/webapp` | `webapp = src/main/webapp:**;` (a `war_package`) |
| Further source directories (`build-helper-maven-plugin`, `sourceSets`) | More entries in `srcs`: `srcs = src/main/java:**/*.java src/gen/java:**/*.java;` |

`srcs` takes only `.java` files. Fabr compiles every source as UTF-8, whatever
`project.build.sourceEncoding` said.

### Dependencies and scopes

A dependency is written `@mvn:<groupId>:<artifactId>:<version>`, and goes in the property for its
scope:

| Maven scope | Gradle configuration | fabr property |
|---|---|---|
| `compile` (the default) | `implementation`, `api` | `deps` |
| `runtime` | `runtimeOnly` | `runtime_deps` |
| `provided`, in a war | `providedCompile`, `compileOnly` in a war | `provided_deps` |
| `provided`, in a library | `compileOnly` | `compile_deps` |
| `<optional>true</optional>` | — | `optional_provided_deps` |
| — | `compileOnlyApi` | `compile_api_deps` |
| `test` | `testImplementation`, `testRuntimeOnly` | `test_deps` |
| `<annotationProcessorPaths>` | `annotationProcessor` | [`processors`](/reference/java/compiling/#annotation-processors) |

Three of these differ from what you may expect:

- **Gradle's `implementation` and `api` are both `deps`.** A module that depends on yours compiles
  against everything in your `deps`, as it does against a Maven `compile` dependency. A module that
  used a package only through yours can keep doing so, but it is clearer to declare it.
- **Maven's `provided` in a library is `compile_deps`.** Maven doesn't pass a `provided` dependency on
  to anything that uses the library, and neither does `compile_deps`. `provided_deps` does pass it on,
  as a requirement: a module or program that uses the library and doesn't supply the package itself
  installs the version you named. Keep `provided_deps` for a `war_package`, where it leaves the
  servlet API and anything else the container supplies out of `WEB-INF/lib`.
- **The JUnit Platform launcher goes in `test_deps`.** Surefire and Gradle supply one; fabr runs the
  tests with the launcher you name, which must be of the same JUnit release as the engine. See
  [Testing](/reference/java/testing/#setting-up).

A Maven `<dependency>` on another module of the same build is written by the module's target name,
`deps = com.acme/core;`; see [Depending on another module](#depending-on-another-module).

[Dependencies](/reference/java/dependencies/#which-properties-take-dependencies) says exactly
what each property puts on the compile and runtime classpaths.

### BOMs and platforms

A BOM imported in `<dependencyManagement>`, or a Gradle `platform(…)`, goes in the same property as
the packages it gives versions to, and those are written without a version:

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>com.fasterxml.jackson</groupId>
      <artifactId>jackson-bom</artifactId>
      <version>2.17.1</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>
<dependencies>
  <dependency>
    <groupId>com.fasterxml.jackson.core</groupId>
    <artifactId>jackson-databind</artifactId>
  </dependency>
</dependencies>
```

```
deps = @mvn:com.fasterxml.jackson:jackson-bom:2.17.1
       @mvn:com.fasterxml.jackson.core:jackson-databind;
```

A BOM in `deps` gives versions to `test_deps` too, since the tests are compiled and run with both;
one in `test_deps`, such as JUnit's, gives versions to the tests only. A Gradle `enforcedPlatform(…)` is the BOM written with `!` after its version. See
[BOMs](/reference/java/dependencies/#boms).

### The Java release and the JDK

| Maven / Gradle | fabr |
|---|---|
| `maven.compiler.release`, `java { toolchain { languageVersion } }`, `options.release` | `JVM_TARGET = jvm17;` in `PROJECT.fabr`. |
| A module compiled for an older release than the rest | A `java11` (or `java8`, `java17`…) flag in that target's `deps`. |
| A Maven toolchain, a Gradle toolchain's vendor, `JAVA_HOME` | `JDK`, an Eclipse Temurin release fabr downloads. |
| `-parameters` | On by default. |

See [Compiling](/reference/java/compiling/).

## Shared versions

A parent POM's `<properties>`, `gradle.properties` and `ext` blocks hold versions that several
modules use. In fabr they are properties in `PROJECT.fabr`, which every build file in the project
can read:

```
# PROJECT.fabr
SLF4J_VERSION = 2.0.13;
TEST_DEPS = @mvn:org.junit:junit-bom:5.11.4
            @mvn:org.junit.jupiter:junit-jupiter
            @mvn:org.junit.platform:junit-platform-launcher;
```

```
# app/BUILD.fabr
jar_package com.acme/app {
  srcs = src/main/java:**/*.java;
  deps = @mvn:org.slf4j:slf4j-api:${SLF4J_VERSION};
  runtime_deps = @mvn:org.slf4j:slf4j-simple:${SLF4J_VERSION};
  tests = src/test/java:**/*.java;
  test_deps = TEST_DEPS;
}
```

`${SLF4J_VERSION}` is replaced by the property's value. `test_deps = TEST_DEPS;` uses the whole list,
which is how a parent POM's shared test dependencies carry over.

A parent POM's `<dependencyManagement>` versions, and a Gradle version catalog
(`libs.versions.toml`), become a [catalog](/reference/java/dependencies/#catalogs): a named list of
dependencies, BOMs included, whose versions are chosen once and apply to every module that uses it,
and to what its members bring in:

```
# PROJECT.fabr
catalog @lib {
  deps = @mvn:com.google.guava:guava:33.2.1-jre;
}
```

```
deps = @lib:com.google.guava/guava;
```

A jar you publish can't take its dependencies from a catalog (see [Not supported](#not-supported));
give those their versions through properties.

## Multi-module builds

A Maven reactor or a Gradle multi-project build becomes one fabr project: `PROJECT.fabr` at the root
in place of the parent POM or `settings.gradle`, and a `BUILD.fabr` in each module's directory in
place of its `pom.xml` or `build.gradle`.

```
PROJECT.fabr          (was pom.xml with <modules>, or settings.gradle)
core/
  BUILD.fabr          (was core/pom.xml)
  src/main/java/
  src/test/java/
app/
  BUILD.fabr          (was app/pom.xml)
  src/main/java/
```

```
# PROJECT.fabr
plugin @fabr-build/java;

JVM_TARGET = jvm17;
VERSION = 1.4.0;
SLF4J_VERSION = 2.0.13;
TEST_DEPS = @mvn:org.junit:junit-bom:5.11.4
            @mvn:org.junit.jupiter:junit-jupiter
            @mvn:org.junit.platform:junit-platform-launcher;

include ./*/BUILD.fabr;
```

`include ./*/BUILD.fabr;` replaces the `<modules>` list or `include("core", "app")`, and picks up a
new module without an edit. For modules nested more deeply, write `./**/BUILD.fabr`, or list each
file. Paths in a build file are relative to that file, so `src/main/java` in `core/BUILD.fabr` is
`core/src/main/java`. [Projects with several packages](/guides/multi-package/) covers the layout in
full.

### Depending on another module

Name the module's target. Maven's `${project.version}` and Gradle's `project(":core")` are both
written the same way:

```xml
<dependency>
  <groupId>com.acme</groupId>
  <artifactId>core</artifactId>
  <version>${project.version}</version>
</dependency>
```

```kotlin
implementation(project(":core"))
```

```
# app/BUILD.fabr
jar_package com.acme/app {
  srcs = src/main/java:**/*.java;
  deps = com.acme/core @mvn:org.slf4j:slf4j-api:${SLF4J_VERSION};
  main_class = com.acme.app.Main;
}
```

`fabr build com.acme/app` builds `com.acme/core` first, and rebuilds it when its sources change; there
is no `install` step. When both are published by one `sync`, the dependency is written into the
app's POM with the coordinate and version the `sync` gives `com.acme/core`; see
[The generated POM](/reference/java/publishing/#the-generated-pom).

### Shared test code and integration tests

| Maven / Gradle | fabr |
|---|---|
| A `test-jar` dependency on another module, or Gradle's `java-test-fixtures` | A `jar_package` of its own for the shared test code, in the `test_deps` of the modules that use it. |
| Failsafe's `*IT` classes, or a Gradle `integrationTest` source set | A `jar_package` with only `tests` and `test_deps`, the module under test among its `test_deps`. |

```
# testing/BUILD.fabr: test helpers several modules share
jar_package com.acme/testing {
  srcs = src/main/java:**/*.java;
  deps = TEST_DEPS;
}

# app/BUILD.fabr: the app's integration tests
jar_package com.acme/app-it {
  tests = src/it/java:**/*.java;
  test_deps = TEST_DEPS com.acme/testing com.acme/app;
}
```

`fabr test com.acme/app-it` builds the app and runs the tests under `src/it/java`.

### Building and testing everything

`mvn verify` or `gradle build` at the root builds and tests every module. `fabr build` and
`fabr test` build what you name, and what it depends on. List the targets you test in a property,
and name that:

```
TESTED = com.acme/core com.acme/app com.acme/app-it;
```

```sh
fabr test TESTED
```

See [Build what you ship](/guides/multi-package/#build-what-you-ship).

## Repositories and credentials

| Maven / Gradle | fabr |
|---|---|
| Maven Central, `mavenCentral()` | `@mvn`, declared for you. |
| A mirror of Central in `settings.xml` `<mirrors>` | `MAVEN_REPOSITORY_URL = https://…;` in `PROJECT.fabr`. |
| Another repository in `<repositories>` or `repositories { maven { url = … } }` | A `maven_repository` with a name of your choosing, and that name in place of `@mvn` for its packages. |
| Several repositories, each holding some packages | A [`repository_group`](/reference/java/dependencies/#combining-repositories). |
| `<servers>` in `settings.xml` | Read from `~/.m2/settings.xml`, as Maven reads them. |
| Credentials in `build.gradle` or `gradle.properties` | A `<server>` in `~/.m2/settings.xml`. |
| `<proxies>` in `settings.xml` | The `https_proxy`, `http_proxy` and `no_proxy` environment variables. |

Fabr looks for a package, and for everything its POM requires, in the one repository its reference
names, where Maven and Gradle search every repository the build lists. Point `@mvn` at a repository
manager that proxies Central, or combine a repository that holds only some packages, such as
Google's, with Central; see [Combining repositories](/reference/java/dependencies/#combining-repositories).
Only the `<servers>` of `settings.xml` are read; see
[Credentials](/reference/java/dependencies/#credentials) and
[Mirrors and proxies](/reference/java/dependencies/#mirrors-and-proxies).

## Plugins and tasks

Most of what a Maven or Gradle build configures plugins for is built into fabr's Java target types:

| Maven plugin / Gradle feature | In fabr |
|---|---|
| `maven-compiler-plugin`, `java { }` | Built in; see [Compiling](/reference/java/compiling/). |
| Surefire, `test { useJUnitPlatform() }` | Built in; see [Testing](/reference/java/testing/). |
| `maven-jar-plugin` `<manifestEntries>`, `jar { manifest { } }` | A `jar_package`'s [`manifest`](/reference/java/packaging/#the-manifest). |
| `maven-dependency-plugin:copy-dependencies` | A [`java_installation`](/reference/java/packaging/#the-jars-a-program-needs). |
| `spring-boot-maven-plugin`, the Spring Boot Gradle plugin | A [`spring_boot_jar`](/reference/java/packaging/#spring-boot-executable-jars). |
| `exec-maven-plugin`, `application` | `fabr run`; see [Running programs](/reference/java/running/). |
| `maven-javadoc-plugin`, `maven-source-plugin`, `withJavadocJar()`, `withSourcesJar()` | `fabr doc`, `fabr sources`; see [Javadoc and sources](/reference/java/packaging/#javadoc-and-sources). |
| `maven-deploy-plugin`, `maven-publish` | A `sync` target; see [Publishing](/reference/java/publishing/). |
| `jacoco-maven-plugin`, `jacoco` | `fabr test --coverage`; see [Code coverage](/reference/java/testing/#code-coverage). |
| `<profiles>` activated with `-P` | A property, [guarded](/reference/syntax/#guarded-properties) declarations, and `-D` on the command line; see below. |
| A code generator (OpenAPI, JAXB, ANTLR, a project's own), resource filtering | A [`generate`](/reference/standard-rules/#generate) target that runs the tool; see below. |
| Checkstyle, SpotBugs, Spotless, a custom Gradle task | A `java_program` for the tool, run by a `generate` target, or by a [rule](/guides/rules/) of your own for every target of a type. |
| `maven-shade-plugin`, Shadow, `maven-assembly-plugin` | See [Not supported](#not-supported). |

### Running a tool during the build

A plugin that runs a tool over files and adds its output to the build becomes two targets: a
`java_program` for the tool, and a `generate` target that runs it, whose output a `jar_package`
names among its `srcs` or `resources`. This replaces a small plugin that writes the project's
version into a class:

```
# app/BUILD.fabr
java_program version_gen {
  srcs = tools:*.java;
}

generate build_info {
  run = version_gen ${VERSION} > BuildInfo.java;
}

jar_package com.acme/app {
  srcs = src/main/java:**/*.java build_info:*.java;
  deps = com.acme/core;
  main_class = com.acme.app.Main;
}
```

`version_gen` compiles `app/tools/VersionGen.java` into a program, which prints a Java source file;
`build_info` runs it and keeps what it prints as `BuildInfo.java`, which the jar compiles with the
rest of its sources. A tool published to Maven Central is a `java_program` whose `deps` name it, such
as the OpenAPI generator in [Java tools in a build](/reference/java/running/#java-tools-in-a-build).
The same pattern replaces Maven's resource filtering: generate the filtered file and name it in
`resources`. [Running your own tools](/guides/tools/) covers tools in a build in more depth.

### Profiles

A Maven profile that adds dependencies or changes a setting becomes a property of your own, and
declarations [guarded](/reference/syntax/#guarded-properties) on its value:

```
# PROJECT.fabr
PROFILE = default;
```

```
jar_package com.acme/core {
  srcs = src/main/java:**/*.java;
  tests = src/test/java:**/*.java;
  test_deps = TEST_DEPS;
  test_deps<PROFILE=it> = @mvn:org.assertj:assertj-core:3.26.0;
}
```

`fabr test -DPROFILE=it com.acme/core` adds AssertJ to the tests, as `mvn test -Pit` would. Both
results are cached, so switching between them rebuilds nothing that has been built before.

## After migrating

Work through each converted module:

1. **Build it**: `fabr build com.acme/core`. A compile error usually means a dependency is missing
   from a property, often one that Maven or Gradle put on the classpath by a scope fabr doesn't
   share, such as a `provided` dependency now in `compile_deps`.
2. **Compare its dependencies** with what Maven or Gradle resolved. `fabr deps com.acme/app`
   prints the tree, without downloading any jars, as `mvn dependency:tree` and `gradle dependencies`
   do:

   ```
   com.acme/app
   deps
   ├── com.acme/core
   │   └── com.google.guava/guava:33.2.1-jre
   │       ├── com.google.guava/failureaccess:1.0.2
   │       └── …
   └── org.slf4j/slf4j-api:2.0.13
   runtime_deps
   └── org.slf4j/slf4j-simple:2.0.13
       └── org.slf4j/slf4j-api:2.0.13
   ```

   Some versions may differ, because fabr chooses versions by a different rule; see below.
3. **Run its tests**: `fabr test com.acme/core`. Surefire runs only classes named `Test*`, `*Test`,
   `*Tests` and `*TestCase`, and fabr runs every class an engine recognises as a test, so a test
   class Maven skipped now runs. Tests also run with no environment variables, so a test that reads
   one from your shell fails until it no longer depends on it. See [Testing](/reference/java/testing/).
4. **Check what it produces**: `fabr ls com.acme/app` lists the jar, and `fabr cp com.acme/app ./out`
   copies it out to compare with what Maven built. The jar holds no `META-INF/maven` directory.
5. **If you publish it**, declare the `sync` target and run `fabr build` on it, which produces
   everything it would upload, POMs included, without uploading. Compare the POMs with the ones
   you publish now; see [Publishing](/reference/java/publishing/).

Then set up CI; see [Continuous integration](/guides/ci/).

### Why versions can differ

For each package, fabr selects the highest version that anything in the build requires, the rule Go
modules use (see [How versions are chosen](/reference/java/dependencies/#how-versions-are-chosen)).
Compared with what you used before:

- **Maven** uses the version declared nearest your project, even where a dependency deeper in the
  tree requires a later one. Fabr selects that later one, so `fabr deps` can show a later version
  than `mvn dependency:tree` did. The version Maven chose is still one of the requirements, so fabr
  never selects an earlier one for a plain version.
- **Gradle** also selects the highest version requested, so most trees match.
- **Version ranges** select the lowest published version in the range, where Maven and Gradle select
  the highest. `@mvn:org.slf4j:slf4j-api:"[1.7.0,2.0)"` selects 1.7.0. Write the version you use
  instead of a range.
- **Gradle's dynamic versions** are read as ordinary Maven versions. `1.+` sorts just above 1.0,
  so it asks for at least the first published 1.x release, as a floor, with no limit below 2.0.
  `latest.release` sorts below every numbered version, so it asks for nothing, and you get
  whatever the rest of the build requires, or the oldest published version. Write the version you
  use.

To keep a version you depended on before, require it yourself in the module's `deps`: your own
requirement is one of the ones the highest is taken from. To hold a package at one version
everywhere, as a Maven `<dependencyManagement>` entry or a Gradle `strictly` constraint does, write it
with `!`: `@mvn:com.google.guava:guava:32.1.3-jre!`.

## Troubleshooting

**`org.slf4j:slf4j-api:1.7 is not published at https://repo1.maven.org/maven2`**

A version range's lower bound, here `[1.7,2.0)`, names a version that was never published. Make the
lower bound a published version, `[1.7.0,2.0)`, or write the version you use.

**`org.jetbrains.kotlin:kotlin-stdlib:1.7.10 is not published at https://maven.google.com (required by …)`**

A package from a repository that doesn't hold everything it requires. Combine the repository with
Central in a [`repository_group`](/reference/java/dependencies/#combining-repositories), or point `@mvn` at a repository
manager that proxies both.

**`the following packages are required only without a version lower bound ('*'), so no version is selectable — name one explicitly`**

A dependency was written without a version, and no BOM gives it one. Put the BOM in the same
property, or give the dependency a version.

**`Resolution requires multiple versions of the same package:`**

Two requirements can't be met by one version. See
[When versions conflict](/reference/java/dependencies/#when-versions-conflict).

**`fabr-junit-runner: the JUnit Platform launcher is not on the classpath`**

Add `@mvn:org.junit.platform:junit-platform-launcher` to the module's `test_deps`, beside the JUnit
BOM; see [Testing](/reference/java/testing/#troubleshooting).

## Not supported

- **Kotlin, Groovy and Scala sources.** Fabr compiles Java only.
- **Your local Maven repository.** Fabr doesn't read `~/.m2/repository`, and a `maven_repository` URL
  can't be a `file:` URL (`Unsupported protocol: file:`). Modules of one project depend on each
  other directly; a package built by another project has to be published to a repository fabr can
  read.
- **Shading and fat jars.** There is no equivalent of `maven-shade-plugin` or Shadow, which relocate
  packages and merge jars into one. For a program, a
  [`java_installation`](/reference/java/packaging/#the-jars-a-program-needs) gives its jars side by
  side, and for a Spring Boot application a
  [`spring_boot_jar`](/reference/java/packaging/#spring-boot-executable-jars) gives one executable
  jar.
- **Excluding a package** a dependency brings in, with `<exclusions>` or `exclude` in your own build.
  Exclusions a dependency publishes are read; see
  [Dependencies](/reference/java/dependencies/#not-supported).
- **Options for `javac`** beyond those fabr sets, such as `-Xlint` or `-Werror`, and **arguments for
  the test JVM**, such as Surefire's `argLine`.
- **`-SNAPSHOT` versions**, as dependencies or for publishing.
- **Publishing a jar whose dependencies come from a catalog.** `fabr sync` and `fabr build` on the
  `sync` target fail with `cannot publish @corp:com.acme/core:1.4.0: it depends on 'com.google.guava/guava', which is no Maven package`.
  Give a published jar's `deps`, `provided_deps`, `optional_provided_deps`, `runtime_deps` and
  `compile_api_deps` their versions directly or through properties; `test_deps` and `compile_deps`
  can still use the catalog.
