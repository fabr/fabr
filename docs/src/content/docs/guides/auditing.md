---
title: Auditing dependencies
description: Check the npm and Maven packages your targets depend on for known security advisories with fabr audit, act on what it finds, and write a CycloneDX bill of materials with fabr sbom.
---

Fabr has two commands that report on the packages a target depends on, without building it.
`fabr audit` checks them against the [OSV](https://osv.dev) database of security advisories, and
`fabr sbom` writes them out as a [CycloneDX](https://cyclonedx.org) software bill of materials.
Both work on npm and Maven packages alike, and both read the same dependency tree that
[`fabr deps`](/reference/command-line/#deps) prints: the one your target's build would use.

| You want to | Section |
|---|---|
| Find advisories that affect your dependencies | [Running `fabr audit`](#running-fabr-audit) |
| Understand the report | [Reading the report](#reading-the-report) |
| Fix what it found | [Acting on an advisory](#acting-on-an-advisory) |
| Use a mirror or an internal advisory database | [Choosing the advisory database](#choosing-the-advisory-database) |
| Produce an SBOM | [Writing a bill of materials](#writing-a-bill-of-materials) |
| Run either in CI | [In CI](#in-ci) |

## Compared with the tools you know

**npm audit:** checks the tree recorded in `package-lock.json` against the GitHub Advisory
Database, and `npm audit fix` updates the lockfile. **fabr:** checks the versions fabr selects for
the build, which follow from your build files alone, and changes nothing; you raise a version by
editing the build file. Fabr selects the
[lowest version that satisfies every requirement](/reference/js/dependencies/#how-versions-are-chosen),
not the newest, so a dependency's dependencies are often older than the ones a fresh
`npm install` would give you, and `fabr audit` reports advisories that `npm audit` on a new
lockfile wouldn't. The report is about what you actually build.

**Dependabot:** GitHub reads your manifests and lockfiles on its servers, raises alerts, and can
open pull requests that update them. **fabr:** you run the check yourself, locally or in CI, and
the result can go to GitHub code scanning as [SARIF](#sarif-for-code-scanning). Nothing opens pull
requests.

**OWASP Dependency-Check:** scans jar files and other artifacts and matches them against the NVD
by CPE, which needs a local copy of the NVD data. **fabr:** names each package exactly, by its
[package URL](https://github.com/package-url/purl-spec) (`pkg:maven/org.apache.commons/commons-text@1.9`),
and asks the OSV API about it; there are no files to scan and no database to download.

**cyclonedx-npm, the CycloneDX Maven plugin:** read an installed `node_modules` tree or a Maven
build. **fabr:** writes the bill of materials from the resolved tree, without downloading any
package, and the same sources always give the same document.

What `fabr audit` checks, and what it leaves out:

- **Checked:** every package from npm or a Maven repository among what a target's build requires,
  directly or through other packages, at the exact version selected.
- **Checked as the package it changes:** a [patched](#patching-a-package) package, at the
  version it was made from. An advisory its `fixes` names is reported as fixed by the patch.
- **Not checked:** other packages built in your project, which have no published version to ask
  about (what they depend on is checked); the
  tools fabr runs during a build, such as the TypeScript compiler, a bundler or a test runner,
  which aren't part of the target's dependencies; and the Node.js release and the JDK.
- **No fixing.** The report names the versions that fix each advisory; you choose one and edit
  the build file.
- **No severity threshold.** Every advisory found is reported, and any one of them makes the
  command fail, except one a patched package declares it fixes or one you
  [suppress](#suppressing-an-advisory-that-doesnt-apply) in an OpenVEX document.
- **Advisories are read live.** Each run asks the database afresh and caches nothing, so the same
  commit can pass one day and fail the next, when a new advisory is published.

## Running `fabr audit`

Name the targets whose dependencies you want checked:

```sh
fabr audit app
```

A name can be anything [`fabr deps`](/reference/command-line/#deps) takes:

- **A target**, or several: `fabr audit app worker`. Each is checked separately and the report
  lists one path per target that reaches an affected package.
- **A property listing targets**, such as `SHIPPED = app worker;`: `fabr audit SHIPPED`.
- **A package from a registry**, with no target declared, to check it before you add it:
  `fabr audit @npm:lodash:4.17.21`, `fabr audit @mvn:org.apache.commons:commons-text:1.10.0`.
  This works outside a project too.
- **A catalog member**: `fabr audit @pkg:react`.

A target is checked as its `build` resolves it: a `js_package`'s `deps`, `provided_deps` and the
packages they bring in, but not its `test_deps`. To check what its tests use as well, require the
`test` operation on the name:

```sh
fabr audit 'app<BUILD_OPERATION=test>'
```

A target type with no `build` of its own is read under the one operation it has: a `java_program`
or a `js_script` under `run`.

`fabr audit` checks the packages [`fabr deps`](/reference/command-line/#deps) shows for the same
name. A target whose files another target takes in is checked as part of that target, with
everything it requires: auditing a `container_image` checks the program it holds in its `files`, such as a
`js_installation` or `java_installation`, and its dependencies. What a base image pulled from a
registry contains, such as its operating system's packages, isn't checked.

For Java, a `jar_package` is checked against its compile classpath, which leaves out the
`runtime`-scope dependencies of the packages it uses. Audit what you deploy instead: a
`java_program`, `war_package` or `java_installation` is checked against its runtime classpath, the
jars it actually runs with. See
[Compile and runtime classpaths](/reference/java/dependencies/#compile-and-runtime-classpaths).

`fabr audit` resolves versions exactly as a build would, reading only registry metadata, so it
builds nothing and downloads no packages. The command-line reference has
[its options](/reference/command-line/#audit).

### Reading the report

The report goes to stdout; fabr's own progress lines go to stderr, and `-q` leaves them out. For a
target with `deps = @npm:async:2.6.3 @npm:minimist:1.2.8;`:

```
GHSA-35jh-r3h4-6jhm (CVE-2021-23337)  HIGH  Command Injection in lodash
  lodash@4.17.14, fixed in 4.17.21
    app > async@2.6.3 > lodash@4.17.14
  https://nvd.nist.gov/vuln/detail/CVE-2021-23337

GHSA-fwr7-v2mv-hh25 (CVE-2021-43138)  HIGH  Prototype Pollution in async
  async@2.6.3, fixed in 3.2.2, 2.6.4
    app > async@2.6.3
  https://nvd.nist.gov/vuln/detail/CVE-2021-43138

…

6 advisories affect 2 of 3 packages checked
```

Each advisory is one block, the most severe first:

- **The heading** is the advisory's OSV id with its aliases (usually the CVE), the database's
  severity rating where it gives one (`CRITICAL`, `HIGH`, `MODERATE`, `LOW`), and its summary.
- **Each affected package** follows at the version your tree has, with the versions the advisory
  says fix it, highest first. An advisory fixed on several release lines lists a version for each
  (`fixed in 3.2.2, 2.6.4`): choose the one on the line you want to stay on.
- **The path** shows how the target reaches the package, one per target named. `(+2)` at the end
  of a path means the tree reaches the package two more ways, such as through another package that
  depends on it or your own requirement on it.
- **The link** is the advisory's published page.

The last line counts the advisories and the packages checked. With nothing found it reads
`No known advisories affect the 3 packages checked`.

A Maven package is named by its group and artifact:

```
GHSA-599f-7c49-w659 (CVE-2022-42889)  CRITICAL  Arbitrary code execution in Apache Commons Text
  org.apache.commons/commons-text@1.9, fixed in 1.10.0
    greeter > org.apache.commons/commons-text@1.9
  https://nvd.nist.gov/vuln/detail/CVE-2022-42889
```

### Exit status

`fabr audit` exits with 0 when no advisory affects any package checked, and with 1 when one does.
An advisory a [patched package fixes](#patching-a-package), or a
[VEX statement suppresses](#suppressing-an-advisory-that-doesnt-apply), doesn't count.
It also exits with 1 when the audit couldn't run: an unknown name, a dependency that can't be
resolved, or an advisory database that can't be reached, each reported on stderr with an `error:`
line. The [command-line reference](/reference/command-line/#exit-status) lists every status.

### SARIF for code scanning

`--format sarif` writes the report as [SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/),
the format GitHub code scanning and other code-scanning services read:

```sh
fabr audit --format sarif app > audit.sarif
```

Each advisory is a rule, with its id, summary, link, aliases and a `security-severity` score
derived from its rating, and each affected package is a result: `error` for a critical or high
advisory, `warning` for a moderate or unrated one, `note` for a low one. A result is placed at the
line of your build file whose reference brings the package in, even when the package arrives
through another one, so the alert for lodash in the example above points at the `deps` line that
names `async`. A package you name on the command line, such as `@npm:lodash:4.17.15`, has no
line to point at, so its result has no location. The file paths are relative to your project's root directory, the one holding
`PROJECT.fabr`. Each result's properties carry the package URL, the fixed versions and the paths.

### Choosing the advisory database

The advisories come from the server the `ADVISORIES_URL` property names, `https://api.osv.dev` unless
you set it. Any server answering the [OSV API](https://google.github.io/osv.dev/api/) works, such
as a mirror or an internal database. Set it in your project:

```
ADVISORIES_URL = https://osv.internal.example.com;
```

or for one run:

```sh
fabr -DADVISORIES_URL=https://osv.internal.example.com audit app
```

## Acting on an advisory

The remedy is a later version of the affected package. Fabr chooses one version of each package
for the whole tree, the highest of the minimum versions anything asks for, so raising the minimum
anywhere raises it everywhere. Pick a version from the report's `fixed in` list, then run
`fabr audit` again to confirm.

| The affected package is | Do this |
|---|---|
| Your own direct dependency | Raise the version in `deps`: `@npm:minimist:1.2.0` becomes `@npm:minimist:1.2.8`. |
| A dependency of a dependency | First see whether a later release of the package you depend on requires a fixed version. If not, require the fixed version yourself, as below. |
| Brought in through a catalog | Add the fixed version to the [catalog](/reference/js/dependencies/#catalogs), and every target using it gets it. |
| Held back by a range that excludes the fix | Force it with `!`, as below. |
| Not fixed in any release | Patch it, as below, or remove the dependency. |

### Requiring a fixed version yourself

Add a requirement with the fixed version as its minimum. For a package that `async` brings in:

```
js_package app {
  srcs = src:**/*.ts;
  deps = @npm:async:2.6.4 @npm:lodash:^4.18.1;
}
```

`fabr deps app` shows the result: `lodash:^4.17.14 -> 4.18.1` under `async`. The requirement also
makes `lodash` a dependency of `app` in its published `package.json`. To raise it without that,
use a catalog where the target already takes the dependency from one:

```
catalog @pkg {
  deps = @npm:async:2.6.4 @npm:lodash:4.18.1;
}

js_package app {
  srcs = src:**/*.ts;
  deps = @pkg:async;
}
```

A `?` marker doesn't help here: `@npm:lodash:4.18.1?` permits that version without asking for it,
so it raises nothing.

Maven works the same way: a plain version in a requirement is a minimum.

```
java_installation libs {
  deps = @mvn:org.apache.commons:commons-text:1.10.0
         @mvn:org.apache.commons:commons-lang3:3.18.0;   # raises commons-text's 3.12.0
}
```

A BOM raises every package it manages that the tree uses, which suits a family of artifacts
released together:

```
deps = @mvn:org.apache.logging.log4j:log4j-bom:2.25.5
       @mvn:org.apache.logging.log4j:log4j-core:2.14.1;   # selects 2.25.5
```

See [How versions are chosen](/reference/java/dependencies/#how-versions-are-chosen) and
[BOMs](/reference/java/dependencies/#boms).

### Forcing a version

When a package's range excludes the fixed version (a dependency asking for `~4.17.15` when the fix
is 4.18.0), raising the minimum gives a version conflict instead. Force the version with `!`,
which replaces every requirement on the package, like npm's `overrides`:

```
deps = @npm:async:2.6.4 @npm:lodash:4.18.1!;
```

A `!` needs an exact version. Use it only when you know the forced version works with the package
whose range it overrides. See
[When versions conflict](/reference/js/dependencies/#when-versions-conflict) and, for Maven,
[its section](/reference/java/dependencies/#when-versions-conflict).

### Patching a package

Where no fixed release exists, a [`patched`](/reference/js/dependencies/#patching-a-package) target
replaces the package everywhere in the build with your own copy. `fabr audit` still checks a
patched package, at the version it was made from, so the advisory is still reported. To say that
the patch fixes it, list the advisory in the target's `fixes`, by its OSV id or any of its aliases:

```
patched lodash {
  srcs = @npm:lodash:4.17.15;
  patches = patches/lodash-template.patch;
  fixes = GHSA-35jh-r3h4-6jhm;
}
```

The report then shows the package as fixed by the patch, and that advisory no longer makes the
command fail:

```
GHSA-35jh-r3h4-6jhm (CVE-2021-23337)  HIGH  Command Injection in lodash
  lodash@4.17.15, fixed by 'lodash'
    app > async@2.6.3 > lodash@4.17.15
  https://nvd.nist.gov/vuln/detail/CVE-2021-23337

No known advisories affect the 3 packages checked; 1 advisory is fixed by patched packages
```

Every other advisory affecting the original version is reported as usual, against
`lodash@4.17.15 as patched by 'lodash'`. Fabr doesn't check that the patch actually fixes what
`fixes` lists; that is your claim. An id in `fixes` that names no advisory affecting the package
gets a warning on stderr. That happens when `srcs` has moved to a version the advisory doesn't
affect, or when the id is misspelt. So does a `fixes` on a `patched` target whose `srcs` isn't one
registry package (vendored files, say): there is no published version for an advisory to affect.
Remove the patch once a fixed release is out.

In SARIF, a fixed package's result carries a `suppressions` entry of kind `inSource`. In a bill of
materials, a patched package's component has a `pedigree`: the original package as its ancestor,
and a patch that `resolves` each advisory in `fixes`.

### Suppressing an advisory that doesn't apply

An advisory can affect a package without affecting your program: the vulnerable function is one
you never call, or the package is only used at build time. Record that in an
[OpenVEX](https://github.com/openvex/spec) document, and name the document with the
`ADVISORIES_SUPPRESSION_FILE` property in your project:

```
ADVISORIES_SUPPRESSION_FILE = ./security/vex.json;
```

```json
{
  "@context": "https://openvex.dev/ns/v0.2.0",
  "@id": "https://example.com/vex/app",
  "author": "Security team",
  "timestamp": "2026-11-10T00:00:00Z",
  "version": 1,
  "statements": [
    {
      "vulnerability": { "name": "CVE-2021-23337" },
      "products": [{ "@id": "pkg:npm/lodash@4.17.14" }],
      "status": "not_affected",
      "justification": "vulnerable_code_not_in_execute_path",
      "impact_statement": "app never calls _.template"
    }
  ]
}
```

A statement applies to a package when its `vulnerability` names the advisory, by its OSV id, its
name or any alias, and one of its `products`, or of their `subcomponents`, is the package's
[package URL](https://github.com/package-url/purl-spec). A package URL without a version applies to
every version, and qualifiers such as `?type=jar` are ignored. Where several statements apply, the
one with the latest `timestamp` decides (a statement without one takes its document's); among
equals, the last one written. Both the 0.2 form shown and the earlier form, where a vulnerability
and a product are plain strings, are read. The property may name several documents.

A statement with the status `not_affected` or `fixed` suppresses the advisory in that package: the
report shows the package with the statement's status and justification, and the advisory no longer
makes the command fail:

```
GHSA-35jh-r3h4-6jhm (CVE-2021-23337)  HIGH  Command Injection in lodash
  lodash@4.17.14, not affected: vulnerable_code_not_in_execute_path (security/vex.json)
    app > async@2.6.3 > lodash@4.17.14
  https://nvd.nist.gov/vuln/detail/CVE-2021-23337

…; 1 advisory is suppressed by VEX statements
```

A statement with the status `affected` or `under_investigation` changes nothing: the advisory is
reported as usual. Because a statement names a version, raising the package to another version
the advisory affects brings the advisory back until you write a statement for it. In SARIF, a
suppressed package's result carries a `suppressions` entry of kind `external`.

## Writing a bill of materials

`fabr sbom` writes a [CycloneDX 1.6](https://cyclonedx.org/docs/1.6/json/) bill of materials of one
target or package to stdout, as JSON:

```sh
fabr sbom app > app.cdx.json
fabr sbom @mvn:org.apache.commons:commons-text:1.10.0 > commons-text.cdx.json
```

The packages it lists are the ones `fabr audit` checks for the same name, read the same way, so a
`<BUILD_OPERATION=…>` on the name, and the [Java classpath](#running-fabr-audit), apply here too.
A target whose files another target takes in, such as a program a `container_image` holds in its
`files`, is a component of the target that takes it. It takes exactly one name.

The document holds:

- **The component described**, under `metadata.component`: the target, as an `application`, named
  as the target is, with the `version` it declares. A registry package named on the command line is
  described as a `library`, by its package URL.
- **A component for every package** among its dependencies, direct or not, each a `library` named
  by its [package URL](https://github.com/package-url/purl-spec) (`pkg:npm/async@2.6.3`,
  `pkg:maven/org.apache.commons/commons-lang3@3.11`), with its Maven group or npm scope as `group`. A package
  built in your project is a component by its name, and its version where the target declares one.
  A [patched](#patching-a-package) package also has a `pedigree` naming the package it was made from
  and the advisories its `fixes` lists.
- **Its licence**, as its registry publishes it: npm's `license` field, which is usually an SPDX id
  (`"id": "MIT"`) or expression, and Maven's POM `<licenses>`, taken from the nearest parent POM
  that declares one, which is usually a name and URL (`"name": "Apache License, Version 2.0"`).
- **Its digest**, as its registry publishes it: npm's `dist.integrity`, usually SHA-512, and the
  `.sha1` Maven publishes beside the jar.
- **The dependency graph**, under `dependencies`: what each component depends on directly.
- **The tool**: fabr and its version, under `metadata.tools`.

```json
{
  "type": "library",
  "bom-ref": "pkg:npm/lodash@4.17.14",
  "name": "lodash",
  "version": "4.17.14",
  "purl": "pkg:npm/lodash@4.17.14",
  "licenses": [{ "license": { "id": "MIT" } }],
  "hashes": [{ "alg": "SHA-512", "content": "9a62986d6dc62ee2…" }]
}
```

Licences and digests come from each package's registry metadata for its exact version, which fabr
reads the first time and then keeps in its cache, since a published version's metadata never
changes. No package is downloaded.

The document carries no timestamp and no serial number, so the same sources and the same fabr
version write the same bytes every time. You can commit it, or compare it between releases with
`diff`.

## In CI

Run `fabr audit` in its own job, or on a schedule, so that a newly published advisory doesn't
block an unrelated merge; upload its SARIF to your code-scanning service; and keep `fabr sbom`'s
output with each release. [Continuous integration](/guides/ci/#security-advisories) has the
GitHub Actions steps.

## Troubleshooting

| You see | Cause | Fix |
|---|---|---|
| An advisory for a version older than npm would install | Fabr selects the lowest version that satisfies every requirement, not the newest. | Require the fixed version; see [Acting on an advisory](#acting-on-an-advisory). |
| The advisory is still reported after adding `@npm:x:1.2.3?` | A `?` permits a version without requiring it. | Write the requirement without `?`: `@npm:x:^1.2.3`. |
| `No packages to audit` for `'app<BUILD_OPERATION=test>'` | The target declares no `tests`, so it has nothing to test. | Audit the target without the operation, or add its tests. |
| `No packages to audit` | The name has no registry packages among its dependencies. | Check with `fabr deps <name>` that you named the right target. |
| `error:https://osv.example.com/v1/querybatch answered 404: …` | `ADVISORIES_URL` names something that isn't an OSV API server, or has a path on the end. | Set `ADVISORIES_URL` to the server's root URL, such as `https://api.osv.dev`. |
| `error:getaddrinfo ENOTFOUND osv.example.com` | The advisory server can't be reached. | Check the URL and the network; behind a proxy, set `HTTPS_PROXY`. |
| `The 'sbom' command takes a single target` | `fabr sbom` describes one thing. | Run it once per target, or name a property listing them with `fabr audit` instead. |
| `error: 'app:**' selects files of 'app'` | Both commands take a target or package, not a selection of its files. | Name the target: `app`. |
| `Option '--format' is not valid for the 'sbom' command` | `fabr sbom` writes only CycloneDX JSON. | Leave `--format` out. |
