/*
 * Copyright (c) 2022 Nathan Keynes <nkeynes@deadcoderemoval.net>
 *
 * This file is part of Fabr.
 *
 * Fabr is free software: you can redistribute it and/or modify it under the
 * terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * Fabr is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more
 * details.
 *
 * You should have received a copy of the GNU General Public License along with
 * Fabr. If not, see <https://www.gnu.org/licenses/>.
 */

import { expect } from "chai";
import {
  BUILD_OPERATION,
  CircularDependencyError,
  ConflictError,
  Constraints,
  DependencyFailedError,
  ExecutionError,
  HOST,
  IDiagnosticNote,
  Log,
  MultiError,
  parseName,
  NoRuleFoundError,
  ReferenceFailedError,
  registerProvenanceRenderer,
} from "@fabr-build/core";
import { DiagnosticErrorFormatter } from "./ErrorFormatter";

/** A stand-in for the driver-injected host facts, and the keys a report elides. */
const HOST_TRIPLE = "arm64-apple-macosx15.0";
const AMBIENT: ReadonlySet<string> = new Set([BUILD_OPERATION, HOST]);

/* The AST decl types aren't exported, so recover them from the error constructors.
 * The formatter only reads name/offset/source, so partial stubs suffice (spans
 * aren't asserted — we inspect the raw notes), hence the `as unknown` casts. */
type TargetDecl = ConstructorParameters<typeof DependencyFailedError>[0];
type ValueDecl = ConstructorParameters<typeof ReferenceFailedError>[0];
type PropertyDecl = ConstructorParameters<typeof ReferenceFailedError>[1];

function targetDecl(name: string, type = "js_package"): TargetDecl {
  return {
    name: parseName(name),
    type,
    typeOffset: 0,
    offset: 0,
    endOffset: 0,
    properties: [],
    source: {},
  } as unknown as TargetDecl;
}
function propertyDecl(name: string): PropertyDecl {
  return { name: parseName(name), values: [], offset: 0, endOffset: 0, source: {} } as unknown as PropertyDecl;
}
function value(written = "x"): ValueDecl {
  return { value: parseName(written), offset: 0, endOffset: 0, source: {} } as unknown as ValueDecl;
}

/** One captured diagnostic: the parts these tests assert on. */
type Captured = { message: string; notes?: IDiagnosticNote[]; help?: string[] };

/** Capture the diagnostics the formatter emits, keeping message, notes and help. */
function capture(err: Error, ambient: ReadonlySet<string> = new Set()): Captured[] {
  const out: Captured[] = [];
  const log: Log = { log: (_diag, params) => out.push(params as unknown as Captured) };
  new DiagnosticErrorFormatter(ambient).report(log, err);
  return out;
}

