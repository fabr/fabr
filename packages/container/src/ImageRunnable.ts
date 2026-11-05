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

import { Computable, FabrError, FileSet, HostLink, IFile, MemoryFile, RunnableArgument, RunnableFileSet, Semaphore } from "@fabr-build/core";
import { ownerHost, reapContainers } from "./Containers";
import { hostEnvironment } from "./HostEnvironment";
import { ImageFileSet } from "./ImageFileSet";
import { imageLayout, manifestOf } from "./OciLayout";

/** Where the image's layout is in the install of a runnable image, and the other names there. */
const LAYOUT_DIR = "layout";
const LAUNCHER = "launch.sh";
const ENGINE_COMMAND = "engine";

/**
 * Load the image `$2` from the layout beside this script, streamed as an
 * archive with no extended attributes (macOS's tar would otherwise add its
 * own, which Docker refuses), where the container engine does not hold it,
 * removing the other tags of its repository (the program's earlier images) but
 * the one loaded most recently before it, and any a container still uses;
 * then run it under a minimal init, which passes signals on to the program
 * (the kernel ignores those sent to a PID 1 that does not handle them), removed
 * when it ends, its stdin attached and a terminal given it where stdin is one.
 * The `$3` arguments after it are the engine's options for the run (`-p
 * 8080:8080/tcp`, `-e NAME=value`), and the rest are the program's own. The
 * container is named for the launch fabr gave it (`FABR_LAUNCH`), so the
 * runnable's teardown removes it; launched otherwise, for host `$1` and this
 * script's pid, which `exec` makes the engine client's. Either way a run
 * killed before removing it is reaped by a later one.
 */
export const LAUNCH_SCRIPT = `#!/bin/sh
set -e
here=$(cd "$(dirname "$0")" && pwd)
name="fabr-\${FABR_LAUNCH:-$1-$$-run}"
image="$2"
options="$3"
shift 3
# Rotate the arguments, putting the image between the options and the rest.
total=$#
at=0
while [ "$at" -lt "$total" ]; do
  if [ "$at" -eq "$options" ]; then set -- "$@" "$image"; fi
  set -- "$@" "$1"
  shift
  at=$((at + 1))
done
if [ "$options" -eq "$total" ]; then set -- "$@" "$image"; fi
if ! "$here/${ENGINE_COMMAND}" image inspect "$image" >/dev/null 2>&1; then
  (cd "$here/${LAYOUT_DIR}" && COPYFILE_DISABLE=1 tar --no-xattrs -cf - .) | "$here/${ENGINE_COMMAND}" load -q >/dev/null
  "$here/${ENGINE_COMMAND}" image ls "\${image%:*}" --format '{{.Repository}}:{{.Tag}}' | grep -vxF "$image" | while read -r old; do
    echo "$("$here/${ENGINE_COMMAND}" image inspect -f '{{.Metadata.LastTagTime}}' "$old" 2>/dev/null) $old"
  done | sort -r | tail -n +2 | while read -r line; do
    "$here/${ENGINE_COMMAND}" rmi "\${line##* }" >/dev/null 2>&1 || true
  done
fi
if [ -t 0 ]; then
  exec "$here/${ENGINE_COMMAND}" run --rm --init -i -t --name "$name" "$@"
fi
exec "$here/${ENGINE_COMMAND}" run --rm --init -i --name "$name" "$@"
`;

/** The runnable's teardown: the command removing the launch's container, whether or not it is still running. */
const TEARDOWN: readonly RunnableArgument[] = ["/bin/sh", "-c", 'exec "$0" rm -f "fabr-$FABR_LAUNCH" >/dev/null 2>&1', [{ installPath: ENGINE_COMMAND }]];

/** How a program runs its image: the engine's options for the run, and its arguments. */
export interface IContainerRun {
  /** Ports published on the host (`8080:80`, `5353:53/udp`); none, each the image exposes on the same port. */
  readonly ports?: readonly string[];
  /** Environment variables, set over the image's. */
  readonly env: ReadonlyArray<readonly [string, string]>;
  /** The network the container joins. */
  readonly network?: string;
  /** Names added to the container's hosts file, each with its address. */
  readonly hosts: ReadonlyArray<readonly [string, string]>;
  /** Arguments given the image's entry, before any its caller gives. */
  readonly args: readonly string[];
}

