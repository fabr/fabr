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
 */

/**
 * Fabr's TypeScript driver: the runtime executed (standalone, under node)
 * inside a js_compile build step. It compiles the staged `tsconfig.json` via
 * the compiler API instead of the `tsc` bin, for one reason — **module
 * resolution**. tsc has no PnP support and never will (microsoft/TypeScript
 * #28289); Yarn patches the package because it does not control invocation,
 * and fabr does, so the seam is a driver rather than a patch. Everything else
 * is deliberate CLI parity: same tsconfig, same diagnostics, same exit codes.
 *
 * Usage: `node tsc-driver.js` in the staged workspace (cwd), exactly as the
 * `tsc` bin would be run. With no `.pnp.data.json` beside the tsconfig it
 * resolves through the filesystem like the stock compiler — no fabr rule stages
 * a workspace without one any more, but the fallback costs nothing and is what
 * keeps this a drop-in for an ordinary tsconfig (and what the stub-compiler
 * test fixtures run through).
 *
 * Like the bundle driver, this file runs in the *build* process, not in fabr:
 * it `require`s typescript from its own staged install and must not depend on
 * @fabr-build/core at runtime. TypeScript's types are not available to compile
 * against here (typescript is a tool fabr fetches, not a dependency of this
 * package), so the slice of the API used is typed structurally below.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PnpResolver, splitSpecifier, typesPackageName } from "../pnp/PnPResolver";

/* Structural typing for the compiler API this driver uses. Opaque where the
 * shape is the compiler's business (diagnostics, source files, the program);
 * spelled out where this driver reads or builds a value. */
type Diagnostic = unknown;
type SourceFile = unknown;
type CompilerOptions = Record<string, unknown>;

interface IResolvedModule {
  resolvedFileName: string;
  extension?: string;
  isExternalLibraryImport?: boolean;
  packageId?: unknown;
}
interface IResolvedModuleWithFailedLookupLocations {
  resolvedModule?: IResolvedModule;
}
interface IResolvedTypeReferenceDirective {
  primary: boolean;
  resolvedFileName?: string;
  isExternalLibraryImport?: boolean;
}
interface IResolvedTypeReferenceDirectiveWithFailedLookupLocations {
  resolvedTypeReferenceDirective?: IResolvedTypeReferenceDirective;
}
interface IStringLiteralLike {
  text: string;
}
interface IFileReference {
  fileName: string;
}
interface IParsedCommandLine {
  options: CompilerOptions;
  fileNames: string[];
  errors: Diagnostic[];
  projectReferences?: unknown[];
}
interface IEmitResult {
  emitSkipped: boolean;
  diagnostics: readonly Diagnostic[];
}
interface IProgram {
  emit(targetSourceFile?: SourceFile, writeFile?: WriteFile): IEmitResult;
}
type WriteFile = (fileName: string, text: string, writeByteOrderMark: boolean) => void;

