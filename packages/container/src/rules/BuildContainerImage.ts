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
  ActionContext,
  BuildAction,
  BuildResult,
  Computable,
  Constraints,
  defineRule,
  EMPTY_FILESET,
  FabrError,
  fileSetInput,
  FileSet,
  FileSource,
  HostLink,
  IBuildActionDefinition,
  IFile,
  IOutputHandle,
  isRepositoryCollection,
  isRepositoryReader,
  ITaskReport,
  MemoryFile,
  Property,
  PropertyMap,
  Repository,
  RepositoryLookup,
  RunnableFileSet,
  RepositoryRef,
  ResolvedNode,
  SourceRef,
  stringConfig,
  TargetRef,
  Unbuilt,
  TARGET,
  TargetContext,
  writeTar,
} from "@fabr-build/core";
import { IImageSettings, imageConfig } from "../ImageConfig";
import { ImageFileSet, ImageLibc, imageOfRecords, layerRecordDir, libcOf, RECORD_CONFIG } from "../ImageFileSet";
import { runBuildCommand } from "../BuildCommand";
import { indexLayer, teeOutput } from "../LayerIndex";
import { IOciPlatform } from "../OciProtocol";
import { OCI_TARGET, ociPlatformOf } from "../OciRepository";

/**
 * The `container_image` rule: `base`'s layers, reused as they are, and one
 * layer of `files` above them, with the target's settings applied to the
 * base's config. The base is what the image passes on: an image holds its
 * base, so what requires the image requires the base. Its `files` are resolved
 * for the image's platform, the C library the base has filled in, so native
 * packages are chosen for it: found along the chain of bases to the first one
 * pulled from a registry, which is fetched to read it, a base built in the
 * project never built for it.
 */
export default defineRule({
  requirements(context) {
    return Computable.forAll(
      [context.getGlobalString(OCI_TARGET), context.getFileProperty("base").then(sources => baseLibc(context.name, sources))] as const,
      (target: string, libc: ImageLibc | undefined) => ({
        requirements: {
          dependencies: context.getPackageProperty("base"),
          files: context.getFileProperty("files", Constraints.of({ [TARGET]: contentsTriple(target, libc) })),
        },
        builds: { package: context.name },
      })
    );
  },
  evaluateMaterialized(context, { dependencies: base, files }) {
    return Computable.forAll([context.getGlobalString(OCI_TARGET), settingsOf(context), context.getMap("env")] as const, (target: string, settings: IImageSettings, env: PropertyMap) => {
      const image = soleImage(context.name, base);
      const contents = FileSet.unionAll(...files);
      const platform = ociPlatformOf(target);
      const action = (on: ImageFileSet | undefined, made: IImageSettings, engine?: FileSet): BuildAction =>
        new BuildAction(
          IMAGE_ACTION,
          { base: on?.toRecords() ?? EMPTY_FILESET, files: contents, ...(engine === undefined ? {} : { engine }) },
          {
            settings: JSON.stringify(made),
            platform: JSON.stringify(platform),
            created_by: made.build === undefined ? `fabr container_image ${context.name}` : `/bin/sh -c ${made.build}`,
          }
        ).withReshape(output => imageOfRecords(output, context.name));
      if (settings.build === undefined) {
        return action(image, settings);
      }
      if (image === undefined) {
        throw new FabrError(`${context.name}'s build command has no image to run in`).withHelp("set 'base' to the image it runs in");
      }
      if (contents.size > 0 || setsMoreThanBuild(settings)) {
        /* The command's layer is a step of its own, so what is set beside it does not run it again. */
        return context
          .subTarget("container_image", { base: [image], build: settings.build, env }, { label: "Running build" })
          .then(built => action(built as ImageFileSet, { ...settings, build: undefined }));
      }
      return context.getGlobalRunnable("CONTAINER_ENGINE").then(engine => action(image, settings, engineProgram(context.name, engine)));
    });
  },
});