/** The run of an image named on its own: its exposed ports published, nothing else set. */
const IMAGE_RUN: IContainerRun = { env: [], hosts: [], args: [] };

/**
 * Make `image` a program the container engine `engine` runs (Docker or
 * podman): its install the image's OCI layout (its layers the stored files,
 * so staged by hardlink), tagged `localhost/fabr/<name>:<config digest>`, the
 * engine, and a launcher that loads the layout only where the engine lacks the
 * tag, then runs it as `run` says, with the caller's arguments after the
 * image's entrypoint and `run`'s own.
 */
export function imageRunnable(image: ImageFileSet, name: string, engine: RunnableFileSet, limit: Semaphore, run: IContainerRun = IMAGE_RUN): Computable<RunnableFileSet> {
  return reapEngine(limit, engine)
    .then(() => manifestOf(image))
    .then(({ config }) => {
    const tag = `localhost/fabr/${imageName(name)}:${config.digest.substring("sha256:".length, "sha256:".length + 12)}`;
    return imageLayout(image, tag).then(layout => {
      const install = FileSet.unionAll(
        layout.mountedAt(LAYOUT_DIR),
        engineProgram(name, engine),
        new FileSet(new Map<string, IFile>([[LAUNCHER, new MemoryFile(Buffer.from(LAUNCH_SCRIPT), 0o755)]]))
      );
      const options = runOptions(image, run);
      return RunnableFileSet.forEntry(install, LAUNCHER, [ownerHost(), tag, String(options.length), ...options, ...run.args], "sh").withTeardown(TEARDOWN);
    });
  });
}

/** @return the engine's options for running `image` as `run` says. */
function runOptions(image: ImageFileSet, run: IContainerRun): string[] {
  const published = run.ports ?? exposedPorts(image).map(port => `${port.substring(0, port.indexOf("/"))}:${port}`);
  return [
    ...published.flatMap(port => ["-p", port]),
    ...run.env.flatMap(([variable, value]) => ["-e", `${variable}=${value}`]),
    ...(run.network === undefined ? [] : ["--network", run.network]),
    ...run.hosts.flatMap(([host, address]) => ["--add-host", `${host}:${address}`]),
  ];
}

/** @return the ports `image`'s config exposes (`8080/tcp`), sorted. */
function exposedPorts(image: ImageFileSet): string[] {
  const config = image.config.document.config;
  const exposed = config !== null && typeof config === "object" ? (config as Record<string, unknown>).ExposedPorts : undefined;
  return exposed !== null && typeof exposed === "object" ? Object.keys(exposed).filter(port => /^\d+\/(tcp|udp|sctp)$/.test(port)).sort() : [];
}

/** Reap the containers dead runs left in `engine`, where it is a program of this host. */
function reapEngine(limit: Semaphore, engine: RunnableFileSet): Computable<void> {
  const [program] = [...engine].map(([, file]) => file);
  return program instanceof HostLink ? reapContainers(limit, program.location, hostEnvironment()) : Computable.resolve(undefined);
}

/** @return the install holding `engine`'s one program, named {@link ENGINE_COMMAND}. */
function engineProgram(name: string, engine: RunnableFileSet): FileSet {
  const files = [...engine].map(([, file]) => file);
  if (files.length !== 1) {
    throw new FabrError(`CONTAINER_ENGINE, for running ${name}, is no single program`).withHelp("name the program, as in '@host:docker' or '@host:podman'");
  }
  return new FileSet(new Map<string, IFile>([[ENGINE_COMMAND, files[0]]]));
}

/** @return `name` as a repository name Docker accepts: lowercase, other characters as `-`. */
function imageName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._/-]+/g, "-").replace(/^[^a-z0-9]+/, "") || "image";
}