interface ICompilerHost {
  getCurrentDirectory(): string;
  writeFile: WriteFile;
  getCanonicalFileName(fileName: string): string;
  getNewLine(): string;
  resolveModuleNameLiterals?: (
    literals: readonly IStringLiteralLike[],
    containingFile: string,
    redirectedReference: unknown,
    options: CompilerOptions,
    containingSourceFile: SourceFile,
    reusedNames: readonly IStringLiteralLike[] | undefined
  ) => readonly IResolvedModuleWithFailedLookupLocations[];
  resolveLibrary?: (
    libraryName: string,
    resolveFrom: string,
    options: CompilerOptions,
    libFileName: string
  ) => IResolvedModuleWithFailedLookupLocations;
  resolveTypeReferenceDirectiveReferences?: (
    directives: readonly (string | IFileReference)[],
    containingFile: string,
    redirectedReference: unknown,
    options: CompilerOptions,
    containingSourceFile: SourceFile | undefined,
    reusedNames: readonly (string | IFileReference)[] | undefined
  ) => readonly IResolvedTypeReferenceDirectiveWithFailedLookupLocations[];
}
interface ITypeScript {
  version: string;
  sys: {
    newLine: string;
    useCaseSensitiveFileNames: boolean;
    fileExists(path: string): boolean;
    readFile(path: string, encoding?: string): string | undefined;
    readDirectory(path: string, extensions?: readonly string[], exclude?: readonly string[], include?: readonly string[], depth?: number): string[];
    getCurrentDirectory(): string;
  };
  getParsedCommandLineOfConfigFile(
    configFileName: string,
    optionsToExtend: CompilerOptions | undefined,
    host: unknown
  ): IParsedCommandLine | undefined;
  createCompilerHost(options: CompilerOptions, setParentNodes?: boolean): ICompilerHost;
  createProgram(options: { rootNames: readonly string[]; options: CompilerOptions; host: ICompilerHost; projectReferences?: unknown[] }): IProgram;
  getPreEmitDiagnostics(program: IProgram): readonly Diagnostic[];
  sortAndDeduplicateDiagnostics(diagnostics: readonly Diagnostic[]): readonly Diagnostic[];
  formatDiagnostics(diagnostics: readonly Diagnostic[], host: unknown): string;
  formatDiagnosticsWithColorAndContext(diagnostics: readonly Diagnostic[], host: unknown): string;
  resolveModuleName(
    moduleName: string,
    containingFile: string,
    options: CompilerOptions,
    host: unknown,
    cache?: unknown
  ): IResolvedModuleWithFailedLookupLocations;
  createModuleResolutionCache(currentDirectory: string, getCanonicalFileName: (name: string) => string, options?: CompilerOptions): unknown;
}

/** The compiler releases whose resolution hooks this driver installs
 * (`resolveModuleNameLiterals` landed in 5.0). An older one would silently
 * resolve through the filesystem — i.e. find nothing — so it fails loudly
 * instead. */
const MINIMUM_TYPESCRIPT = 5;

/** An emitted declaration file, in each of its spellings. */
const DECLARATION_FILE = /\.d\.[cm]?ts$/;

/** File extensions that carry no types: a package resolving to one of these has
 * no typings of its own, which is what sends the lookup on to `@types`. */
const UNTYPED = /\.[cm]?jsx?$/;

/** tsc's own exit codes, which fabr's step reports as the tool's outcome. */
const EXIT_OK = 0;
const EXIT_ERRORS_NO_OUTPUT = 1;
const EXIT_ERRORS = 2;

/**
 * Resolution against the manifest, installed on the compiler host.
 *
 * The package part of a specifier is answered by the table (the issuer's own
 * bindings, then the compilation's declared surface as a fallback); the file
 * part is then the compiler's ordinary business, which it does when handed the
 * resolved directory as a rooted specifier — so `main`/`types`/`exports`
 * handling, extension probing and `.d.ts` preference are the compiler's, not
 * this driver's.
 *
 * The `@types` retry is the compiler's own rule reproduced: a package whose
 * resolution yields no typings is followed by a lookup of its `@types` sidecar,
 * which in a node_modules tree tsc finds by walking up and here comes out of
 * the same table.
 */
