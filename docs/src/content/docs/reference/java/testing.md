---
title: Testing
description: How fabr runs a jar_package's tests on the JUnit Platform, and what each failure means.
---

`fabr test` compiles a `jar_package`'s `tests` against the jar and runs them on the
[JUnit Platform](https://junit.org/junit5/docs/current/user-guide/), the foundation JUnit 5's
Jupiter engine runs on, and that the Vintage engine and other engines plug into. Whatever engines
are among the target's `test_deps` find and run the tests.

## Coming from Maven or Gradle

| With Maven or Gradle | In fabr |
|---|---|
| `src/test/java` | The target's `tests`. |
| `src/test/resources` | `test_resources`. |
| `<scope>test</scope>` / `testImplementation` | `test_deps`. |
| Surefire / `useJUnitPlatform()` | Built in: tests always run on the JUnit Platform. |
| Surefire bundles the platform launcher | The launcher is one of your `test_deps`. |
| `-Dtest=…` / `--tests …` | `fabr test -t <regex>`; see [Running some of the tests](#running-some-of-the-tests). |
| Test reports under `target/surefire-reports` | A summary per target; `fabr test --report <file> --format junit` writes JUnit XML, or [CTRF](https://ctrf.io) without `--format`. |
| jacoco-maven-plugin / the `jacoco` plugin | `fabr test --coverage`; see [Code coverage](#code-coverage). |

## Setting up

A target's tests need three things in its `test_deps`: a test engine, the API the tests are
written against, and the JUnit Platform launcher, all of one JUnit release. A BOM gives them one
version:

```
jar_package app {
  srcs = src/main/java:**/*.java;
  tests = src/test/java:**/*.java;
  test_resources = src/test/resources:**;
  test_deps = @mvn:org.junit:junit-bom:5.11.4
              @mvn:org.junit.jupiter:junit-jupiter
              @mvn:org.junit.platform:junit-platform-launcher;
}
```

`junit-jupiter` brings the Jupiter API and engine. For JUnit 4 tests, add the Vintage engine,
`@mvn:org.junit.vintage:junit-vintage-engine`, beside it.

The launcher is yours to choose because it must match the engine: a launcher from a different
JUnit release than the engine can find no tests at all.

## How tests run

The tests are compiled against the jar, everything the jar requires, and the `test_deps`, with the
target's `processors` running on them, then run in one JVM on `JAVA`, with `test_resources` on the
classpath. Like the jar's own sources, they are compiled against the compile classpath and run
with the runtime classpath, so `runtime_deps` are there when the tests run but not when they
compile; see [Which properties take dependencies](/reference/java/dependencies/#which-properties-take-dependencies). The engines look for tests among
every class the `tests` compile to. **Surefire:** runs only classes named `Test*`, `*Test`,
`*Tests` or `*TestCase`. **fabr:** runs every class an engine recognises as a test, whatever its
name.

```sh
fabr test app
```

prints `app: 12 tests passed` for each target, or the tests that failed with their messages. A
run is cached, passing or failing: running `fabr test` again with nothing changed reports the
result without running the tests, and `fabr test --retry-failed` runs a failed target's tests
again. A target with no `tests` passes without running anything. To collect every tested
target's results in one file for a CI system, as Surefire's XML reports are collected, give
`--report`:

```sh
fabr test --report test-results.xml --format junit app
```

The tests run with no environment variables of their own, so a test can't depend on what is set in
your shell. JUnit's [configuration parameters](https://junit.org/junit5/docs/current/user-guide/#running-tests-config-params),
such as those for parallel execution, are read from a `junit-platform.properties` among the
`test_resources`.

## Running some of the tests

```sh
fabr test -t 'DateTest#parse' app
```

runs only the test methods whose names the regular expression matches. A method's name is its
class's fully qualified name, `#` and the method's own name, with no parameters:
`com.example.DateTest#parsesIso`, and `com.example.DateTest$Iso#parses` for a method of the nested
class `Iso`. **Surefire / Gradle:** `-Dtest=DateTest#parse*` and `--tests` take a wildcard
pattern. **fabr:** the pattern is a Java regular expression, and it need only match part of the
name, so `DateTest#parse` selects `parsesIso` and `parseDate`, `#parsesIso$` exactly that method,
and `^com\.example\.` every test in that package. Write `\$` for the `$` of a nested class.

A parameterized test or a `@TestFactory` is selected by its method, so all of its cases run
together. Display names (`@DisplayName`) are not matched. The summary ends `(filtered)`, and if no
test in any target matches, the run fails. Selecting by name needs the JUnit Platform launcher
1.12 (JUnit 5.12) or later.

## Code coverage

```sh
fabr test --coverage app
```

runs the tests with [JaCoCo](https://www.jacoco.org/jacoco/)'s agent and reports the coverage of
the target's own jar: a summary is printed and an lcov report written to `coverage/lcov.info`,
naming each source by its path in your project. **Maven / Gradle:** the `jacoco-maven-plugin` or
`jacoco` plugin, configured with its own goals and report formats. **fabr:** nothing to declare;
the JaCoCo release is `JACOCO_AGENT` and `JACOCO`, which must name the same version.

JaCoCo records whether code ran, not how many times, so each line and method counts as 0 or 1.
The classes measured are those of the packages the target's `srcs` declare; the tests' own classes
and the jars the target depends on are not measured, including jars built in the project.

## Troubleshooting

**`fabr-junit-runner: the JUnit Platform launcher is not on the classpath (…): add org.junit.platform:junit-platform-launcher, of the tests' JUnit release, to test_deps`**

The target's `test_deps` have no JUnit Platform launcher. Add
`@mvn:org.junit.platform:junit-platform-launcher` beside the engine, with its version from the same
JUnit BOM.

**`fabr-junit-runner: selecting tests by name needs the JUnit Platform 1.12 launcher or later in test_deps (…)`**

`fabr test -t` was given for a target whose JUnit release is older than 5.12. Raise the JUnit BOM's
version to 5.12 or later.

**`fabr-junit-runner: no tests were found: no test engine on the classpath found a test among the classes in […]`**

The target has `tests`, but no engine found a test in them. Either `test_deps` has no engine for
the kind of tests they are (add `junit-jupiter` for JUnit 5, `junit-vintage-engine` for JUnit 4),
or the engine and the launcher are of different JUnit releases; give both their versions from one
BOM.

## Not supported

- All of a target's tests run in one JVM, which can't be given arguments of its own.
