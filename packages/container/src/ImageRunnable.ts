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
 * own, which Docker refuses), where the container engine does not hold it;
 * then run it under a minimal init, which passes signals on to the program
 * (the kernel ignores those sent to a PID 1 that does not handle them), removed
 * when it ends, its stdin attached and a terminal given it
 * where stdin is one, each port of `$3` (`8080/tcp 53/udp`) published on the
 * same port of the host, the rest of the arguments its own. The container is
 * named for the launch fabr gave it (`FABR_LAUNCH`), so the runnable's
 * teardown removes it; launched otherwise, for host `$1` and this script's
 * pid, which `exec` makes the engine client's. Either way a run killed before
 * removing it is reaped by a later one.
 */
export const LAUNCH_SCRIPT = `#!/bin/sh
set -e
here=$(cd "$(dirname "$0")" && pwd)
name="fabr-\${FABR_LAUNCH:-$1-$$-run}"
image="$2"
publish=""
for port in $3; do
  publish="$publish -p \${port%/*}:$port"
done
shift 3
if ! "$here/${ENGINE_COMMAND}" image inspect "$image" >/dev/null 2>&1; then
  (cd "$here/${LAYOUT_DIR}" && COPYFILE_DISABLE=1 tar --no-xattrs -cf - .) | "$here/${ENGINE_COMMAND}" load -q >/dev/null
fi
if [ -t 0 ]; then
  exec "$here/${ENGINE_COMMAND}" run --rm --init -i -t --name "$name" $publish "$image" "$@"
fi
exec "$here/${ENGINE_COMMAND}" run --rm --init -i --name "$name" $publish "$image" "$@"
`;

/** Remove the launch's container, whether or not it is still running: what the runnable's teardown runs. */
const TEARDOWN: readonly RunnableArgument[] = ["/bin/sh", "-c", 'exec "$0" rm -f "fabr-$FABR_LAUNCH" >/dev/null 2>&1', [{ installPath: ENGINE_COMMAND }]];

/**
 * Make `image` a program the container engine `engine` runs (Docker or
 * podman): its install the image's OCI layout (its layers the stored files,
 * so staged by hardlink), tagged `localhost/fabr/<name>:<config digest>`, the
 * engine, and a launcher that loads the layout only where the engine lacks the
 * tag, then runs it with the caller's arguments after the image's entrypoint,
 * each port its config exposes published on the same port of the host.
 */
export function imageRunnable(image: ImageFileSet, name: string, engine: RunnableFileSet, limit: Semaphore): Computable<RunnableFileSet> {
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
      return RunnableFileSet.forEntry(install, LAUNCHER, [ownerHost(), tag, exposedPorts(image).join(" ")], "sh").withTeardown(TEARDOWN);
    });
  });
}

/** @return the ports `image`'s config exposes (`8080/tcp`), sorted. */
function exposedPorts(image: ImageFileSet): string[] {
  const config = image.config.document.config;
  const exposed = config !== null && typeof config === "object" ? (config as Record<string, unknown>).ExposedPorts : undefined;
  return exposed !== null && typeof exposed === "object" ? Object.keys(exposed).filter(port => /^\d+\/(tcp|udp|sctp)$/.test(port)).sort() : [];
}

/** Reap what dead runs left in the engine `engine` is, where it is a program of this host. */
function reapEngine(limit: Semaphore, engine: RunnableFileSet): Computable<void> {
  const [program] = [...engine].map(([, file]) => file);
  return program instanceof HostLink ? reapContainers(limit, program.location, hostEnvironment()) : Computable.resolve(undefined);
}

/** @return the container engine `engine` is as the one file of the install named `engine`. */
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
