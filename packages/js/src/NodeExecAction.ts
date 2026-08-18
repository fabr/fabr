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
import { PNP_DATA_FILE, pnpManifestOf, TREE_MOUNT } from "./PnPManifest";

/**
 * The JS ecosystem's build step, and the one place that owns **how a JS tool
 * reaches its dependencies**: make them reachable, then run it — core's generic
 * `exec` with the one thing every JS tool needs in front of it. Which
 * arrangement is the {@link PNP}/{@link FLAT}/{@link SCOPED} choice, and having
 * all three here is the point: one step owns the question, so a rule says which
 * answer it wants and nothing else.
 *
 * Doing it here rather than in the rule is what makes it free on a cache hit.
 * The rule hands the *packages* over as delivered; the key names each by
 * identity (see `manifestPackageInputs`) plus the layout token, and what this
 * step makes of them is a pure function of those — which is what lets the key
 * be computed without building anything. Evaluation therefore does no
 * filesystem work at all, and a hit does none either.
 *
 * A layout conflict therefore surfaces on the miss that would have produced it,
 * not during evaluation. That is the same set of runs: a hit is proof the same
 * inputs assembled cleanly, and anything that introduces a conflict changes an
 * input and so misses. The packages carry their `origin` in, so the diagnostic
 * keeps its provenance.
 */
export const NODE_EXEC_ACTION: IBuildActionDefinition = {
  id: "js:exec",
  /* Tracks the exec body this delegates to, plus this step's own layouts; add
   * a `+ N` when what a layout produces changes. */
  version: EXEC_ACTION.version + 1,
  run: (inputs: BuildActionInputs, ctx: IActionContext): Computable<FileSet> => {
    const deps = fileSetsInput(inputs, "deps");
    const files = fileSetInput(inputs, "files");
    const exec = (staged: FileSet): Computable<FileSet> =>
      EXEC_ACTION.run(
        { files: staged, argv: stringListInput(inputs, "argv"), outputs: stringInput(inputs, "outputs") },
        ctx
      );
    if (stringInput(inputs, "layout") !== PNP) {
      const mount = stringInput(inputs, "mount");
      const layout = stringInput(inputs, "layout") === SCOPED ? assembleScopedNodeModules(deps) : assembleNodeModules(deps);
      return exec(FileSet.unionAll(files, FileSet.layout({ [mount]: layout })));
    }
    /* Nothing is laid out: the packages become trees in the cache's pool, and
     * what each of them SEES is a row in the table staged beside the sources.
     * Materializing them is this step's work like any other layout's — so a hit
     * touches the pool not at all, and a pool wiped between builds heals on the
     * next miss that needs it rather than on every evaluation. */
    const manifest = pnpManifestOf(deps, selfPackage(inputs));
    return Computable.forAll(
      manifest.packages.map(pkg => ctx.ensureTree(pkg)),
      (...trees: string[]) =>
        exec(
          FileSet.unionAll(
            files,
            FileSet.layout({
              [PNP_DATA_FILE]: manifest.toFile(),
              /* The pool itself, mounted once: the manifest addresses trees by
               * name, so one mount serves every row, and a table with no rows
               * needs no mount at all. */
              ...(trees.length > 0 ? { [TREE_MOUNT]: ctx.treePool } : {}),
            })
          )
        )
    );
  },
};

/**
 * How a tool reaches its dependencies. Three peers, one choice per rule:
 *
 * - `pnp` — no tree at all: each package is materialized once in the cache's
 *   tree pool and a generated PnP table says what resolves to what. The
 *   strictest and by far the cheapest (a step stages only its own sources), and
 *   what every tool fabr can hand a manifest to uses.
 * - `flat` — every package hoisted at the mount point, transitives visible.
 *   What a tool that merely needs its inputs resolvable wants (a runnable
 *   install, a test install), and where the future `resolution/node_modules`
 *   flag will map a tool that must see a real tree.
 * - `scoped` — the consuming sources see only their DIRECT deps, the closure
 *   living in a hidden area they resolve through, so an undeclared transitive
 *   import fails. Strictness for a filesystem-resolving compiler; see
 *   {@link assembleScopedNodeModules} for what that costs and who must pay it.
 */
export const PNP = "pnp";
export const FLAT = "flat";
export const SCOPED = "scoped";

/** The layout tokens, for a caller that validates one. */
export type NodeLayout = typeof PNP | typeof FLAT | typeof SCOPED;

/**
 * @param files everything the rule lays out itself — sources, the tool's own
 *   mount, generated manifests — named relative to the working directory.
 * @param deps the packages to assemble, as delivered (packages, flags and
 *   loose content), NOT assembled.
 * @param mount where an ASSEMBLED layout goes (`node_modules` for anything node
 *   resolves through; its own directory for a tool with a private convention).
 *   Unused by `pnp`, which mounts nothing.
 * @param self under `pnp` only: the package identity the staged sources
 *   themselves carry, so they can resolve their own name. Its parts are
 *   ordinary inputs, so they key like everything else.
 */
export function createNodeExecAction(
  files: FileSet,
  deps: FileSet[],
  argv: string[],
  outputs: string,
  options: { mount?: string; layout?: NodeLayout; label?: string; self?: { name: string; location: string } } = {}
): BuildAction {
  return new BuildAction(
    NODE_EXEC_ACTION,
    {
      files,
      deps,
      argv,
      outputs,
      mount: options.mount ?? "node_modules",
      layout: options.layout ?? FLAT,
      ...(options.self ? { selfName: options.self.name, selfLocation: options.self.location } : {}),
    },
    options.label
  );
}

/** The `self` inputs as the pnp arm reads them back: absent unless the rule
 * gave the sources a package identity. */
function selfPackage(inputs: BuildActionInputs): { name: string; location: string } | undefined {
  const name = inputs.selfName;
  const location = inputs.selfLocation;
  return typeof name === "string" && typeof location === "string" ? { name, location } : undefined;
}

/** The `deps` input: the direct deps as delivered, which the step assembles. */
function fileSetsInput(inputs: BuildActionInputs, name: string): FileSet[] {
  const value = inputs[name];
  if (!Array.isArray(value) || value.some(element => !(element instanceof FileSet))) {
    throw new Error(`Input '${name}' must be a list of filesets`);
  }
  return value as FileSet[];
}
