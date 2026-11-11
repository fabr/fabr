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

import * as fs from "fs";
import * as path from "path";
import {
  ActionContext,
  Computable,
  execute,
  executeInternalCapture,
  FabrError,
  hostEnvironment,
  IFile,
  IOutputHandle,
  ITaskReport,
  MemoryFile,
  normalizeEntryName,
  TarExtract,
  TarPack,
  writeFileSet,
} from "@fabr-build/core";
import { ImageFileSet } from "./ImageFileSet";
import { indexLayer, teeOutput } from "./LayerIndex";
import { imageLayout, manifestOf } from "./OciLayout";
import { containerName, reapContainers, removeOnExit } from "./Containers";
import { IOciPlatform, platformText } from "./OciProtocol";

/** The time stamped on every entry of a layer a build command makes. */
const FIXED_MTIME = new Date(0);

/** The pax records of times other than the mtime, left out of a layer a build command makes. */
const TIME_RECORDS = new Set(["atime", "ctime"]);

/** What a build command changed, as `diff` reports it, reduced to what a layer needs. */
export interface IChangedPaths {
  /** The paths to copy out, absolute, sorted: each added tree once by its top, and each changed file. */
  readonly copies: readonly string[];
  /** The paths deleted, absolute, sorted: each deleted tree once by its top. */
  readonly deletions: readonly string[];
}

/**
 * Read an engine's `diff` (`A /path`, `C /path`, `D /path`, one a line, as
 * Docker and podman print it) as what a layer must hold: a path under an added
 * directory is covered by it; a changed path with changes below it is
 * a directory whose entries are listed themselves, so is not copied; a path
 * under a deleted directory is covered by its whiteout.
 */
export function changedPaths(diff: string): IChangedPaths {
  const kinds = new Map<string, string>();
  for (const line of diff.split("\n")) {
    const match = /^([ACD]) (\/.*)$/.exec(line.trimEnd());
    if (match !== null) {
      kinds.set(match[2], match[1]);
    }
  }
  const paths = [...kinds.keys()].sort();
  /* @return true if an ancestor of `p` was changed as `kind` says, otherwise false. */
  const under = (p: string, kind: string): boolean => {
    for (let at = path.posix.dirname(p); at !== "/" && at !== "."; at = path.posix.dirname(at)) {
      if (kinds.get(at) === kind) {
        return true;
      }
    }
    return false;
  };
  const hasBelow = (p: string): boolean => paths.some(other => other.startsWith(`${p}/`));
  const copies = paths.filter(
    p => (kinds.get(p) === "A" && !under(p, "A")) || (kinds.get(p) === "C" && !hasBelow(p) && !under(p, "A"))
  );
  const deletions = paths.filter(p => kinds.get(p) === "D" && !under(p, "D"));
  return { copies, deletions };
}

/** What runs a build command: the engine, the image's platform, and the command's environment. */
export interface IBuildCommand {
  /** The container engine's program, as an absolute path. */
  readonly engine: string;
  readonly platform: IOciPlatform;
  /** The shell command, run as `/bin/sh -c`. */
  readonly command: string;
  /** Environment variables the command runs with, over the image's. */
  readonly env: ReadonlyArray<readonly [string, string]>;
}

/**
 * Run `command` in `base` with the container engine, and write what it
 * changed as a layer under `dir`: the base loaded into the engine where the
 * engine lacks it, the command run in a container named for this process (the
 * containers dead runs left removed first), then each changed path copied out
 * and written, with a whiteout per deletion, owners and modes kept and times
 * fixed, indexed as it is written. The container is removed whatever happens.
 * The command's output is the step's.
 */
export function runBuildCommand(
  ctx: ActionContext,
  report: ITaskReport,
  base: ImageFileSet,
  build: IBuildCommand,
  dir: string
): Computable<{ records: ReadonlyMap<string, IFile>; diffId: string }> {
  const env = hostEnvironment();
  const name = containerName();
  const quiet = (args: string[]): Computable<{ status: number | null; stdout: string; stderr: string }> =>
    executeInternalCapture(ctx.processLimit, build.engine, args, "", env);
  return manifestOf(base)
    .then(({ config }) => `localhost/fabr/build-base:${config.digest.substring("sha256:".length, "sha256:".length + 12)}`)
    .then(tag => reapContainers(ctx.processLimit, build.engine, env).then(() => tag))
    .then(tag => {
      /* Removed whatever happens: here, or as fabr exits where it is cut short. */
      const release = removeOnExit(build.engine, name, env);
      return loadBase(ctx, report, base, build.engine, tag, env)
        .then(() =>
          execute(
            ctx.processLimit,
            build.engine,
            [
              "run",
              "--name",
              name,
              "--platform",
              platformText(build.platform),
              ...build.env.flatMap(([key, value]) => ["-e", `${key}=${value}`]),
              "--entrypoint",
              "/bin/sh",
              tag,
              "-c",
              build.command,
            ],
            ctx.workDir,
            env,
            report
          )
        )
        .then(() => quiet(["diff", name]))
        .then(({ status, stdout, stderr }) => {
          if (status !== 0) {
            throw new FabrError(`cannot read what the build command changed: ${stderr.trim()}`);
          }
          const changes = changedPaths(stdout);
          return copyOut(ctx, report, build.engine, name, changes.copies, env).then(copies =>
            writeChanges(ctx.createOutput(), changes.deletions, copies, `${dir}/layer.tar`)
          );
        })
        .finally(() => quiet(["rm", "-f", name]).then(release));
    });
}

