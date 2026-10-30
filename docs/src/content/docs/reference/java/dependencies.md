---
title: Dependencies
description: How to declare Maven dependencies in fabr, how their versions are chosen, and how BOMs, scopes and repositories work.
---

A fabr project declares its Maven dependencies in the build file, on the targets that use them.
Fabr reads each package's `pom.xml` from the repository for what the package requires, downloads
the jars a build needs when it needs them, and chooses versions by a rule that gives the same
answer every time. This page covers declaring dependencies and how their versions are chosen.

## Coming from Maven or Gradle

| With Maven or Gradle | In fabr |
|---|---|
| `<dependency>` with `<scope>compile</scope>` / `implementation`, `api` | A target's `deps`. |
| `<scope>runtime</scope>` / `runtimeOnly` | `deps`. |
| `<scope>provided</scope>` / `compileOnly` for a jar the runtime supplies | `provided_deps`. |
| `<optional>true</optional>` | `optional_provided_deps`. |
| `compileOnly` for a jar nothing needs at run time (annotations) | `compile_deps`. |
| `<scope>test</scope>` / `testImplementation` | `test_deps`. |
| `annotationProcessor`, `<annotationProcessorPaths>` | `processors`; see [Annotation processors](/reference/java/compiling/#annotation-processors). |
| A BOM in `<dependencyManagement>` with `<scope>import</scope>` / `platform(…)` | The BOM in `deps`, `test_deps` or wherever its versions are used; see [BOMs](#boms). |
| Nearest-wins conflict resolution | The highest version anything requires; see [How versions are chosen](#how-versions-are-chosen). |
| `<classifier>linux-x86_64</classifier>` / `group:artifact:version:classifier` | `@mvn:<group>:<artifact>/<classifier>:<version>`; see [Classified jars](#classified-jars). |
| `<exclusions>` | See [Not currently supported](#not-currently-supported). |
| `<repositories>`, `settings.xml` mirrors | A [`maven_repository`](#repositories), or `MAVEN_REPOSITORY_URL`. |
| `<servers>` in `settings.xml` | The same file; see [Credentials](#credentials). |
| `mvn dependency:tree` / `gradle dependencies` | `fabr deps <target>`. |

## Declaring a dependency

A dependency is written `@mvn:<group>:<artifact>:<version>`:

```
jar_package app {
  srcs = src/main/java:**/*.java;
  deps = @mvn:org.slf4j:slf4j-api:1.7.36 @mvn:com.google.guava:guava:33.2.1-jre;
}
```

`@mvn` is [Maven Central](https://central.sonatype.com/) unless you say otherwise; see
[Repositories](#repositories). The version is a version (`1.7.36`), as Maven reads one, or a
Maven version range in quotes: `@mvn:com.example:lib:"[1.0,2.0)"`. Fabr shows a package's name as
`<group>/<artifact>`, as in `org.slf4j/slf4j-api`, and accepts it written that way too.

A dependency on another target in the same project is written by its name: `deps = mylib;`.

`fabr ls @mvn:org.slf4j:slf4j-api` lists the versions the repository publishes, newest first.

### Which properties take dependencies

| Property | Used for | Passed on to whatever depends on the jar |
|---|---|---|
| `deps` | Packages the code uses | Yes. |
| `provided_deps` | Packages the code uses that whatever runs it supplies, such as the servlet API a container provides | As a requirement the consumer must meet; the jar doesn't carry them. |
| `optional_provided_deps` | As `provided_deps`, for packages whatever runs it may leave out | Only where the consumer has the package anyway. |
| `compile_deps` | Packages the code is compiled against that nothing needs when it runs, such as an annotations-only jar | No. |
| `test_deps` | Packages only the tests use | No. |

The sources are compiled against all of them but `test_deps`, and the tests against all five. The
tests run with all but `compile_deps` on the classpath.

## How versions are chosen

Fabr uses **minimal version selection**, the algorithm Go modules use. For each package it gathers
every requirement in the build, yours and those of your dependencies' POMs, and selects the
highest of the versions they ask for. A plain version in Maven is a minimum ("this or later"), so
this is the lowest version that satisfies everything.

**Maven:** the version declared nearest to your project wins, even when something deeper in the
tree requires a later one, which can put a version on the classpath that a library was never
built against. **Gradle:** the highest version requested wins, as in fabr. **fabr:** the highest
version requested wins, and nothing depends on the order the tree was walked in. A range's upper
bound is checked against the version chosen, and a version that breaks one is an error rather
than a silent choice.

```
deps = @mvn:org.apache.commons:commons-text:1.11.0;   # also selects commons-lang3 3.13.0,
                                                     # the version commons-text's POM names
```

To use a later version of something a dependency requires, require it yourself: your own
requirement is one of the ones the highest is taken from.

`fabr deps <target>` prints the tree each target resolves to:

```
greeter
deps
└── org.apache.commons/commons-text:1.11.0
    └── org.apache.commons/commons-lang3:3.13.0
```

### When versions conflict

There is one version of each package on a classpath. When requirements can't all be met by one
version, because a range's upper bound excludes the version something else requires, the build
fails with `Resolution requires multiple versions of the same package:` and the two requirements
that disagree, each with the path it came from. Choose the version yourself and mark it with `!`
to make every requirement on the package use it:

```
deps = @mvn:com.example:widget:2.3.0 @mvn:com.example:util:1.4.2!;
```

A `!` needs an exact version.

## BOMs

A BOM (bill of materials) is a POM-packaged artifact whose `<dependencyManagement>` lists
versions for a set of packages, such as `junit-bom` or `spring-boot-dependencies`. Put the BOM in
the same property as the packages it manages, and write those without a version:

```
jar_package app {
  srcs = src/main/java:**/*.java;
  deps = @mvn:org.springframework.boot:spring-boot-dependencies:2.7.18
         @mvn:org.springframework.boot:spring-boot-starter-web;
  test_deps = @mvn:org.junit:junit-bom:5.11.4
              @mvn:org.junit.jupiter:junit-jupiter
              @mvn:org.junit.platform:junit-platform-launcher;
}
```

A BOM's versions are minimums that apply only to packages something else requires: it adds
nothing to the build itself. A versionless reference with no BOM to give it a version is an error
that says the package `is required ... without a version lower bound`.

## What fabr reads from a POM

Fabr reads the POM of every package it selects, with its parent POMs, the properties they define
(`${project.version}`, `${slf4j.version}`), their `<dependencyManagement>` and the BOMs they
import. Of a POM's `<dependencies>`:

| Declared in the POM | What fabr does with it |
|---|---|
| `compile` or `runtime` scope | A requirement of the package. A `runtime` one is on your compile classpath too, where Gradle puts it only on the runtime classpath. |
| `provided`, `test` or `system` scope, or `<optional>true</optional>` | Ignored, as Maven and Gradle ignore them. |
| A dependency with a `<classifier>` | A requirement of the [classified jar](#classified-jars). |
| A `test-jar` dependency | A requirement of the package's `tests` jar. |
| A dependency of another type (`zip`, `pom`, …) | Ignored. |

`<exclusions>` and `<profiles>` are not read.

A package's files are its one artifact, `<artifact>-<version>.jar` (`.war`, `.ear` and so on, from
its `<packaging>`), checked against the `.sha1` the repository publishes beside it. A POM-packaged
artifact, such as a BOM, has no files unless the repository also publishes a jar for it. Its
sources and javadoc jars are fetched only when
[asked for](#a-dependencys-javadoc-and-sources).

## Classified jars

Some packages publish further jars beside each version, told apart by a classifier: a native
library for each platform (`netty-transport-native-epoll-4.1.110.Final-linux-x86_64.jar`), a
`tests` jar. A reference names one with the classifier after the artifact:

```
deps = @mvn:io.netty:netty-transport-native-epoll/linux-x86_64:4.1.110.Final;
```

The version is chosen for the package, not for the classified jar: every requirement on
`netty-transport-native-epoll`, classified or not, raises the one version, and each classified jar
is of that version. So a native library always matches the classes that load it. Requiring
`…/linux-x86_64:4.1.100.Final` beside a library that requires `4.1.110.Final` gives
`netty-transport-native-epoll-4.1.110.Final-linux-x86_64.jar`; `fabr deps` shows it as
`io.netty/netty-transport-native-epoll/linux-x86_64:4.1.100.Final -> 4.1.110.Final`. A classified
jar requires its package, and through it what the version's POM requires: a classified jar has no
POM of its own.

This is how Gradle resolves a classifier. Maven chooses a version for each classifier apart, by
nearest wins, so a classified jar can end up at a different version from its package unless a BOM
gives both, which is why Netty's BOM lists each classifier.

Where the version chosen publishes no jar with the classifier, it is an error:
`io.netty:netty-transport-native-epoll:4.1.110.Final publishes no linux-sparc jar`. Require a
version that does.

Spelling the classifier after the artifact differs from Maven's and Gradle's own notation, which
put it in a further `:` part; in fabr what follows the version selects files from the jar, as in
any reference. A classified jar's sources or javadoc are not read with `<BUILD_OPERATION=sources>`
or `doc`: where a package publishes them, they are a classified jar of their own (`/test-sources`
for a `tests` jar's).

## A dependency's javadoc and sources

Under the `doc` and `sources` operations a Maven reference is answered with the package's
published `-javadoc.jar` or `-sources.jar`, unpacked:

```sh
fabr ls '@mvn:org.slf4j:slf4j-api:1.7.36<BUILD_OPERATION=doc>'        # index.html, …
fabr cp '@mvn:org.slf4j:slf4j-api:1.7.36<BUILD_OPERATION=sources>' ./src
```

Only the package named is fetched, not what it requires. A package that publishes no such jar is
the error `org.junit:junit-bom:5.11.4 publishes no javadoc jar`.

## Repositories

`@mvn` is Maven Central. To send every `@mvn` package to a mirror, set `MAVEN_REPOSITORY_URL`:

```
MAVEN_REPOSITORY_URL = https://maven.example.com/repository/maven-public;
```

To use another repository beside Central, declare it with a name of your choosing, and write its
packages under that name:

```
maven_repository @corp {
  url = https://maven.corp.example.com/releases;
}

jar_package app {
  deps = @corp:com.corp:billing:4.2.0 @mvn:org.slf4j:slf4j-api:1.7.36;
}
```

A package's own requirements are looked up in the repository it came from, so the repository must
hold everything its packages require; a repository manager that proxies Central does.

### Credentials

A repository that needs credentials gets them from your `~/.m2/settings.xml`, as Maven does. A
`maven_repository` uses the `<server>` its `id` names, for reading and for
[publishing](/reference/java/publishing/). Without an `id`, it uses the server named exactly as the
repository is, `@corp`:

```
maven_repository @corp {
  url = https://maven.corp.example.com/releases;
  id = corp-releases;
}
```

```xml
<settings>
  <servers>
    <server>
      <id>corp-releases</id>
      <username>deploy</username>
      <password>${env.CORP_MAVEN_PASSWORD}</password>
    </server>
  </servers>
</settings>
```

For a mirror of Maven Central that needs credentials, declare `@mvn` yourself, which replaces the
one fabr declares, with the mirror's URL and server:

```
maven_repository @mvn {
  url = https://maven.corp.example.com/central;
  id = corp-mirror;
}
```

`${env.NAME}` reads an environment variable, as it does for Maven, which keeps the secret out of
the file in CI. A server's `<configuration><httpHeaders>` are sent too, for a repository that reads
a token from a header, such as GitLab's `Private-Token`. A password encrypted with Maven's master
password can't be read; write it with `${env.NAME}` instead.

## Not currently supported

- `<exclusions>`, relocations and POM profiles are not read. A package that a dependency's POM
  requires can't be removed, only overridden with `!`.
- A reference can't name a type other than a jar.
- A classifier isn't chosen for the platform: a project building for several writes the
  classified jar of each.
- Timestamped `-SNAPSHOT` versions are not resolved.
