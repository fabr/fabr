---
title: Publishing
description: How to publish jars, wars and ears to a Maven repository with a sync target, and what the generated POM records.
---

A `sync` target publishes the project's jars, wars and ears to a Maven repository manager, such as
Nexus, Artifactory, Reposilite or a company repository, as `mvn deploy` does. Each is uploaded
with a POM that fabr generates from what the target requires.

```
maven_repository @corp {
  url = https://maven.corp.example.com/releases;
}

sync release {
  @corp:com.example:greeter-api:1.0.0 = greeter_api;
  @corp:com.example:greeter:1.0.0 = greeter;
}
```

```sh
fabr build release    # produce what would be uploaded, without uploading
fabr sync release     # publish it
```

## Coming from Maven or Gradle

| With Maven or Gradle | In fabr |
|---|---|
| `mvn deploy` / `gradle publish` | `fabr sync <target>`. |
| `<distributionManagement>` / `publishing { repositories { … } }` | A `maven_repository` the `sync` entries name. |
| `groupId`, `artifactId` and `version` in the POM | The coordinate written in the `sync` entry: `@corp:<group>:<artifact>:<version>`. |
| A hand-written POM | Generated, from the target's dependencies and its `metadata`. |
| `mvn deploy -DskipTests`, a dry run | `fabr build` on the `sync` target, then `fabr ls`, `cat` or `cp`. |
| Modules deployed together | Several entries in one `sync`; dependencies between them get the right versions. |
| Credentials in `settings.xml` | The same file; see [Credentials](/reference/java/dependencies/#credentials). |

## What is uploaded

For each entry, at its path in the repository's layout (`com/example/greeter/1.0.0/`):

- The artifact: the target's jar, or a war or ear, named `<artifact>-<version>.jar`.
- A POM, `<artifact>-<version>.pom`, generated as below.
- An `.md5` and a `.sha1` checksum beside each.

Then the package's `maven-metadata.xml` is brought up to date with the new version. The POM is
uploaded after the artifact, so a version is visible only once its artifact is there. An entry
whose POM is already in the repository is reported as already synced, and nothing is uploaded.

`fabr build release` produces all of these without uploading, under the release's name:

```sh
fabr ls release
# @corp/com.example/greeter/1.0.0/com/example/greeter/1.0.0/greeter-1.0.0.jar
# @corp/com.example/greeter/1.0.0/com/example/greeter/1.0.0/greeter-1.0.0.pom
# …
```

## The generated POM

The POM records the coordinate, and one `<dependency>` for each of the target's `deps`,
`provided_deps` and `optional_provided_deps`:

| The target's | In the POM |
|---|---|
| `deps` | A dependency. |
| `provided_deps` | A dependency with `<scope>provided</scope>`. |
| `optional_provided_deps` | A dependency with `<optional>true</optional>`. |
| A BOM in any of them | An `import` in `<dependencyManagement>`. |
| `compile_deps`, `test_deps`, `processors` | Nothing. |

A dependency is recorded with the version written on it. One written without a version, which a
BOM gave, is recorded with the version the build selected. A dependency on another target in the
project is recorded with the coordinate the same `sync` publishes it under, so both must be in
the `sync`; otherwise publishing fails with `no version to record for 'greeter_api', which is
built in this project`. That holds when one entry is published alone, too:
`fabr sync 'release:@corp:com.example:greeter:1.0.0'` records `greeter_api` at the coordinate the
`sync` gives it.

### Project information

A `jar_package`'s `metadata` gives the rest of the POM: what Maven Central and repository
browsers show about the package. Each entry is a POM element. A string is its text, and a block
holds its child elements. `licenses`, `developers`, `contributors`, `mailingLists`,
`otherArchives` and `roles` are lists: give one block for each item, and `roles` its words.

```
jar_package greeter {
  srcs = src/main/java:**/*.java;
  metadata = {
    name = Greeter;
    description = "Says hello, politely";
    url = https://example.com/greeter;
    licenses = { name = Apache-2.0; url = https://www.apache.org/licenses/LICENSE-2.0; } { name = MIT; };
    developers = { id = jsmith; name = Jo Smith; roles = lead developer; };
    scm = { url = https://github.com/example/greeter; };
  }
}
```

Elements fabr writes itself (`modelVersion`, `groupId`, `artifactId`, `version`, `packaging`,
`dependencies`, `dependencyManagement`) and those only a build reads (`parent`, `modules`,
`properties`, `build`, `reporting`, `profiles`, `repositories`, `pluginRepositories`,
`distributionManagement`) are errors in `metadata`.

## Not currently supported

- Publishing to Maven Central is not supported: Central takes uploads only through its Portal,
  and requires PGP signatures and sources and javadoc jars beside each artifact.
- No `-sources.jar` or `-javadoc.jar` is published.
- A `-SNAPSHOT` version can't be published.