function installResolution(ts: ITypeScript, host: ICompilerHost, options: CompilerOptions, resolver: PnpResolver, root: string): void {
  const cache = ts.createModuleResolutionCache(root, name => host.getCanonicalFileName(name), options);
  const through = (specifier: string, issuer: string): IResolvedModuleWithFailedLookupLocations | undefined => {
    const split = splitSpecifier(specifier);
    if (split === undefined) {
      return undefined;
    }
    const location = resolver.locationOf(split.name, issuer);
    if (location === undefined) {
      return undefined;
    }
    /* A rooted specifier is resolved by the compiler as a path rather than a
     * package name — which is exactly the "unqualified path" PnP hands back. */
    const resolved = ts.resolveModuleName(split.subpath ? path.join(location, split.subpath) : location, issuer, options, host, cache);
    return resolved.resolvedModule ? { resolvedModule: { ...resolved.resolvedModule, isExternalLibraryImport: true } } : undefined;
  };
  /* One answer per (asking package, specifier). A name means the same thing to
   * every file of one package — that is what the table says — so the file part
   * is probed once rather than once per import site: a compile asks tens of
   * thousands of times and holds hundreds of distinct answers. */
  const answers = new Map<string, IResolvedModuleWithFailedLookupLocations>();
  const resolveModule = (specifier: string, issuer: string): IResolvedModuleWithFailedLookupLocations => {
    const split = splitSpecifier(specifier);
    if (split === undefined) {
      /* Not a package reference: a relative or rooted path, or a `#` subpath
       * import, all of which are the compiler's own business and all bounded —
       * they probe where they are told, they do not search. */
      return ts.resolveModuleName(specifier, issuer, options, host, cache);
    }
    const key = `${resolver.locatorOf(issuer)}\0${specifier}`;
    const held = answers.get(key);
    if (held !== undefined) {
      return held;
    }
    /* A NAME is the table's business, exclusively. Asking the compiler first
     * would make it walk `node_modules` up from the issuer — through every
     * ancestor of the workspace and of the cache — finding nothing, on every
     * bare import of every file: the dominant cost of a compile, and a way for
     * a stray directory above the build to answer an undeclared import. */
    const primary = through(specifier, issuer);
    const typed =
      primary && !UNTYPED.test(primary.resolvedModule!.resolvedFileName)
        ? undefined
        : through(split.subpath ? `${typesPackageName(split.name)}/${split.subpath}` : typesPackageName(split.name), issuer);
    const answer = typed ?? primary ?? {};
    answers.set(key, answer);
    return answer;
  };
  host.resolveModuleNameLiterals = (literals, containingFile) =>
    literals.map(literal => resolveModule(literal.text, containingFile));
  /* A project may REPLACE one of the compiler's built-in libraries by depending
   * on `@typescript/lib-<name>` — a package the compiler looks for in
   * node_modules, i.e. somewhere that no longer exists. Same table, same
   * question, so the declared override is honored exactly as it was under a
   * tree; without this the compiler silently falls back to its bundled lib and
   * the difference surfaces as type errors in the project's own code. */
  host.resolveLibrary = (libraryName, resolveFrom, libraryOptions) => {
    const location = resolver.locationOf(libraryName, path.join(root, "tsconfig.json"));
    return location === undefined
      ? { resolvedModule: undefined }
      : ts.resolveModuleName(location, resolveFrom, libraryOptions, host, cache);
  };
  host.resolveTypeReferenceDirectiveReferences = (directives, containingFile) =>
    directives.map(directive => {
      const name = typeof directive === "string" ? directive : directive.fileName;
      /* A type reference names a types package first (`node` is `@types/node`),
       * and only then a package of that name shipping its own — the order tsc
       * uses when it walks `node_modules/@types`. */
      for (const candidate of [typesPackageName(name), name]) {
        /* Resolved from the COMPILATION, not from the referencing file.
         *
         * A types package contributes AMBIENT declarations: they are facts
         * about the whole program, not about the package that referenced them,
         * and two versions of one in a program are not two environments but a
         * pile of duplicate globals (two `@types/node` make every DOM
         * `addEventListener` ambiguous). A tree collapsed them positionally —
         * the hoisted winner answered everyone — and this is the same rule
         * stated directly: the compilation's own declared surface governs, and
         * only when it declares nothing does the referencing package's own
         * binding answer. */
        const issuer = containingFile || root;
        const location = resolver.locationOf(candidate, root) ?? resolver.locationOf(candidate, issuer);
        const resolved = location === undefined ? undefined : ts.resolveModuleName(location, issuer, options, host, cache);
        if (resolved?.resolvedModule && !UNTYPED.test(resolved.resolvedModule.resolvedFileName)) {
          return {
            resolvedTypeReferenceDirective: {
              primary: true,
              resolvedFileName: resolved.resolvedModule.resolvedFileName,
              isExternalLibraryImport: true,
            },
          };
        }
      }
      return {};
    });
}

