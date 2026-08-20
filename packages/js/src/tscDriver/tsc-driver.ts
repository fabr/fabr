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
  resolvedUsingTsExtension?: boolean;
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
  ModuleKind: { CommonJS: number; ES2015: number; Node16: number; NodeNext: number; Preserve?: number };
  ModuleResolutionKind: { Node10?: number; NodeJs?: number; Node16: number; NodeNext: number; Bundler: number };
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
 * no typings of its own, which is what sends the lookup on to the recoveries
 * below and then to `@types`. */
const UNTYPED = /\.[cm]?jsx?$/;

/** A format-tagged JavaScript extension, whose declarations the compiler will
 * only look for under the matching tag (`.d.cts` for `.cjs`). */
const FORMAT_TAGGED = /\.[cm]js$/;

/** tsc's own exit codes, which fabr's step reports as the tool's outcome. */
const EXIT_OK = 0;
const EXIT_ERRORS_NO_OUTPUT = 1;
const EXIT_ERRORS = 2;

/**
 * Resolution against the manifest, installed on the compiler host.
 *
 * The name part of a specifier is answered by the resolver: the table says
 * which package (the issuer's own bindings, then the compilation's declared
 * surface as a fallback), and that package's `exports` map says which file
 * within it — the two halves a bare specifier is made of, and neither of them
 * something the compiler can answer without a tree. What is left is the file
 * part, which IS the compiler's ordinary business and which it does when handed
 * the answer as a rooted specifier: extension probing, `main`/`types` for a
 * package that publishes no `exports`, and the `.d.ts` beside a `.js` an
 * `exports` map named.
 *
 * The `@types` retry is the compiler's own rule reproduced: a package whose
 * resolution yields no typings is followed by a lookup of its `@types` sidecar,
 * which in a node_modules tree tsc finds by walking up and here comes out of
 * the same table.
 */
