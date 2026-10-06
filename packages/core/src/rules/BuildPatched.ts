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

/**
 * The generic `patched` target: `srcs` with `patches` applied. What it
 * yields has the shape of what it was given — one package in is a package
 * out, named as this target is, at the same version and with the same
 * requirements, its files patched; anything else is the patched union of the
 * files. Named after the package it patches, it is that package to everything
 * built with it.
 *
 * `srcs` are instantiated, not required: a package named in a repository is
 * taken on its own, carrying what it declares for the consumer's collection
 * point to resolve. A patch therefore changes a package's files and nothing
 * else — its manifest included, as a file.
 */

import * as fs from "fs";
import * as path from "path";
import { ActionContext } from "../core/BuildCache";
import { BuildAction, BuildResult, fileSetInput, IBuildActionDefinition, stringConfig, stringListConfig } from "../core/BuildAction";
import { Computable } from "../core/Computable";
import { FabrError, MultiError, toError } from "../core/Errors";
import { FileSet } from "../core/FileSet";
import { PackageFileSet } from "../core/PackageFileSet";
import { getResultFileSet, writeFileSet } from "../core/Staging";
import { SymlinkFile } from "../core/SymlinkFile";
import { BUILD_OPERATION } from "../model/Constraints";
import { TargetContext } from "../model/BuildContext";
import { ITaskReport } from "../support/Execute";
import { FilePatch, parsePatchFile } from "../support/Patch";
import { RuleDefinition, RuleResult } from "./Types";

/** The path components a patch's names lose: the `a/`…`b/` git writes. */
const STRIP = 1;

function patched(context: TargetContext): Computable<RuleResult> {
  return context.collect({ srcs: context.getInstantiatedFileProperty("srcs"), patches: context.getFileProperty("patches") }).then(({ srcs, patches }) => {
    if (patches.length === 0) {
      throw new FabrError("a 'patched' target requires 'patches'");
    }
    /* Written order: each patch applies to what the ones before it left. */
    const order = patches.flatMap(set => [...set].map(([name]) => name).sort());
    const action = new BuildAction(PATCH_ACTION, { files: FileSet.unionAll(...srcs), patches: FileSet.unionAll(...patches) }, { order, strip: String(STRIP) });
    const [only] = srcs;
    /* One package's files are patched as files and are a package again: this
     * target's, at the version and with the requirements of the one it was
     * made from, which are not the patch's to change. Not what any reference
     * names, so it carries none. */
    return srcs.length === 1 && only instanceof PackageFileSet
      ? action.withReshape(files => new PackageFileSet(files, context.name, only.version, only.dependencies, only.origin, only.provided))
      : action;
  });
}

function runPatch(action: BuildAction, ctx: ActionContext, report: ITaskReport): Computable<BuildResult> {
  const files = fileSetInput(action, "files");
  const patches = fileSetInput(action, "patches");
  const strip = Number(stringConfig(action, "strip"));
  const links = new FileSet(new Map([...files].filter(([, file]) => file instanceof SymlinkFile)));
  const regular = new FileSet(new Map([...files].filter(([, file]) => !(file instanceof SymlinkFile))));
  const texts = stringListConfig(action, "order").map(name => patches.getFile(name)!.readString().then(text => ({ name, text })));
  return ctx
    .admit(report, () => writeFileSet(ctx.workDir, regular, { copy: true }))
    .then(() => Computable.forAll(texts, (...read) => read))
    .then(read => {
      const failures: Error[] = [];
      for (const { name, text } of read) {
        try {
          for (const change of parsePatchFile(text, `patch '${name}'`, strip)) {
            try {
              applyChange(ctx.workDir, links, change, name);
            } catch (err) {
              failures.push(toError(err));
            }
          }
        } catch (err) {
          failures.push(toError(err));
        }
      }
      if (failures.length > 0) {
        throw MultiError.of(failures);
      }
    })
    .then(() => ctx.admit(report, () => getResultFileSet(ctx.workDir, "**")))
    .then(result => ({ result: FileSet.unionAll(result, links) }));
}

/** Apply one file's change to the tree staged at `root`. */
function applyChange(root: string, links: FileSet, change: FilePatch, patch: string): void {
  const refuse = (name: string, why: string): never => {
    throw new FabrError(`patch '${patch}' does not apply to '${name}': ${why}`);
  };
  const located = (name: string): string => {
    if (links.getFile(name) !== undefined) {
      refuse(name, "it is a symbolic link");
    }
    return path.join(root, name);
  };
  const exists = (file: string): boolean => fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true;
  const { from, to } = change;
  const source = from === undefined ? undefined : located(from);
  const target = to === undefined ? undefined : located(to);
  if (source !== undefined && !exists(source)) {
    refuse(from!, "there is no such file");
  }
  if (target !== undefined && target !== source && exists(target)) {
    refuse(to!, from === undefined ? "the file it creates already exists" : `the file it renames '${from}' to already exists`);
  }
  const before = source === undefined ? Buffer.alloc(0) : fs.readFileSync(source);
  const text = before.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(before)) {
    refuse(from!, "it is not a text file");
  }
  const after = change.apply(text);
  if (target === undefined) {
    fs.rmSync(source!);
    return;
  }
  const mode = change.mode ?? (source === undefined ? undefined : fs.statSync(source).mode & 0o7777);
  if (source !== undefined && source !== target) {
    fs.rmSync(source);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, after, "utf8");
  if (mode !== undefined) {
    fs.chmodSync(target, mode);
  }
}

export const PATCH_ACTION: IBuildActionDefinition = { id: "core:patch", version: 1, run: runPatch };

export const patchedRule: RuleDefinition = { type: "patched", properties: { [BUILD_OPERATION]: "build" }, evaluate: patched };
