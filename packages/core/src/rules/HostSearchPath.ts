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
 * `host_searchpath`: the programs of the machine fabr runs on, used where they
 * lie. A reference names a program as a shell would run it — a command
 * searched for on PATH (`@host:clang`), or an absolute path — and is answered
 * with that program as a runnable, identified by its content: what enters a key
 * is the program's hash, never its path (see {@link HostLink}).
 *
 * Only the program named is identified. What it runs in turn — a compiler's
 * assembler and linker, the headers and libraries it reads — is not, so a
 * change there alone is not seen.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Computable } from "../core/Computable";
import { FabrError, toError } from "../core/Errors";
import { FileSet, FileSource, IFile } from "../core/FileSet";
import { Name } from "../core/Name";
import { PartialRepositoryRef } from "../core/PartialRepositoryRef";
import { IProvenanceStep, registerProvenanceDescriber, registerProvenanceRenderer } from "../core/Provenance";
import { Repository, RepositoryLookup, RepositoryPublishRef, RepositoryRef } from "../core/Repository";
import { RunnableFileSet } from "../core/RunnableFileSet";
import { HostLink } from "../core/SymlinkFile";
import { findExecutable } from "../support/Execute";
import type { TargetContext } from "../context/index";
import { RepositoryImplementation, RepositoryRegistration } from "./Types";

const HOST_PROGRAM_PROVENANCE = "host-program";

/** A program of the host, and where it was found. */
interface IHostProgramOrigin extends IProvenanceStep {
  kind: typeof HOST_PROGRAM_PROVENANCE;
  location: string;
}

registerProvenanceRenderer(HOST_PROGRAM_PROVENANCE, step => [{ message: `found on this host, at ${(step as IHostProgramOrigin).location}` }]);
registerProvenanceDescriber(HOST_PROGRAM_PROVENANCE, step => (step as IHostProgramOrigin).location);

/** @return the real path of `location`, or `location` itself where it cannot be resolved. */
function realPathOf(location: string): string {
  try {
    return fs.realpathSync(location);
  } catch {
    return location;
  }
}

/** The repository a `host_searchpath` declaration is. */
export class HostSearchPathRepository implements Repository, RepositoryLookup {
  constructor(
    /** The host's files by absolute path (the run's {@link ExecutionContext.hostFileSource}). */
    private readonly files: FileSource
  ) {}

  /** Vend the reference to the program `name` names: a command name, or an absolute path. */
  public getRepositoryRef(name: Name): RepositoryRef | PartialRepositoryRef {
    const command = name.toBaseString();
    if (name.getMarker() !== undefined) {
      throw new FabrError(`'${name.toString()}' names a program of this host, so an override marker means nothing on it`).withHelp(
        "write the reference without the marker"
      );
    }
    /* On Windows a drive's `:` is part of an absolute path, and `\` separates its parts; any other `:` names no program. */
    const windows = process.platform === "win32";
    const drive = windows && /^[A-Za-z]:[\\/]/.test(command) ? 2 : 0;
    const isPath = command.includes("/") || (windows && command.includes("\\"));
    if (name.hasGlob() || command.length === 0 || command.includes(":", drive) || (isPath && !path.isAbsolute(command))) {
      throw new FabrError(`'${name.toString()}' is not the name of a program`).withHelp(
        "name a program as a shell runs it, as in '@host:clang', or by its absolute path"
      );
    }
    return new RepositoryRef(this, { name: command, versionConstraint: undefined, renameTo: name.getRenameTo()?.toString() });
  }

  public getRepositoryPublishRef(name: Name): RepositoryPublishRef {
    throw new FabrError(`this host's programs are not a publish destination (cannot sync to '${name.toString()}')`);
  }

  /** Resolve the program `reference` names to a runnable: the link to it, as its entry. */
  public resolve(reference: RepositoryRef): Computable<FileSet> {
    return this.resolveFiles(reference).then(files => RunnableFileSet.forEntry(files, commandOf(reference.name)));
  }

  /** Resolve the program `reference` names to its files: the one link to it, named as the command. */
  public resolveFiles(reference: RepositoryRef): Computable<FileSet> {
    const { name } = reference;
    try {
      /* A name with a `/` is a path, used as it is; any other is searched for on PATH. */
      const found = findExecutable(name);
      return this.files.get(found).then(file => {
        if (file === undefined) {
          throw new FabrError(`'${name}' was found at ${found}, which is no longer there`);
        }
        const origin: IHostProgramOrigin = { kind: HOST_PROGRAM_PROVENANCE, location: found };
        return new FileSet(new Map<string, IFile>([[commandOf(name), new HostLink(file.hash, realPathOf(found))]]), origin);
      });
    } catch (err) {
      return Computable.reject(toError(err));
    }
  }
}

/** @return the command a program named `name` is run as: its name, or the last part of its path. */
function commandOf(name: string): string {
  return path.basename(name);
}

/** @return the registration of the `host_searchpath` repository type. */
function hostSearchPathRegistration(): RepositoryRegistration {
  return {
    type: "host_searchpath",
    provider: (context: TargetContext) =>
      Computable.resolve(new HostSearchPathRepository(context.execution.hostFileSource)),
  };
}

/** The implementation STD.fabr's `repository` declaration names. */
export default { provider: hostSearchPathRegistration().provider } satisfies RepositoryImplementation;