function installResolution(
  ts: ITypeScript,
  host: ICompilerHost,
  options: CompilerOptions,
  resolver: PnpResolver,
  root: string,
  faults: Set<string>
): void {
  const cache = ts.createModuleResolutionCache(root, name => host.getCanonicalFileName(name), options);
  /**
   * What the package publishes for a specifier — the resolver's answer, with a
   * MALFORMED MANIFEST recorded rather than thrown.
   *
   * A dependency whose `exports` map cannot be read is a fault in that package,
   * and one package's mistake must not cost the compilation every other
   * diagnostic it was about to report. So the name resolves to nothing, the
   * compiler says so where the import is written, and the underlying reason is
   * reported once alongside the diagnostics (see {@link main}).
   */
  const published = (specifier: string, issuer: string): string[] => {
    try {
      return resolver.resolveAll(specifier, issuer);
    } catch (err: unknown) {
      faults.add(err instanceof Error ? err.message : String(err));
      return [];
    }
  };
  /** A path the resolver produced, as the compiler sees it. A rooted specifier
   * is resolved by the compiler as a path rather than a package name — which is
   * exactly the "unqualified path" PnP hands back. */
  const asModule = (target: string, issuer: string): IResolvedModuleWithFailedLookupLocations | undefined => {
    const resolved = ts.resolveModuleName(target, issuer, options, host, cache);
    if (!resolved.resolvedModule) {
      return undefined;
    }
    /* `resolvedUsingTsExtension` is dropped because it describes the path this
     * driver handed the compiler, not the specifier the program actually wrote:
     * an `exports` map naming a `.d.ts` outright would otherwise look like a
     * source file importing one by extension, which the checker treats as an
     * error in the importing code — code that wrote a bare package name. */
    return { resolvedModule: { ...resolved.resolvedModule, isExternalLibraryImport: true, resolvedUsingTsExtension: undefined } };
  };
  /** Whether a resolution came back with no typings — the trigger for every
   * recovery below, and for the `@types` lookup that has always followed. */
  const untyped = (found: IResolvedModuleWithFailedLookupLocations | undefined): boolean =>
    found === undefined || UNTYPED.test(found.resolvedModule!.resolvedFileName);
  /**
   * What a name resolves to, preferring whichever of the package's published
   * files carries declarations.
   *
   * A condition names an implementation and this compilation wants types, so one
   * answer is not always the answer: a package may describe its faces under
   * `import`/`require` and keep its only declaration file behind a `types` key
   * listed AFTER them, which reading the first answer and stopping renders
   * untyped. The package's preferences are walked in its own order until one of
   * them declares something — which is the compiler's own behaviour, and why a
   * types-preferring pass would be wrong: a package whose `require` face has its
   * own declarations beside it must still get those, not the generic ones a
   * trailing `types` names.
   *
   * The first candidate is what node would load, so it stays the answer when
   * none of them declares anything, and the recoveries take it from there.
   */
  const through = (specifier: string, issuer: string): IResolvedModuleWithFailedLookupLocations | undefined => {
    const candidates = published(specifier, issuer);
    /* Node's own choice is the first, and it gates the rest: if the file it
     * names is not there, the import does not load, and a later candidate
     * answering would compile something that cannot run. */
    const primary = candidates.length === 0 ? undefined : asModule(candidates[0], issuer);
    if (primary === undefined || !untyped(primary)) {
      return primary;
    }
    for (const candidate of candidates.slice(1)) {
      const found = asModule(candidate, issuer);
      if (found !== undefined && !untyped(found)) {
        return found;
      }
    }
    return primary;
  };
  /**
   * The declarations for an implementation the package publishes but gives this
   * compilation no typings for, tried in turn until one is typed.
   *
   * Why look at all, rather than report the package as mis-specified: a package
   * that publishes `./dist/index.cjs` for `require` and one `dist/index.d.ts`
   * beside it — the shape half the ecosystem's build tools emit — RUNS. Node
   * loads it, esbuild bundles it, and only the strict declaration rule (which
   * wants `dist/index.d.cts`) cannot see its types. Refusing to compile what
   * will execute is the wrong failure, so the declarations are looked for under
   * their plain name, and then under the package's own `types`/`main`.
   *
   * What this does NOT do is rescue an implementation that will not run: every
   * recovery needs the published resolution to have succeeded first, so a
   * subpath the map does not publish stays unresolved however plainly the files
   * sit there, and `types`/`main` can never resurrect it.
   */
  const recoverTypings = (
    specifier: string,
    split: { name: string; subpath: string } | undefined,
    published: IResolvedModuleWithFailedLookupLocations | undefined,
    issuer: string
  ): IResolvedModuleWithFailedLookupLocations | undefined => {
    const probes: Array<() => IResolvedModuleWithFailedLookupLocations | undefined> = [];
    if (published !== undefined) {
      probes.push(() => siblingTypings(specifier, issuer));
      /* `types`/`main` describe the package's MAIN entry and nothing else, so
       * they answer for the bare name alone — a subpath they say nothing about
       * would otherwise be typed by whatever the root happens to be. */
      if (split?.subpath === "") {
        probes.push(() => legacyTypings(split.name, issuer));
      }
    }
    /* The `@types` sidecar: the compiler's own rule reproduced, and the last
     * resort for a name whose own package ships no typings. Which of two
     * failures brought us here decides whether it may answer:
     *
     * - The package is in this compilation and published nothing for the name.
     *   The sidecar may NOT rescue that: it describes a module the program
     *   loads, and the package has just said this one is not loadable, so
     *   accepting it would compile an import node answers with
     *   ERR_PACKAGE_PATH_NOT_EXPORTED.
     * - The package is not in this compilation at all. Then there is nothing to
     *   contradict, and the sidecar IS the dependency — the DefinitelyTyped
     *   shape for an API that is no npm package (`@types/aws-lambda`) or one a
     *   project types without installing. Nothing can fail to load here,
     *   because nothing loads.
     */
    const declared = split !== undefined && resolver.locationOf(split.name, issuer) !== undefined;
    if (split !== undefined && (published !== undefined || !declared)) {
      const sidecar = typesPackageName(split.name);
      probes.push(() => through(split.subpath ? `${sidecar}/${split.subpath}` : sidecar, issuer));
    }
    for (const probe of probes) {
      const found = probe();
      if (!untyped(found)) {
        return found;
      }
    }
    return undefined;
  };
  /** The declaration file beside a format-tagged implementation under its PLAIN
   * name — `index.d.ts` next to `index.cjs`, where the strict rule admits only
   * `index.d.cts`. Asking the compiler for the `.js` spelling is what puts the
   * untagged declaration extensions back in its candidate list. */
  const siblingTypings = (specifier: string, issuer: string): IResolvedModuleWithFailedLookupLocations | undefined => {
    const target = published(specifier, issuer)[0];
    return target === undefined || !FORMAT_TAGGED.test(target) ? undefined : asModule(target.replace(FORMAT_TAGGED, ".js"), issuer);
  };
  /** The package's own `types`/`main`, reached by handing the compiler the
   * package DIRECTORY — the pre-`exports` resolution, which is where a package
   * that never added a `types` condition still keeps its declarations. */
  const legacyTypings = (name: string, issuer: string): IResolvedModuleWithFailedLookupLocations | undefined => {
    const location = resolver.locationOf(name, issuer);
    return location === undefined ? undefined : asModule(location, issuer);
  };
  /* One answer per (asking package, specifier). A name means the same thing to
   * every file of one package — that is what the table says — so the file part
   * is probed once rather than once per import site: a compile asks tens of
   * thousands of times and holds hundreds of distinct answers. */
  const answers = new Map<string, IResolvedModuleWithFailedLookupLocations>();
  const resolveModule = (specifier: string, issuer: string): IResolvedModuleWithFailedLookupLocations => {
    const split = splitSpecifier(specifier);
    if (split === undefined && !specifier.startsWith("#")) {
      /* Not a name at all: a relative or rooted path, which is the compiler's
       * own business and bounded — it probes where it is told, it does not
       * search. */
      return ts.resolveModuleName(specifier, issuer, options, host, cache);
    }
    const key = `${resolver.locatorOf(issuer)}\0${specifier}`;
    const held = answers.get(key);
    if (held !== undefined) {
      return held;
    }
    /* A NAME is the resolver's business, exclusively. Asking the compiler first
     * would make it walk `node_modules` up from the issuer — through every
     * ancestor of the workspace and of the cache — finding nothing, on every
     * bare import of every file: the dominant cost of a compile, and a way for
     * a stray directory above the build to answer an undeclared import. A `#`
     * specifier is the same: private to the issuing package, and answered from
     * its own `imports` map rather than by probing.  */
    /* What the package publishes is the answer whenever it carries typings; a
     * published implementation with none keeps its place as the fallback, so an
     * import that will execute resolves either way and the compiler reports the
     * missing declarations as it does anywhere else. */
    const published = through(specifier, issuer);
    const answer = (untyped(published) ? recoverTypings(specifier, split, published, issuer) : undefined) ?? published ?? {};
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
    const target = published(libraryName, path.join(root, "tsconfig.json"))[0];
    return target === undefined
      ? { resolvedModule: undefined }
      : ts.resolveModuleName(target, resolveFrom, libraryOptions, host, cache);
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
        const target = published(candidate, root)[0] ?? published(candidate, issuer)[0];
        const resolved = target === undefined ? undefined : ts.resolveModuleName(target, issuer, options, host, cache);
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

/**
 * Cut the compile's own directory out of emitted text, leaving the root-relative
 * path the sourcemaps already use.
 *
 * TypeScript names a source by the path it was given, and the driver is given
 * absolute ones (a parsed config resolves its file names against the project
 * directory). Any emit that carries a source path therefore carries THIS
 * compile's staging directory — `_jsxFileName` under the automatic JSX runtime's
 * dev variant is the one that reaches shipped code, ~1400 of them in a real app
 * bundle. That directory is named for the process that made it, so the same
 * inputs emit different bytes on every build: the artifact stops being a
 * function of its cache key, and a content-hashed asset name derived from it
 * churns for no reason.
 *
 * Applied to every emitted file rather than to the one construct that is known
 * to do this, because what must not appear in the output is the path, whichever
 * emitter wrote it.
 */
export function relativizeBuildRoot(text: string, root: string): string {
  /* TypeScript spells paths with forward slashes whatever the platform. */
  const prefix = `${root.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
  return text.includes(prefix) ? text.split(prefix).join("") : text;
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
  /* Supplied rather than overridden: a project that states its own resolution
   * keeps it, which is what makes this a drop-in for an ordinary tsconfig. Set
   * after parsing and not validated again, because the value chosen is the one
   * this compiler accepts — that is the whole of what {@link resolutionFor}
   * decides. */
  if (parsed.options.moduleResolution === undefined) {
    parsed.options.moduleResolution = resolutionFor(ts, parsed.options);
  }
  const host = ts.createCompilerHost(parsed.options, true);
  const resolver = PnpResolver.load(root, conditionsOf(ts, parsed.options));
  /* Manifest faults in the DEPENDENCIES: collected while resolving and reported
   * with everything else, rather than aborting the compilation the moment one
   * unreadable package is touched. */
  const faults = new Set<string>();
  if (resolver) {
    installResolution(ts, host, parsed.options, resolver, root, faults);
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
    const rewritten = rewritable ? rewriteDeclaration(fileName, text, resolver) : text;
    /* After the declaration rewrite, which reports a pool path as a fault: this
     * one relativizes the compile's own root, and a fault must not be quietly
     * tidied into something that looks fine. */
    host.writeFile(fileName, relativizeBuildRoot(rewritten, root), writeByteOrderMark);
  });
  /* Sorted and deduplicated as the CLI does it: the pre-emit set already
   * carries the project's own option diagnostics, so the config errors overlap
   * it and would otherwise print twice. */
  const diagnostics = ts.sortAndDeduplicateDiagnostics([...parsed.errors, ...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics]);
  if (diagnostics.length > 0) {
    /* Diagnostics go to stdout, as the CLI writes them. */
    process.stdout.write(renderDiagnostics(ts, diagnostics, host, parsed.options.pretty !== false));
  }
  /* After the diagnostics, because they name the imports that failed and this
   * names why: a package whose manifest could not be read is the cause of
   * however many "cannot find module" lines precede it. */
  for (const fault of faults) {
    process.stdout.write(`error: ${fault}\n`);
  }
  if (diagnostics.length === 0 && faults.size === 0) {
    return EXIT_OK;
  }
  return emitted.emitSkipped ? EXIT_ERRORS_NO_OUTPUT : EXIT_ERRORS;
}

/**
 * The export conditions a compilation satisfies — which of a package's several
 * faces this one sees.
 *
 * The governing rule: what compiles is what will RUN, so this set is the one
 * node itself would apply when loading this compilation's output. `types`
 * because that is what a compiler wants and what a package shipping several
 * declaration files distinguishes on; the module system the project actually
 * emits, since a package with separate ESM and CJS entries describes each with
 * its own typings and the wrong one silently changes what `import x from`
 * means; and `module-sync`, which is how a package marks an ESM entry that a
 * `require` may load synchronously (node 22 and later do exactly that, from
 * both directions, so it belongs whichever module system is emitted).
 *
 * The order stated here is not the priority — the PACKAGE's map decides that.
 * This is the set of conditions that are true of this compilation.
 *
 * Deliberately absent, in both cases because the condition would assert
 * something this compilation does not know:
 *
 * - The OTHER module system's condition. A package publishing only `import`
 *   genuinely cannot be required (node answers ERR_PACKAGE_PATH_NOT_EXPORTED,
 *   `module-sync` being the supported way to say otherwise), so resolving it
 *   here would compile an import that cannot load.
 * - A PLATFORM. `node` and `browser` describe where the code will end up, and
 *   what a tree is emitted for varies per consumer while the tree itself does
 *   not — the same reasoning that keeps the `dom` lib a source flag rather than
 *   a reading of JS_TARGET's environment. So a package splitting `node`/
 *   `browser`/`default` types as `default` here, exactly as it does under stock
 *   tsc, and the bundler picks the platform face at bundle time where that
 *   genuinely is known.
 *
 * `customConditions` is honored where a project states its own — TypeScript's
 * channel for a project asserting a fact about itself, which is the one place
 * a platform condition can honestly come from.
 */
function conditionsOf(ts: ITypeScript, options: CompilerOptions): string[] {
  const custom = Array.isArray(options.customConditions) ? (options.customConditions as string[]) : [];
  return ["types", options.module === ts.ModuleKind.CommonJS ? "require" : "import", "module-sync", ...custom];
}

/**
 * The module resolution a project gets when it states none — the one option
 * fabr cannot put in the generated tsconfig, because the answer depends on the
 * compiler version and only this driver knows which compiler it loaded.
 *
 * `bundler` is what fabr wants everywhere: it reads `exports`, which `node10`
 * does not, and its file-resolution rules are the ones this driver's path
 * handoffs are written against. The one combination that has to vary is a
 * CommonJS emit, because the compilers disagree about it:
 *
 * - before 6, `bundler` may not be paired with `module: commonjs` at all
 *   (TS5095), so a CommonJS project takes `node10` — which costs nothing here,
 *   since this driver answers every bare specifier itself and the compiler's own
 *   package lookup is never reached.
 * - from 6, `node10` is a deprecation ERROR (TS5107, "will stop functioning in
 *   TypeScript 7.0") while `bundler` with a CommonJS emit is accepted, so the
 *   same project must take `bundler` or fail outright.
 *
 * A project emitting `node16`/`nodenext` modules must resolve the matching way
 * (TS5110 otherwise), so those answer for themselves.
 */
export function resolutionFor(ts: ITypeScript, options: CompilerOptions): number {
  const kinds = ts.ModuleResolutionKind;
  const module = options.module;
  const node10 = kinds.Node10 ?? kinds.NodeJs!;
  /* The node* family resolves its own way or not at all (TS5109/TS5110).
   * `nodenext` tracks node; every other member of the family — `node16`,
   * `node18`, whatever is added next — pairs with Node16. */
  if (module === ts.ModuleKind.NodeNext) {
    return kinds.NodeNext;
  }
  if (typeof module === "number" && module >= ts.ModuleKind.Node16 && module < ts.ModuleKind.NodeNext) {
    return kinds.Node16;
  }
  /* `bundler` pairs only with an ES-module or `preserve` emit (TS5095) — plus a
   * CommonJS one from TypeScript 6, which is the whole reason this function
   * exists. Anything else the ecosystem still emits (`amd`, `umd`, `system`,
   * `none`) takes `node10`, which every compiler accepts. */
  const esModules = typeof module === "number" && module >= ts.ModuleKind.ES2015 && module < ts.ModuleKind.Node16;
  if (esModules || (ts.ModuleKind.Preserve !== undefined && module === ts.ModuleKind.Preserve)) {
    return kinds.Bundler;
  }
  /* An unstated `module` is treated as the CommonJS it may well default to:
   * `node10` is legal under every compiler, so the conservative branch can only
   * cost resolution fidelity this driver supplies anyway. */
  const commonjs = module === undefined || module === ts.ModuleKind.CommonJS;
  const legacy = Number(ts.version.split(".")[0]) < 6;
  return commonjs && !legacy ? kinds.Bundler : node10;
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
