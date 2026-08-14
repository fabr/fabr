/*
 * Copyright (c) 2026 Nathan Keynes <nkeynes@deadcoderemoval.net>
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

import {
  BuildAction,
  BuildActionInputs,
  Computable,
  EXEC_ACTION,
  FileSet,
  fileSetInput,
  IActionContext,
  IBuildActionDefinition,
  stringInput,
  stringListInput,
} from "@fabr-build/core";
import { assembleNodeModules, assembleScopedNodeModules } from "./JSPackage";

/**
 * The JS ecosystem's build step: **assemble a node_modules from unassembled
 * packages, then run a tool over the result** — core's generic `exec` with the
 * one piece of layout every JS tool needs in front of it.
 *
 * Assembling is the step's own work rather than the rule's because it is
 * expensive (a large closure mounts hundreds of thousands of file entries) and
 * needed only when the entry has to be built. The rule hands the *packages*
 * over as delivered; the key names each by identity (see
 * `manifestPackageInputs`), and what this step assembles from them is a pure
 * function of those identities plus this step's version — which is what lets
 * the key be computed without doing the assembly.
 *
 * A layout conflict therefore surfaces on the miss that would have produced it,
 * not during evaluation. That is the same set of runs: a hit is proof the same
 * inputs assembled cleanly, and anything that introduces a conflict changes an
 * input and so misses. The packages carry their `origin` in, so the diagnostic
 * keeps its provenance.
 */
export const NODE_EXEC_ACTION: IBuildActionDefinition = {
  id: "js:exec",
  /* Tracks the exec body this delegates to; add a `+ 1` when the assembly below changes. */
  version: EXEC_ACTION.version,
  run: (inputs: BuildActionInputs, ctx: IActionContext): Computable<FileSet> => {
    const deps = fileSetsInput(inputs, "deps");
    const mount = stringInput(inputs, "mount");
    const assembled = stringInput(inputs, "layout") === SCOPED ? assembleScopedNodeModules(deps) : assembleNodeModules(deps);
    return EXEC_ACTION.run(
      {
        files: FileSet.unionAll(fileSetInput(inputs, "files"), FileSet.layout({ [mount]: assembled })),
        argv: stringListInput(inputs, "argv"),
        outputs: stringInput(inputs, "outputs"),
      },
      ctx
    );
  },
};

/**
 * How the packages are laid out under the mount point:
 *
 * - `scoped` — the consuming sources see only their DIRECT deps, the closure
 *   living in a hidden store they resolve through (so an undeclared transitive
 *   import fails). What a compile wants.
 * - `flat` — every package hoisted at the mount point, transitives visible.
 *   What a tool that merely needs its inputs resolvable wants.
 */
export const SCOPED = "scoped";
export const FLAT = "flat";

/**
 * @param files everything the rule lays out itself — sources, the tool's own
 *   mount, generated manifests — named relative to the working directory.
 * @param deps the packages to assemble, as delivered (packages, flags and
 *   loose content), NOT assembled.
 * @param mount where the assembled packages go (`node_modules` for anything
 *   node resolves through; its own directory for a tool with a private
 *   convention).
 */
export function createNodeExecAction(
  files: FileSet,
  deps: FileSet[],
  argv: string[],
  outputs: string,
  options: { mount?: string; layout?: typeof SCOPED | typeof FLAT; label?: string } = {}
): BuildAction {
  return new BuildAction(
    NODE_EXEC_ACTION,
    { files, deps, argv, outputs, mount: options.mount ?? "node_modules", layout: options.layout ?? FLAT },
    options.label
  );
}

/** The `deps` input: the direct deps as delivered, which the step assembles. */
function fileSetsInput(inputs: BuildActionInputs, name: string): FileSet[] {
  const value = inputs[name];
  if (!Array.isArray(value) || value.some(element => !(element instanceof FileSet))) {
    throw new Error(`Input '${name}' must be a list of filesets`);
  }
  return value as FileSet[];
}