/* Every quoted specifier a declaration file can carry a path in: the synthesized
 * `import("…")` type reference (the only form the declaration emitter INVENTS a
 * specifier for), plus the written forms, which are scanned so the safety net
 * below sees everything. */
const QUOTED_SPECIFIER = /(import\s*\(\s*|from\s*|require\s*\(\s*|<reference\s+path\s*=\s*)(["'])([^"']+)\2/g;

/** A specifier that names a location rather than a package — the only kind that
 * can point into the tree pool. */
function isPathSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || path.isAbsolute(specifier);
}

/**
 * Rewrite the pool paths a declaration file would otherwise ship, and refuse to
 * emit one that still holds any.
 *
 * TypeScript's declaration emitter, asked to name a type it cannot otherwise
 * express (an inferred generic from a dependency), SYNTHESIZES a module
 * specifier from the resolved file's path. Under a node_modules tree it
 * reverse-engineers the bare name from the path's `node_modules` segment; with
 * resolution coming from a table there is no such segment, so it writes the
 * path — which bakes this build's layout into a shipped artifact AND is dead in
 * every consumer, since it resolves relative to wherever the `.d.ts` ends up
 * there. The type then silently degrades to `unknown` and the errors surface
 * far from the cause.
 *
 * So the emitter's answer is mapped back through the same table it bypassed:
 * a path inside a package's location is that package, plus a subpath (an entry
 * IS the package root, so the remainder maps one for one). This is
 * [[DESIGN-js-emit]]'s planned post-emit specifier rewrite, arriving early
 * because manifest resolution needs it now.
 *
 * Anything still naming the pool after that is a fault, not a fallback: an
 * unmapped key or a form this does not know is reported against the file rather
 * than shipped.
 */
export function rewriteDeclaration(fileName: string, text: string, resolver: PnpResolver): string {
  const from = path.dirname(fileName);
  const rewritten = text.replace(QUOTED_SPECIFIER, (match, prefix: string, quote: string, specifier: string) => {
    if (!isPathSpecifier(specifier)) {
      return match;
    }
    const named = resolver.packageOf(path.resolve(from, specifier));
    return named === undefined ? match : `${prefix}${quote}${named.subpath ? `${named.name}/${named.subpath}` : named.name}${quote}`;
  });
  const leaked = treeReferenceIn(rewritten, from, resolver.treeRoots);
  if (leaked !== undefined) {
    throw new Error(
      `tsc-driver: ${fileName} would ship a path into this build's tree pool ('${leaked}'), which resolves to nothing ` +
        "outside it. This is a fabr bug: the package it names has no row in the dependency manifest."
    );
  }
  return rewritten;
}

/** The first specifier in `text` that points inside the tree pool, if any. */
function treeReferenceIn(text: string, from: string, treeRoots: ReadonlyArray<string>): string | undefined {
  for (const [, , , specifier] of text.matchAll(QUOTED_SPECIFIER)) {
    const target = isPathSpecifier(specifier) ? path.resolve(from, specifier) + path.sep : undefined;
    if (target !== undefined && treeRoots.some(pool => target.startsWith(pool))) {
      return specifier;
    }
  }
  return undefined;
}

/** Diagnostics as the CLI renders them: colored with source context when the
 * project asks for `pretty` (fabr's generated tsconfig does, and strips the
 * codes at render time), plain otherwise. */
export function renderDiagnostics(ts: ITypeScript, diagnostics: readonly Diagnostic[], host: ICompilerHost, pretty: boolean): string {
  const formatHost = {
    getCanonicalFileName: (fileName: string) => host.getCanonicalFileName(fileName),
    getCurrentDirectory: () => host.getCurrentDirectory(),
    getNewLine: () => host.getNewLine(),
  };
  return pretty ? ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost) : ts.formatDiagnostics(diagnostics, formatHost);
}

export function main(argv: string[]): number {
  // typescript is the tool this driver drives: fetched by fabr and mounted in
  // this step's own install, so it is required rather than imported (its types
  // are not available at compile time).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ts = require("typescript") as ITypeScript;
  if (Number(ts.version.split(".")[0]) < MINIMUM_TYPESCRIPT) {
    throw new Error(`fabr's TypeScript driver needs typescript ${MINIMUM_TYPESCRIPT}.0 or newer (found ${ts.version})`);
  }
  const root = process.cwd();
  const configPath = path.resolve(root, projectOf(argv));
  if (!fs.existsSync(configPath)) {
    throw new Error(`tsc-driver: no project at ${configPath}`);
  }
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, configHost(ts));
  if (parsed === undefined) {
    throw new Error(`tsc-driver: could not read the project at ${configPath}`);
  }
  const host = ts.createCompilerHost(parsed.options, true);
  const resolver = PnpResolver.load(root);
  if (resolver) {
    installResolution(ts, host, parsed.options, resolver, root);
  }
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    host,
    projectReferences: parsed.projectReferences,
  });
  /* Declarations are rewritten on their way out rather than re-read afterwards:
   * the emitter hands each file over here, so nothing incorrect is ever written
   * and the step's output is collected from a tree that was never wrong. */
  const emitted = program.emit(undefined, (fileName, text, writeByteOrderMark) => {
    const rewritable = resolver !== undefined && DECLARATION_FILE.test(fileName);
    host.writeFile(fileName, rewritable ? rewriteDeclaration(fileName, text, resolver) : text, writeByteOrderMark);
  });
  /* Sorted and deduplicated as the CLI does it: the pre-emit set already
   * carries the project's own option diagnostics, so the config errors overlap
   * it and would otherwise print twice. */
  const diagnostics = ts.sortAndDeduplicateDiagnostics([...parsed.errors, ...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics]);
  if (diagnostics.length > 0) {
    /* Diagnostics go to stdout, as the CLI writes them. */
    process.stdout.write(renderDiagnostics(ts, diagnostics, host, parsed.options.pretty !== false));
  }
  if (diagnostics.length === 0) {
    return EXIT_OK;
  }
  return emitted.emitSkipped ? EXIT_ERRORS_NO_OUTPUT : EXIT_ERRORS;
}