/** Load `base` into the engine under `tag`, where the engine lacks it: its layout, staged, streamed into `load`. */
function loadBase(
  ctx: ActionContext,
  report: ITaskReport,
  base: ImageFileSet,
  engine: string,
  tag: string,
  env: Record<string, string>
): Computable<void> {
  return executeInternalCapture(ctx.processLimit, engine, ["image", "inspect", tag], "", env).then(({ status }) => {
    if (status === 0) {
      return Computable.resolve<void>(undefined);
    }
    const layoutDir = path.join(ctx.workDir, "base-layout");
    return imageLayout(base, tag)
      .then(layout => writeFileSet(layoutDir, layout))
      .then(() =>
        execute(
          ctx.processLimit,
          "/bin/sh",
          ["-c", `cd "$LAYOUT" && COPYFILE_DISABLE=1 tar --no-xattrs -cf - . | "$ENGINE" load -q >/dev/null`],
          ctx.workDir,
          { ...env, LAYOUT: layoutDir, ENGINE: engine },
          { ...report, output: undefined }
        )
      );
  });
}

/** Copy each of `paths` out of the container as an archive in the work directory, and return the archives, by path. */
function copyOut(
  ctx: ActionContext,
  report: ITaskReport,
  engine: string,
  container: string,
  paths: readonly string[],
  env: Record<string, string>
): Computable<Array<{ path: string; archive: string }>> {
  if (paths.length === 0) {
    return Computable.resolve([]);
  }
  const archives = paths.map((p, index) => ({ path: p, archive: path.join(ctx.workDir, `changed-${index}.tar`) }));
  const script = archives
    .map(({ path: p, archive }) => `"$ENGINE" cp ${shellQuote(`${container}:${p}`)} - > ${shellQuote(archive)}`)
    .join(" && ");
  return execute(
    ctx.processLimit,
    "/bin/sh",
    ["-c", script],
    ctx.workDir,
    { ...env, ENGINE: engine },
    { ...report, output: undefined }
  ).then(() => archives);
}

/** Write the layer: a whiteout per deletion, then each copied archive's entries at their paths, times fixed; indexed as it is written. */
export function writeChanges(
  output: IOutputHandle,
  deletions: readonly string[],
  copies: ReadonlyArray<{ path: string; archive: string }>,
  name: string
): Computable<{ records: ReadonlyMap<string, IFile>; diffId: string }> {
  const indexer = indexLayer();
  const sink = teeOutput(output, indexer.sink);
  const pack = new TarPack();
  return Computable.from<void>((resolve, reject) => {
    pack.on("error", reject);
    pack.on("end", () => resolve());
    sink.stream.on("error", reject);
    pack.pipe(sink.stream, { end: false });
    const header = { mtime: FIXED_MTIME, uid: 0, gid: 0 };
    for (const deleted of deletions) {
      pack.entry(
        {
          ...header,
          name: entryName(path.posix.join(path.posix.dirname(deleted), `.wh.${path.posix.basename(deleted)}`)),
          mode: 0o644,
          size: 0,
        },
        Buffer.alloc(0)
      );
    }
    const next = (index: number): void => {
      if (index >= copies.length) {
        pack.finalize();
        return;
      }
      const { path: copied, archive } = copies[index];
      const within = path.posix.dirname(copied);
      const extract = new TarExtract();
      extract.on("entry", (entry, body, done) => {
        const at = (relative: string): string => entryName(path.posix.join(within, relative));
        /* Everything the entry carries goes into the layer (its pax records
         * and extended attributes among it, a file capability byte for byte),
         * bar its times. */
        const written = pack.entry(
          {
            ...entry,
            name: at(entry.name),
            linkname: entry.type === "link" ? at(entry.linkname) : entry.linkname,
            mtime: FIXED_MTIME,
            pax: new Map([...entry.pax].filter(([key]) => !TIME_RECORDS.has(key))),
          },
          err => (err ? reject(err) : done())
        );
        body.pipe(written);
      });
      extract.on("finish", () => next(index + 1));
      extract.on("error", reject);
      fs.createReadStream(archive).on("error", reject).pipe(extract);
    };
    next(0);
  }).then(
    () =>
      sink.finalize(name).then(layer => {
        const index = indexer.result();
        return {
          records: new Map<string, IFile>([
            [name, layer],
            [`${path.posix.dirname(name)}/index.json`, MemoryFile.from(JSON.stringify(index))],
          ]),
          diffId: index.diffId,
        };
      }),
    (err: Error) =>
      sink.discard().then(() => {
        throw err;
      })
  );
}

/** @return `absolute` as a layer's entry name, refusing one that leaves the image's filesystem. */
function entryName(absolute: string): string {
  const name = normalizeEntryName(absolute);
  if (name === undefined) {
    throw new FabrError(`a build command's change '${absolute}' leaves the image's filesystem`);
  }
  return name;
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