describe("DiagnosticErrorFormatter", () => {
  it("anchors a self-reference at the written name, pointing at the declaration it reached", () => {
    /* `js_package base { srcs = base:*.ts; }`: the name resolves to the target
     * being declared, not the directory beside it. The report belongs on the
     * reference; the declaration it reached (which may be in another file) is
     * the evidence, and the remedy is the './' spelling that reaches the path. */
    const base = targetDecl("base");
    const circular = new CircularDependencyError("base", [{ value: value("base:*.ts"), property: propertyDecl("srcs"), target: base }]);
    const [diag] = capture(new DependencyFailedError(base, circular));

    expect(diag.message).to.equal("Circular dependency: 'base' depends on itself");
    expect((diag.notes ?? []).map(note => note.message)).to.deep.equal(["'base' is declared here"]);
    expect(diag.help?.[0]).to.contain("write './base:*.ts' for the path");
  });

  it("renders a cycle's own hops once, not again as the trail that reached it", () => {
    /* one -> two -> one: the hop that required `two` is both part of the cycle
     * and the trail the failure propagated along. */
    const one = targetDecl("one");
    const two = targetDecl("two");
    const deps = propertyDecl("deps");
    const circular = new CircularDependencyError("one", [
      { value: value("one"), property: deps, target: two },
      { value: value("two"), property: deps, target: one },
    ]);
    const twoFailure = new DependencyFailedError(two, circular);
    const oneFailure = new DependencyFailedError(one, new ReferenceFailedError(value("two"), deps, one, twoFailure));

    const [diag] = capture(oneFailure);
    expect(diag.message).to.equal("Circular dependency: 'one' depends on itself");
    expect((diag.notes ?? []).map(note => note.message)).to.deep.equal(["required by one deps"]);
    expect(diag.help ?? []).to.deep.equal([]);
  });

  it("shows one 'required by' trail per requesting root, not every path to it", () => {
    /* Diamond: fabr depends on core directly and via js (which depends on core);
     * core fails to compile. Both paths reach the same requested root (fabr), so
     * only the shortest trail should render — not both. */
    const core = targetDecl("core");
    const js = targetDecl("js");
    const fabr = targetDecl("fabr");
    const deps = propertyDecl("deps");

    const coreFailure = new DependencyFailedError(core, new ExecutionError("compile failed"));
    const coreFromFabr = new ReferenceFailedError(value(), deps, fabr, coreFailure);
    const coreFromJs = new ReferenceFailedError(value(), deps, js, coreFailure);
    const jsFailure = new DependencyFailedError(js, coreFromJs);
    const jsFromFabr = new ReferenceFailedError(value(), deps, fabr, jsFailure);
    const fabrFailure = new DependencyFailedError(fabr, MultiError.of([coreFromFabr, jsFromFabr]));

    const diagnostics = capture(fabrFailure);
    const coreDiag = diagnostics.find(d => d.message.startsWith("Failed to build core"));
    expect(coreDiag, "core failure reported once").to.not.equal(undefined);

    const requiredBy = (coreDiag?.notes ?? []).filter(n => n.message.startsWith("required by"));
    expect(requiredBy.map(n => n.message)).to.deep.equal(["required by fabr deps"]);
  });

  it("keeps a distinct trail per root when a shared failure is requested two ways", () => {
    /* Building both `app` and `lib` (a MultiError of the two requested targets),
     * each depending on the failing `dep`: one trail per requested root. */
    const dep = targetDecl("dep");
    const app = targetDecl("app");
    const lib = targetDecl("lib");
    const deps = propertyDecl("deps");

    const depFailure = new DependencyFailedError(dep, new ExecutionError("boom"));
    const fromApp = new ReferenceFailedError(value(), deps, app, depFailure);
    const fromLib = new ReferenceFailedError(value(), deps, lib, depFailure);
    const appFailure = new DependencyFailedError(app, fromApp);
    const libFailure = new DependencyFailedError(lib, fromLib);

    const diagnostics = capture(MultiError.of([appFailure, libFailure]));
    const depDiag = diagnostics.find(d => d.message.startsWith("Failed to build dep"));
    expect(depDiag, "shared failure reported once").to.not.equal(undefined);
    const requiredBy = (depDiag?.notes ?? []).filter(n => n.message.startsWith("required by")).map(n => n.message);
    expect([...requiredBy].sort((a, b) => a.localeCompare(b))).to.deep.equal(["required by app deps", "required by lib deps"]);
  });

  it("renders a same-source conflict's chain once, then lists both files", () => {
    /* A case-collision within one package: both sides share the origin and key,
     * so the breadcrumb is identical — render it once, not per side. */
    registerProvenanceRenderer("test-chain", () => [{ message: "A -> B" }]);
    const origin = { kind: "test-chain" };
    const conflict = new ConflictError(
      "case-colliding names",
      "node_modules/pkg/readme.md",
      { provenance: origin, detail: "node_modules/pkg/README.md" },
      { provenance: origin, detail: "node_modules/pkg/readme.md" }
    );
    const [diag] = capture(conflict);
    expect((diag.notes ?? []).map(n => n.message)).to.deep.equal([
      "A -> B",
      "at node_modules/pkg/README.md",
      "at node_modules/pkg/readme.md",
    ]);
  });

  it("renders both chains for a genuine two-source conflict", () => {
    registerProvenanceRenderer("test-left", () => [{ message: "left-chain" }]);
    registerProvenanceRenderer("test-right", () => [{ message: "right-chain" }]);
    const conflict = new ConflictError(
      "files",
      "x",
      { provenance: { kind: "test-left" }, detail: "a" },
      { provenance: { kind: "test-right" }, detail: "b" }
    );
    const [diag] = capture(conflict);
    expect((diag.notes ?? []).map(n => n.message)).to.deep.equal(["left-chain", "at a", "right-chain", "at b"]);
  });

  it("names the operation's verb and the target type when no rule matched", () => {
    /* `fabr build` on a run-only targetdef (js_script) — the habitual first
     * mistake, so its wording is worth pinning. */
    const err = new NoRuleFoundError(targetDecl("tool", "js_script"), Constraints.of({ [BUILD_OPERATION]: "build", HOST: HOST_TRIPLE }));
    const [diag] = capture(err, AMBIENT);
    expect(diag.message).to.equal("Cannot build 'tool': no rule matches target type 'js_script'");
  });

  it("annotates a no-rule failure with the explicit constraints only", () => {
    /* The constraint set carries the run's ambient facts too; only the explicit
     * overrides are worth showing (and the set is a Constraints, not a record —
     * enumerating it as one rendered its private field). */
    const constraints = Constraints.of({ [BUILD_OPERATION]: "test", HOST: HOST_TRIPLE, BUILD_TYPE: "release" });
    const [diag] = capture(new NoRuleFoundError(targetDecl("lib"), constraints), AMBIENT);
    expect(diag.message).to.equal("Cannot test 'lib': no rule matches target type 'js_package' (BUILD_TYPE=release)");
  });
});