/** Read the image's settings from the target's properties. */
function settingsOf(context: TargetContext): Computable<IImageSettings> {
  const value = (name: string): Computable<Property | undefined> => context.getProperty(name);
  return Computable.forAll(
    [value("entry"), value("args"), value("workdir"), value("user"), value("ports"), context.getMap("env"), context.getMap("metadata"), value("build")] as const,
    (entry, args, workdir, user, ports, env: PropertyMap, metadata: PropertyMap, build): IImageSettings => ({
      ...(entry === undefined ? {} : { entry: entry.toString() }),
      args: args?.getValues() ?? [],
      ...(workdir === undefined ? {} : { workdir: workdir.toString() }),
      ...(user === undefined ? {} : { user: user.toString() }),
      env: stringEntries(context.name, "env", env),
      metadata: stringEntries(context.name, "metadata", metadata),
      ports: ports?.getValues() ?? [],
      ...(build === undefined ? {} : { build: build.toString() }),
    })
  );
}

/** @return true if `settings` set anything but the build command and its environment, otherwise false. */
function setsMoreThanBuild(settings: IImageSettings): boolean {
  return settings.entry !== undefined || settings.args.length > 0 || settings.workdir !== undefined || settings.user !== undefined || settings.ports.length > 0 || settings.metadata.length > 0;
}

/** Read a MAP property whose every entry is a string, in the order written. */
function stringEntries(target: string, property: string, map: PropertyMap): Array<[string, string]> {
  return [...map].map(([key, setting]): [string, string] => {
    if (!Array.isArray(setting) || !setting.every(item => typeof item === "string")) {
      throw new FabrError(`${target}'s ${property} '${key}' is not a string`);
    }
    return [key, (setting as string[]).join(" ")];
  });
}

/** @return the container engine `engine` is as the one file named `engine`. */
function engineProgram(target: string, engine: RunnableFileSet): FileSet {
  const files = [...engine].map(([, file]) => file);
  if (files.length !== 1 || !(files[0] instanceof HostLink)) {
    throw new FabrError(`CONTAINER_ENGINE, for ${target}'s build command, is no program of this host`).withHelp("name the program, as in '@host:docker' or '@host:podman'");
  }
  return new FileSet(new Map<string, IFile>([["engine", files[0]]]));
}

/** @return the image `bases` holds, or undefined where it holds none; anything else is an error. */
function soleImage(target: string, bases: ReadonlyArray<FileSource | Repository | FileSet>): ImageFileSet | undefined {
  if (bases.length === 0) {
    return undefined;
  }
  if (bases.length > 1 || !(bases[0] instanceof ImageFileSet)) {
    throw new FabrError(`${target}'s base must be one image`).withHelp("name an image, as in '@docker:debian:12-slim', or a container_image target");
  }
  return bases[0];
}

/**
 * Find the C library of the image `sources` names as a base, without building
 * anything: a base built in the project has its own base's, so the chain is
 * followed through the targets' nodes to the first image pulled from a
 * registry, whose layers are read. Undefined where there is no base, or the
 * chain ends in no image or one with no C library.
 */
function baseLibc(target: string, sources: SourceRef[]): Computable<ImageLibc | undefined> {
  if (sources.length === 0) {
    return Computable.resolve(undefined);
  }
  const [source] = sources;
  const nodes: Computable<ReadonlyArray<SourceRef | Unbuilt>> =
    sources.length > 1
      ? Computable.reject(new FabrError(`${target}'s base must be one image`))
      : source instanceof TargetRef
      ? source.nodes()
      : source instanceof RepositoryRef && !isRepositoryReader(source.source) && !isRepositoryCollection(source.source)
      ? (source.source as RepositoryLookup).resolve(source).then(node => [node])
      : Computable.resolve([source]);
  return nodes.then(([node]) => libcAlong(node));
}

/** Follow `node`'s chain of bases to the first that is not built in the project, and read its C library. */
function libcAlong(node: SourceRef | Unbuilt | undefined): Computable<ImageLibc | undefined> {
  if (node instanceof ResolvedNode && node.content.builds !== undefined) {
    return libcAlong(node.packages[0]);
  }
  const files = node instanceof ResolvedNode ? node.content.files() : Computable.resolve(node);
  return files.then(content => (content instanceof FileSet ? libcOf(content) : undefined));
}

