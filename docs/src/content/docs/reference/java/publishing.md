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
| `maven-source-plugin` / `withSourcesJar()`, `maven-javadoc-plugin` / `withJavadocJar()` | The repository's `auto_attach`; see [Sources and javadoc jars](#sources-and-javadoc-jars). |
| An artifact with a classifier | An entry with the classifier after the artifact: `@corp:<group>:<artifact>/<classifier>:<version>`. |
| Credentials in `settings.xml` | The same file; see [Credentials](/reference/java/dependencies/#credentials). |

## What is uploaded

For each entry, at its path in the repository's layout (`com/example/greeter/1.0.0/`):

- The artifact: the target's jar, or a war or ear, named `<artifact>-<version>.jar`.
- A POM, `<artifact>-<version>.pom`, generated as below.
- Any [classified jars](#sources-and-javadoc-jars), such as `<artifact>-<version>-sources.jar`.
- An `.md5` and a `.sha1` checksum beside each.

Then the package's `maven-metadata.xml` is brought up to date with the new version. The POM is
uploaded after the artifact and the classified jars, so a version is visible only once all of
them are there. An entry
whose POM is already in the repository is reported as already synced, and nothing is uploaded.

`fabr build release` produces all of these without uploading, under the release's name:

```sh
fabr ls release
# @corp/com.example/greeter/1.0.0/com/example/greeter/1.0.0/greeter-1.0.0.jar
# @corp/com.example/greeter/1.0.0/com/example/greeter/1.0.0/greeter-1.0.0.pom
# …
```

## Sources and javadoc jars

A repository's `auto_attach` lists the jars a `sync` publishes beside each artifact it publishes
there, by their classifiers, as Maven's source and javadoc plugins add them:

```
maven_repository @corp {
  url = https://maven.corp.example.com/releases;
  auto_attach = sources javadoc;
}
```

With it, an entry for `greeter` also uploads `greeter-1.0.0-sources.jar`, the target's
[sources](/reference/java/packaging/#javadoc-and-sources) (`fabr sources greeter`), and
`greeter-1.0.0-javadoc.jar`, its javadoc (`fabr doc greeter`). A `jar_package` and a
`war_package` have both; a target with no sources or javadoc, such as an `ear_package`, has
neither. A javadoc error fails the `sync`, as it fails `mvn deploy` with the javadoc plugin on.
Without `auto_attach`, nothing is published beside an artifact.

A jar of your own is published with an entry naming its classifier after the artifact, with a
`/`:

```
sync release {
  @corp:com.example:greeter:1.0.0 = greeter;
  @corp:com.example:greeter/sources:1.0.0 = greeter<BUILD_OPERATION=sources>;
  @corp:com.example:greeter/tests:1.0.0 = greeter_tests;
}
```

This differs from Maven's and Gradle's own spellings, which put the classifier in a fourth `:`
part; in fabr a part after the version selects files, as in any reference, and a coordinate
written that way is an error that says how to write it.

The entry's content is packed into the jar, or, where it is one jar, is that jar. An entry for a
classifier `auto_attach` lists takes its place. The artifact the jar belongs beside must be
published by the same `sync`: `cannot publish @corp:com.example/greeter/sources:1.0.0: the release
publishes no com.example:greeter:1.0.0 for it to be beside`.

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
  and requires PGP signatures beside each file.
- A `-SNAPSHOT` version can't be published.