/** The project to compile: `--project <path>`/`-p <path>` as the CLI spells it,
 * else `tsconfig.json` in the working directory. */
function projectOf(argv: string[]): string {
  const flag = argv.findIndex(arg => arg === "--project" || arg === "-p");
  return flag >= 0 && argv[flag + 1] !== undefined ? argv[flag + 1] : "tsconfig.json";
}

/**
 * The host a config file is read through: the compiler's own filesystem, since
 * expanding a project's `include` globs is a directory walk the config parser
 * does through this interface — a partial host silently yields a project with
 * no files. The unrecoverable-diagnostic sink only exists to satisfy the
 * interface: everything recoverable comes back in `errors` and is rendered with
 * the rest.
 */
function configHost(ts: ITypeScript): unknown {
  return {
    fileExists: (file: string) => ts.sys.fileExists(file),
    readFile: (file: string, encoding?: string) => ts.sys.readFile(file, encoding),
    readDirectory: (dir: string, extensions?: readonly string[], exclude?: readonly string[], include?: readonly string[], depth?: number) =>
      ts.sys.readDirectory(dir, extensions, exclude, include, depth),
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
    onUnRecoverableConfigFileDiagnostic: (diagnostic: Diagnostic) => {
      throw new Error(`tsc-driver: unreadable project (${JSON.stringify(diagnostic)})`);
    },
  };
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err: unknown) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = EXIT_ERRORS;
  }
}