/**
 * Make the triple an image's contents are resolved for: `target` with the C
 * library `libc` its base has, where `target` states none — musl where the
 * base has none, the usual static form — and `target` as it is where it
 * states one, which must be the base's.
 */
export function contentsTriple(target: string, libc: ImageLibc | undefined): string {
  const environment = target.split("-")[3];
  if (environment === undefined) {
    return `${target}-${libc ?? "musl"}`;
  }
  const stated = environment.includes("musl") ? "musl" : "gnu";
  if (libc !== undefined && libc !== stated) {
    throw new FabrError(`${OCI_TARGET} '${target}' states ${stated === "gnu" ? "glibc" : "musl"}, but the base image has ${libc === "gnu" ? "glibc" : "musl"}`).withHelp(
      `leave the C library out of ${OCI_TARGET} to take the base's, or choose a base built with it`
    );
  }
  return target;
}

/** Build the image: write `files` as a layer above `base`'s and apply the settings to its config, as records. */
function runImage(action: BuildAction, ctx: ActionContext, report: ITaskReport): Computable<BuildResult> {
  const base = fileSetInput(action, "base");
  const files = fileSetInput(action, "files");
  const settings = JSON.parse(stringConfig(action, "settings")) as IImageSettings;
  const platform = JSON.parse(stringConfig(action, "platform")) as IOciPlatform;
  const layers = new Set([...base].map(([name]) => name.split("/").slice(0, 2).join("/")).filter(dir => dir.startsWith("layers/"))).size;
  const layer: Computable<IWrittenLayer | undefined> =
    settings.build !== undefined
      ? imageOfRecords(base, "base").then(image =>
          runBuildCommand(
            ctx,
            report,
            image,
            {
              engine: (fileSetInput(action, "engine").getFile("engine") as HostLink).location,
              platform,
              command: settings.build!,
              env: settings.env,
            },
            layerRecordDir(layers)
          )
        )
      : files.size === 0
      ? Computable.resolve(undefined)
      : ctx.admit(report, () => writeLayer(files, ctx.createOutput(), layerRecordDir(layers)));
  const configText = base.getFile(RECORD_CONFIG)?.readString() ?? Computable.resolve(undefined);
  return Computable.forAll([layer, configText] as const, (written: IWrittenLayer | undefined, text: string | undefined) => {
    const config = imageConfig(
      text === undefined ? undefined : (JSON.parse(text) as Record<string, unknown>),
      platform,
      settings,
      written?.diffId,
      stringConfig(action, "created_by")
    );
    const records = new Map<string, IFile>([...base].filter(([name]) => name !== RECORD_CONFIG));
    for (const [name, file] of written?.records ?? []) {
      records.set(name, file);
    }
    records.set(RECORD_CONFIG, MemoryFile.from(JSON.stringify(config)));
    return { result: new FileSet(records) };
  });
}

/** A layer as written: its records, and its uncompressed digest. */
interface IWrittenLayer {
  readonly records: ReadonlyMap<string, IFile>;
  readonly diffId: string;
}

/** Write `files` as a layer's tar into `output`, indexing it as it is written, and return its records under `dir`. */
function writeLayer(files: FileSet, output: IOutputHandle, dir: string): Computable<IWrittenLayer> {
  const indexer = indexLayer();
  return writeTar(files, teeOutput(output, indexer.sink), `${dir}/layer.tar`, { directories: true }).then(tar => {
    const index = indexer.result();
    return {
      records: new Map<string, IFile>([
        [`${dir}/layer.tar`, tar],
        [`${dir}/index.json`, MemoryFile.from(JSON.stringify(index))],
      ]),
      diffId: index.diffId,
    };
  });
}

export const IMAGE_ACTION: IBuildActionDefinition = { id: "container:image", version: 1, run: runImage };
