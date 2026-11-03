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

/* The esbuild metafile a bundle ships: esbuild's own document, with its paths
 * renamed so that none names a place in the step's staging. */

import * as path from "node:path";

/** An import as esbuild's metafile records it. */
interface IMetafileImport {
  path: string;
  external?: boolean;
  [field: string]: unknown;
}

/** An input file of the bundle, as esbuild's metafile records it. */
interface IMetafileInput {
  imports?: IMetafileImport[];
  [field: string]: unknown;
}

/** An output file of the bundle, as esbuild's metafile records it. */
interface IMetafileOutput {
  inputs?: Record<string, { bytesInOutput?: number; [field: string]: unknown }>;
  imports?: IMetafileImport[];
  entryPoint?: string;
  cssBundle?: string;
  [field: string]: unknown;
}

/** esbuild's metafile, typed in the fields renamed here. */
export interface IMetafile {
  inputs: Record<string, IMetafileInput>;
  outputs: Record<string, IMetafileOutput>;
  [field: string]: unknown;
}

/**
 * Rename the paths in esbuild's metafile, which name files relative to the
 * step's working directory: each input by `inputName` (the reference that
 * resolves to it, else the path as esbuild wrote it), and each output relative
 * to `outdir`. An external import keeps its specifier. Two inputs given one name
 * (two wirings of one file) are one input, the first kept, and an output's
 * bytes from them are summed.
 */
export function renameMetafilePaths(metafile: IMetafile, outdir: string, inputName: (staged: string) => string): IMetafile {
  const outputName = (staged: string): string => path.posix.relative(outdir.split(path.sep).join("/"), staged);
  const importsNamed = (imports: IMetafileImport[] | undefined, name: (staged: string) => string): IMetafileImport[] | undefined =>
    imports?.map(imported => (imported.external === true ? imported : { ...imported, path: name(imported.path) }));
  const inputs: Record<string, IMetafileInput> = Object.create(null);
  for (const [staged, input] of Object.entries(metafile.inputs)) {
    const name = inputName(staged);
    if (!(name in inputs)) {
      inputs[name] = { ...input, ...(input.imports ? { imports: importsNamed(input.imports, inputName) } : {}) };
    }
  }
  const outputs: Record<string, IMetafileOutput> = Object.create(null);
  for (const [staged, output] of Object.entries(metafile.outputs)) {
    const contributors: NonNullable<IMetafileOutput["inputs"]> = Object.create(null);
    for (const [input, contribution] of Object.entries(output.inputs ?? {})) {
      const name = inputName(input);
      const held = contributors[name];
      contributors[name] =
        held === undefined ? contribution : { ...held, bytesInOutput: (held.bytesInOutput ?? 0) + (contribution.bytesInOutput ?? 0) };
    }
    outputs[outputName(staged)] = {
      ...output,
      ...(output.inputs ? { inputs: contributors } : {}),
      ...(output.imports ? { imports: importsNamed(output.imports, outputName) } : {}),
      ...(output.entryPoint !== undefined ? { entryPoint: inputName(output.entryPoint) } : {}),
      ...(output.cssBundle !== undefined ? { cssBundle: outputName(output.cssBundle) } : {}),
    };
  }
  return { ...metafile, inputs, outputs };
}
