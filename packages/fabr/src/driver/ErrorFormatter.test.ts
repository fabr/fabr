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
  DependencyFailedError,
  ExecutionError,
  IDiagnosticNote,
  Log,
  MultiError,
  Name,
  ReferenceFailedError,
} from "@fabr/core";
import { DiagnosticErrorFormatter } from "./ErrorFormatter";

/* The AST decl types aren't exported, so recover them from the error constructors.
 * The formatter only reads name/offset/source, so partial stubs suffice (spans
 * aren't asserted — we inspect the raw notes), hence the `as unknown` casts. */
type TargetDecl = ConstructorParameters<typeof DependencyFailedError>[0];
type ValueDecl = ConstructorParameters<typeof ReferenceFailedError>[0];
type PropertyDecl = ConstructorParameters<typeof ReferenceFailedError>[1];

function targetDecl(name: string): TargetDecl {
  return { name, type: "js_package", typeOffset: 0, offset: 0, endOffset: 0, properties: [], source: {} } as unknown as TargetDecl;
}
function propertyDecl(name: string): PropertyDecl {
  return { name, values: [], offset: 0, endOffset: 0, source: {} } as unknown as PropertyDecl;
}
function value(): ValueDecl {
  return { value: Name.fromLiteral("x"), offset: 0, endOffset: 0, source: {} } as unknown as ValueDecl;
}

/** Capture the diagnostics the formatter emits, keeping message + notes. */
function capture(err: Error): Array<{ message: string; notes?: IDiagnosticNote[] }> {
  const out: Array<{ message: string; notes?: IDiagnosticNote[] }> = [];
  const log: Log = { log: (_diag, params) => out.push(params as unknown as { message: string; notes?: IDiagnosticNote[] }) };
  new DiagnosticErrorFormatter(new Set()).report(log, err);
  return out;
}

describe("DiagnosticErrorFormatter", () => {
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
});
