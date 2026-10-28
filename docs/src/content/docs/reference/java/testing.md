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
| `-Dtest=…` / `--tests …` | Not supported; see [Known issues](#known-issues). |
| Test reports under `target/surefire-reports` | A summary per target, and a [CTRF](https://ctrf.io) report. |

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

The tests are compiled against the jar, everything the jar requires, and the `test_deps`, then run
in one JVM on `JAVA`, with `test_resources` on the classpath. The engines look for tests among
every class the `tests` compile to. **Surefire:** runs only classes named `Test*`, `*Test`,
`*Tests` or `*TestCase`. **fabr:** runs every class an engine recognises as a test, whatever its
name.

```sh
fabr test app
```

prints `app: 12 tests passed` for each target, or the tests that failed with their messages. A
passing run is cached: running `fabr test` again with nothing changed reports the result without
running the tests. A target with no `tests` passes without running anything.

The tests run with no environment variables of their own, so a test can't depend on what is set in
your shell. JUnit's [configuration parameters](https://junit.org/junit5/docs/current/user-guide/#running-tests-config-params),
such as those for parallel execution, are read from a `junit-platform.properties` among the
`test_resources`.

## Troubleshooting

**`fabr-junit-runner: the JUnit Platform launcher is not on the classpath (…): add org.junit.platform:junit-platform-launcher, of the tests' JUnit release, to test_deps`**

The target's `test_deps` have no JUnit Platform launcher. Add
`@mvn:org.junit.platform:junit-platform-launcher` beside the engine, with its version from the same
JUnit BOM.

**`fabr-junit-runner: no tests were found: no test engine on the classpath found a test among the classes in […]`**

The target has `tests`, but no engine found a test in them. Either `test_deps` has no engine for
the kind of tests they are (add `junit-jupiter` for JUnit 5, `junit-vintage-engine` for JUnit 4),
or the engine and the launcher are of different JUnit releases; give both their versions from one
BOM.

## Known issues

- A run can't be limited to some of the tests, as `-Dtest=` or `--tests` does.
- All of a target's tests run in one JVM, which can't be given arguments of its own.
