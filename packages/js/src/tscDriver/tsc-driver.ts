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

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PnpResolver, splitSpecifier, typesPackageName } from "../pnp/PnPResolver";
import { CHANGES_FLAG, DEPS_REPORT_FLAG, IChangeLists, joinDepsPath, STATE_DIR_FLAG, toChangeLists } from "../pnp/ReadSet";
import {
  DriverMemo,
  ICompilePlan,
  ICompileTelemetry,
  IDriverDiagnostic,
  IMemoEdge,
  membershipTarget,
  mergeMemo,
  parseDriverMemo,
  planCompile,
  serializeDriverMemo,
  serializeRunReport,
} from "./Planning";
import { IWaveResult, runWave } from "./Wave";

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
/* The syntax tree, as far as the specifier rewrite reads it: every node carries
 * a `kind`, and the four forms that can hold a module specifier expose the
 * members their `update` factory takes back. */
interface INode {
  kind: number;
}
interface IStringLiteralNode extends INode {
  text: string;
}
/** A node read back out of emitted text, which is the only kind that carries
 * real positions — everything the declaration emitter synthesizes has none. */
interface ISyntaxNode extends INode {
  /** Where the node's text begins INCLUDING its leading trivia — so the run of
   * a type literal's members is contiguous, and permuting the slices carries
   * each member's own doc comment and indentation along with it. */
  pos: number;
  end: number;
  /** The offset the node's own text starts at, leading trivia skipped — so a
   * comment or the indentation before a node stays put when the node moves. */
  getStart(source: ISyntaxNode): number;
  /** A union's members, in the order the compiler printed them. */
  types?: ReadonlyArray<ISyntaxNode>;
  /** A type literal's members, likewise. */
  members?: ReadonlyArray<ISyntaxNode>;
  /** A member's name, absent on the three signature forms that have none. */
  name?: ISyntaxNode;
}
interface ISourceFileNode extends INode {
  fileName: string;
}
interface IImportDeclarationNode extends INode {
  modifiers?: unknown;
  importClause?: unknown;
  moduleSpecifier?: INode;
  /** `assert`/`with` — named `assertClause` before TypeScript 5.3. */
  attributes?: unknown;
  assertClause?: unknown;
}
interface IExportDeclarationNode extends INode {
  modifiers?: unknown;
  isTypeOnly: boolean;
  exportClause?: unknown;
  moduleSpecifier?: INode;
  attributes?: unknown;
  assertClause?: unknown;
}
interface ICallExpressionNode extends INode {
  expression: INode;
  typeArguments?: unknown;
  arguments: readonly INode[];
}
/** `import("./x").T` — the one specifier an emitter writes of its own accord. */
interface IImportTypeNode extends INode {
  argument: INode;
  qualifier?: unknown;
  typeArguments?: unknown;
  isTypeOf: boolean;
  /** `assert`/`with` — named `assertions` before TypeScript 5.3. */
  attributes?: unknown;
  assertions?: unknown;
}
interface ILiteralTypeNode extends INode {
  literal: INode;
}
/** A transform over one file's tree, in the compiler's own two-step shape. */
type TransformerFactory = (context: unknown) => (sourceFile: ISourceFileNode) => INode;
interface ICustomTransformers {
  before?: TransformerFactory[];
  afterDeclarations?: TransformerFactory[];
}
/**
 * The properties of a source file this driver reads. Every one of them is a
 * fact about the file's own form — its name, whether it is a module, and the
 * augmentations it declares — which is all the wave needs of it (what a file
 * MEANS is the checker's business, and is asked through the program).
 */
interface ISourceFileInfo {
  fileName: string;
  /** Present on a file that is an external module (it imports or exports
   * something); absent on a script, whose declarations are global. */
  externalModuleIndicator?: unknown;
  /** `declare module "x"` blocks — including `declare global`, which is the one
   * the wave cares about and which this driver treats conservatively (see
   * {@link affectsGlobalScope}). */
  moduleAugmentations?: ReadonlyArray<unknown>;
}

/** As much of a diagnostic as reporting one as DATA needs: everything else
 * about it is the compiler's own business, and the human rendering goes through
 * the compiler's own formatter. */
interface IDiagnosticInfo {
  file?: SourceFile;
  start?: number;
  code: number;
  category: number;
  messageText: unknown;
}

interface IProgram {
  emit(
    targetSourceFile?: SourceFile,
    writeFile?: WriteFile,
    cancellationToken?: unknown,
    emitOnlyDtsFiles?: boolean,
    customTransformers?: ICustomTransformers
  ): IEmitResult;
  /** Every file the program holds — the sources, and every declaration file
   * reached from them. The `--listFiles` answer, in process. */
  getSourceFiles(): ReadonlyArray<ISourceFileInfo>;
  /** The compiler's own bundled (or overridden) `lib.*.d.ts`: in the program,
   * but not a node of the graph — it is the toolchain, which the caller keys as
   * target-key identity rather than as an input file. */
  isSourceFileDefaultLibrary(file: SourceFile): boolean;
  /** Per-file diagnostics: what the wave asks of each of its members, and the
   * whole point of driving the compiler per file rather than in bulk. */
  getSyntacticDiagnostics(file?: SourceFile): readonly Diagnostic[];
  getSemanticDiagnostics(file?: SourceFile): readonly Diagnostic[];
  /** The compilation's own diagnostics, which belong to no file and are asked
   * once per run. */
  getOptionsDiagnostics(): readonly Diagnostic[];
  getGlobalDiagnostics(): readonly Diagnostic[];
}
type WriteFile = (fileName: string, text: string, writeByteOrderMark: boolean) => void;

interface ICompilerHost {
  getCurrentDirectory(): string;
  writeFile: WriteFile;
  /** Every file the compiler opens goes through here — sources, declaration
   * files, and the `package.json`s its resolution consults. */
  readFile?: (fileName: string, encoding?: string) => string | undefined;
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
  JsxEmit: { Preserve: number };
  SyntaxKind: { ImportKeyword: number };
  /* Node construction and traversal, for the specifier rewrite. The `update`
   * forms take the node's own members back, so a caller passes through
   * everything it is not changing. */
  factory: {
    createStringLiteral(text: string): IStringLiteralNode;
    updateImportDeclaration(
      node: INode,
      modifiers: unknown,
      importClause: unknown,
      moduleSpecifier: INode,
      attributes: unknown
    ): INode;
    updateExportDeclaration(
      node: INode,
      modifiers: unknown,
      isTypeOnly: boolean,
      exportClause: unknown,
      moduleSpecifier: INode,
      attributes: unknown
    ): INode;
    updateCallExpression(node: INode, expression: INode, typeArguments: unknown, args: readonly INode[]): INode;
    createLiteralTypeNode(literal: INode): INode;
    /** Positionally stable across the releases this driver drives: 5.3 renamed
     * the third parameter `assertions` to `attributes` without moving it. */
    updateImportTypeNode(
      node: INode,
      argument: INode,
      attributes: unknown,
      qualifier: unknown,
      typeArguments: unknown,
      isTypeOf: boolean
    ): INode;
  };
  visitNode(node: INode, visitor: (node: INode) => INode): INode;
  visitEachChild(node: INode, visitor: (node: INode) => INode, context: unknown): INode;
  isImportDeclaration(node: INode): boolean;
  isExportDeclaration(node: INode): boolean;
  isCallExpression(node: INode): boolean;
  isStringLiteral(node: INode): boolean;
  isImportTypeNode(node: INode): boolean;
  isLiteralTypeNode(node: INode): boolean;
  isUnionTypeNode(node: INode): boolean;
  isTypeLiteralNode(node: INode): boolean;
  /** The AST children of a node — punctuation excluded, which is what lets a
   * span-splicing rewrite leave every separator exactly where it was. */
  forEachChild(node: INode, visit: (child: INode) => void): void;
  createSourceFile(
    fileName: string,
    text: string,
    languageVersion: number,
    setParentNodes?: boolean,
    scriptKind?: number
  ): ISyntaxNode;
  ScriptTarget: { Latest: number };
  ScriptKind: { TS: number };
  /** Whether a file is a module rather than a script — the compiler's own
   * judgment, since "has an import or an export" has more forms than it looks
   * (a bare `export {}`, `import.meta`, a `.mts` extension). */
  isExternalModule?(file: SourceFile): boolean;
  /** A diagnostic's message text, which is a chain rather than a string. */
  flattenDiagnosticMessageText(text: unknown, newLine: string): string;
  DiagnosticCategory: { [name: string]: unknown };
  getLineAndCharacterOfPosition(file: SourceFile, position: number): { line: number; character: number };
  sys: {
    newLine: string;
    useCaseSensitiveFileNames: boolean;
    fileExists(path: string): boolean;
    readFile(path: string, encoding?: string): string | undefined;
    readDirectory(
      path: string,
      extensions?: readonly string[],
      exclude?: readonly string[],
      include?: readonly string[],
      depth?: number
    ): string[];
    getCurrentDirectory(): string;
  };
  getParsedCommandLineOfConfigFile(
    configFileName: string,
    optionsToExtend: CompilerOptions | undefined,
    host: unknown
  ): IParsedCommandLine | undefined;
  createCompilerHost(options: CompilerOptions, setParentNodes?: boolean): ICompilerHost;
  createProgram(options: {
    rootNames: readonly string[];
    options: CompilerOptions;
    host: ICompilerHost;
    projectReferences?: unknown[];
  }): IProgram;
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
  createModuleResolutionCache(
    currentDirectory: string,
    getCanonicalFileName: (name: string) => string,
    options?: CompilerOptions
  ): unknown;
}

/** The compiler releases this driver can drive.
 *
 * The floor is where its resolution hooks exist (`resolveModuleNameLiterals`
 * landed in 5.0); an older compiler would silently resolve through the
 * filesystem — i.e. find nothing.
 *
 * The ceiling is the classic compiler API itself. TypeScript 7 is the Go port:
 * its `typescript` entry point exports `version` and `versionMajorMinor` and
 * nothing else, with the compiler reachable only through a separate `unstable/`
 * surface. Everything below (`createProgram`, the CompilerHost, the resolution
 * hooks) is gone, so 7 is not a stricter version of this driver's job but a
 * different one, and wants its own driver rather than a branch in this one.
 * Checked by version rather than by feature probe so the diagnosis names the
 * cause — an unchecked 7 fails deep inside on an undefined host instead. */
const MINIMUM_TYPESCRIPT = 5;
const MAXIMUM_TYPESCRIPT = 6;

/** Reject a compiler this driver cannot drive, naming which way it is out of
 * range — the alternative is failing later on an undefined host member, which
 * says nothing about the compiler being wrong. */
export function assertDrivableCompiler(version: string): void {
  const major = Number(version.split(".")[0]);
  if (major >= MINIMUM_TYPESCRIPT && major <= MAXIMUM_TYPESCRIPT) {
    return;
  }
  const range = `${MINIMUM_TYPESCRIPT}.x-${MAXIMUM_TYPESCRIPT}.x`;
  throw new Error(
    major > MAXIMUM_TYPESCRIPT
      ? `fabr's TypeScript driver drives typescript ${range}, but found ${version}: TypeScript ${major} exposes no compiler API to drive ` +
        "(its entry point is version information alone) and needs a driver of its own. Pin ${TYPESCRIPT} to a 6.x or 5.x release."
      : `fabr's TypeScript driver drives typescript ${range}, but found ${version}: it resolves modules through hooks added in ` +
        `${MINIMUM_TYPESCRIPT}.0, so an older compiler would find none of the build's dependencies.`
  );
}

/** An emitted declaration file, in each of its spellings. */
const DECLARATION_FILE = /\.d\.[cm]?ts$/;

/** The digest a shape (an interface artifact's content hash) is taken with.
 * Purely this driver's: both sides of the comparison — the staged base output
 * and this run's emit — are hashed here. */
const SHAPE_DIGEST = "sha256";

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
   * answer is not always the answer: a package may describe its formats under
   * `import`/`require` and keep its only declaration file behind a `types` key
   * listed AFTER them, which reading the first answer and stopping renders
   * untyped. The package's preferences are walked in its own order until one of
   * them declares something — which is the compiler's own behaviour, and why a
   * types-preferring pass would be wrong: a package whose `require` format has its
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
  host.resolveModuleNameLiterals = (literals, containingFile) => literals.map(literal => resolveModule(literal.text, containingFile));
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

/**
 * Put every union and every type literal in an emitted declaration into one
 * canonical member order.
 *
 * TypeScript orders a union by type id, and ids are handed out as types are
 * first created anywhere in the program — so a full compile and a wave print the
 * same type differently, which breaks determinism and expands the next wave off
 * a spuriously moved shape (see DESIGN-file-deps.md). Applied to every compile,
 * full and wave alike, so the two agree by construction.
 *
 * Type literals only, never an `interface` or a class: inference never
 * synthesizes an interface, so one is always authored and already deterministic.
 * Unnamed members — call, construct and index signatures — never move, since
 * overload resolution reads them in order.
 *
 * Rewritten by splicing spans, never by reprinting, so every separator and
 * indent stays where the compiler put it; nesting is canonicalized
 * innermost-first, so the result does not depend on visit order.
 */
export function canonicalizeUnions(ts: ITypeScript, fileName: string, text: string): string {
  /* Neither construct can be present without one of these, and many declarations
   * have neither: this skips the parse for them rather than the work, which is
   * where the cost is. */
  if (!text.includes("|") && !text.includes("{")) {
    return text;
  }
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  /** The text of a node's own name, or undefined for one with none. */
  const nameOf = (node: ISyntaxNode): string | undefined =>
    node.name === undefined ? undefined : text.slice(node.name.getStart(source), node.name.end);
  /** Code-unit order, never a locale comparison: the point is one answer on
   * every machine. Ties keep their original order, which is what makes the
   * result total. */
  const byKey = (keys: ReadonlyArray<string>, indices: ReadonlyArray<number>): number[] =>
    [...indices].sort((a, b) => (keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : a - b));
  /** The canonical text of everything between `from` and `to`, with each child
   * replaced by its own canonical text and every gap between them — punctuation,
   * whitespace, comments — carried across untouched. */
  function splice(node: ISyntaxNode, from: number, to: number): string {
    let out = "";
    let cursor = from;
    ts.forEachChild(node, child => {
      const at = (child as ISyntaxNode).getStart(source);
      if (at < cursor) {
        return;
      }
      out += text.slice(cursor, at) + canonical(child as ISyntaxNode);
      cursor = (child as ISyntaxNode).end;
    });
    return out + text.slice(cursor, to);
  }
  /** The members' canonical texts, rearranged into `order` and spliced back into
   * the spans they came from — so only the order changes. */
  function rearrange(
    node: ISyntaxNode,
    members: ReadonlyArray<ISyntaxNode>,
    at: (member: ISyntaxNode) => number,
    order: number[]
  ): string {
    const texts = members.map(member => canonical(member, at(member)));
    let out = "";
    let cursor = node.getStart(source);
    members.forEach((member, index) => {
      out += text.slice(cursor, at(member)) + texts[order[index]];
      cursor = member.end;
    });
    return out + text.slice(cursor, node.end);
  }
  function canonical(node: ISyntaxNode, from = node.getStart(source)): string {
    if (ts.isUnionTypeNode(node) && (node.types ?? []).length > 1) {
      const members = node.types!;
      const texts = members.map(member => canonical(member));
      return rearrange(
        node,
        members,
        member => member.getStart(source),
        byKey(
          texts,
          members.map((_, index) => index)
        )
      );
    }
    if (ts.isTypeLiteralNode(node) && (node.members ?? []).length > 1) {
      const members = node.members!;
      const names = members.map(member => nameOf(member) ?? "");
      /* Only the named members move, and only into each other's slots: an
       * unnamed one keeps its index exactly. */
      const named = members
        .map((member, index) => (member.name === undefined ? undefined : index))
        .filter((i): i is number => i !== undefined);
      const sorted = byKey(names, named);
      const order = members.map((_, index) => index);
      named.forEach((slot, index) => {
        order[slot] = sorted[index];
      });
      return rearrange(node, members, member => member.pos, order);
    }
    return splice(node, from, node.end);
  }
  return splice(source, 0, text.length);
}

/** Where a compile's sources are rooted, where its output lands, and whether
 * `.tsx` keeps its own extension. */
interface IEmitLayout {
  rootDir?: string;
  outDir?: string;
  preserveJsx: boolean;
  /** What `.js` output is renamed to (`--emit-extension`), for a caller shipping
   *  this compile beside another one's. Only the extension a plain `.ts`/`.js`
   *  source lands on moves: a source that pinned its own format (`.mts`, `.cjs`)
   *  already names one and keeps it. See {@link RENAMED_EXTENSION}. */
  jsExtension?: string;
}

/** The runtime extension each source extension emits as; absent means this
 * compiler emits nothing for it. */
const EMITTED_EXTENSION = new Map<string, string>([
  [".ts", ".js"],
  [".tsx", ".js"],
  [".mts", ".mjs"],
  [".cts", ".cjs"],
  [".js", ".js"],
  [".jsx", ".js"],
  [".mjs", ".mjs"],
  [".cjs", ".cjs"],
  [".json", ".json"],
]);

/**
 * Where this compile's output for `source` lands, or undefined where it has none
 * to name: a declaration, another producer's extension, a source outside
 * `rootDir`, or an `outDir` whose `rootDir` is unstated (the compiler infers
 * that from the whole file list, which is not given here). Undefined means leave
 * the specifier as written. With no `outDir` the output sits beside its source.
 */
export function emittedPathOf(source: string, layout: IEmitLayout): string | undefined {
  if (DECLARATION_FILE.test(source)) {
    return undefined;
  }
  const extension = path.extname(source);
  const mapped = extension === ".tsx" && layout.preserveJsx ? ".jsx" : EMITTED_EXTENSION.get(extension);
  if (mapped === undefined) {
    return undefined;
  }
  /* The rename applies to `.js` alone, so it moves exactly the output whose
   * format is the compile's to decide; `.mjs`/`.cjs` came from a source that
   * pinned its own and must not be renamed out of it. */
  const emitted = mapped === ".js" && layout.jsExtension !== undefined ? layout.jsExtension : mapped;
  const renamed = (name: string): string => name.slice(0, -extension.length) + emitted;
  if (layout.outDir === undefined) {
    return renamed(source);
  }
  if (layout.rootDir === undefined) {
    return undefined;
  }
  const relative = path.relative(layout.rootDir, source);
  return relative.startsWith("..") || path.isAbsolute(relative) ? undefined : path.join(layout.outDir, renamed(relative));
}

/** The specifier naming `target` from a file emitted into `from`: relative, said
 * explicitly (a bare `bar.js` would name a package), in forward slashes. */
export function emittedSpecifier(from: string, target: string): string {
  const relative = path.relative(from, target).split(path.sep).join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

/**
 * Rewrite each relative module specifier to name the file this compile emitted
 * for it — `./bar` to `./bar.js`, `./dir` to `./dir/index.js` — as node's ESM
 * loader requires and tsc will never write (microsoft/TypeScript#16577; fabr
 * can, having chosen the emit format).
 *
 * Two things this must not be simplified into. It resolves rather than appending
 * an extension, because only resolution tells a directory from a file and knows
 * `./bar.js` already names `bar.ts` — which is also what makes it idempotent;
 * anything resolving nowhere, or to something this compile does not emit, is
 * left as written. And it is a transform rather than a pass over the emitted
 * text, because a string constant holding import syntax is indistinguishable
 * from an import to a scanner. Synthesized literals survive emit precisely
 * because the emitter reprints original source text and a factory node has none.
 */
function specifierRewriter(
  ts: ITypeScript,
  resolve: (specifier: string, containingFile: string) => string | undefined,
  layout: IEmitLayout | undefined,
  /**
   * Told about every specifier position this traversal passes, in the form it
   * was AUTHORED — before any rewrite of it, which is the only form a later
   * build can re-resolve (`./foo.js` is what this compile's ES-module emit
   * writes, not what the source said).
   *
   * Applied to the DECLARATION traversal, it is how forwarding edges are
   * recorded: the emitter's own synthesized `import("…")` types pass through
   * here, and those are precisely the edges no import in the source spells.
   * Scanning the emitted text instead would see the rewritten specifiers and
   * could not tell an import from a string constant that looks like one.
   */
  observe?: (containingFile: string, specifier: string) => void
): TransformerFactory {
  return context => sourceFile => {
    /* With no layout there is nothing to rewrite (a CommonJS emit resolves its
     * own extensionless specifiers), and the traversal runs as an observer
     * alone — which it must, because forwarding edges are a property of the
     * declarations, not of the module format they were emitted for. */
    const emitted = layout && emittedPathOf(sourceFile.fileName, layout);
    if (emitted === undefined && observe === undefined) {
      return sourceFile;
    }
    const from = emitted === undefined ? undefined : path.dirname(emitted);
    /** The replacement for a specifier node, or undefined to leave it be — which
     * covers anything that is not a rewritable specifier, so a caller may hand
     * over whatever sits in the position. */
    const rewrite = (node: INode | undefined): INode | undefined => {
      if (node === undefined || !ts.isStringLiteral(node)) {
        return undefined;
      }
      const specifier = (node as IStringLiteralNode).text;
      /* Before the relative-specifier filter below: a bare name is not
       * rewritable, but a declaration that imports one forwards that package's
       * interface to everyone who consumes it. */
      observe?.(sourceFile.fileName, specifier);
      if (from === undefined || !specifier.startsWith(".")) {
        return undefined;
      }
      const resolved = resolve(specifier, sourceFile.fileName);
      const target = resolved === undefined ? undefined : emittedPathOf(resolved, layout!);
      if (target === undefined) {
        return undefined;
      }
      const next = emittedSpecifier(from, target);
      return next === specifier ? undefined : ts.factory.createStringLiteral(next);
    };
    /* One matcher per form that can hold a module specifier: rebuilt node, or
     * undefined for "not mine, or nothing to change". */
    const forForm = <T extends INode>(is: (node: INode) => boolean, rebuild: (node: T) => INode | undefined) => {
      return (node: INode): INode | undefined => (is(node) ? rebuild(node as T) : undefined);
    };
    const rewritten = [
      forForm<IImportDeclarationNode>(
        node => ts.isImportDeclaration(node),
        decl => {
          const next = rewrite(decl.moduleSpecifier);
          return (
            next &&
            ts.factory.updateImportDeclaration(decl, decl.modifiers, decl.importClause, next, decl.attributes ?? decl.assertClause)
          );
        }
      ),
      forForm<IExportDeclarationNode>(
        node => ts.isExportDeclaration(node),
        decl => {
          const next = rewrite(decl.moduleSpecifier);
          return (
            next &&
            ts.factory.updateExportDeclaration(
              decl,
              decl.modifiers,
              decl.isTypeOnly,
              decl.exportClause,
              next,
              decl.attributes ?? decl.assertClause
            )
          );
        }
      ),
      /* `import("./x").T` — what the declaration emitter writes for a type it
       * cannot otherwise name. Extensionless it is TS2834 for a node16/nodenext
       * consumer, and under skipLibCheck that is suppressed and the type quietly
       * becomes `any` instead. */
      forForm<IImportTypeNode>(
        node => ts.isImportTypeNode(node),
        type => {
          const next = ts.isLiteralTypeNode(type.argument) ? rewrite((type.argument as ILiteralTypeNode).literal) : undefined;
          return (
            next &&
            ts.factory.updateImportTypeNode(
              type,
              ts.factory.createLiteralTypeNode(next),
              type.attributes ?? type.assertions,
              type.qualifier,
              type.typeArguments,
              type.isTypeOf
            )
          );
        }
      ),
      /* `import("./x")` — the dynamic form, which reaches the emitted chunk verbatim. */
      forForm<ICallExpressionNode>(
        node => ts.isCallExpression(node),
        call => {
          const next = call.expression.kind === ts.SyntaxKind.ImportKeyword ? rewrite(call.arguments[0]) : undefined;
          return (
            next && ts.factory.updateCallExpression(call, call.expression, call.typeArguments, [next, ...call.arguments.slice(1)])
          );
        }
      ),
    ];
    const visit = (node: INode): INode => {
      for (const match of rewritten) {
        const next = match(node);
        if (next !== undefined) {
          return next;
        }
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(sourceFile, visit);
  };
}

/**
 * The layout an ES-module emit is rewritten in, or undefined where no rewrite
 * applies: CommonJS resolves extensionless specifiers itself, `preserve` exists
 * to keep what was written, and `node16`/`nodenext` decide per file from the
 * enclosing package's type — a judgment this driver would have to reproduce
 * rather than read.
 */
function emitLayoutOf(ts: ITypeScript, options: CompilerOptions, root: string, jsExtension?: string): IEmitLayout | undefined {
  if (!emitsEsModules(ts, options)) {
    return undefined;
  }
  const directory = (value: unknown): string | undefined => (typeof value === "string" ? path.resolve(root, value) : undefined);
  return {
    rootDir: directory(options.rootDir),
    outDir: directory(options.outDir),
    preserveJsx: options.jsx === ts.JsxEmit.Preserve,
    jsExtension,
  };
}

/**
 * What each `--emit-extension` renames the compile's own `.js` family to: the
 * JavaScript, its declaration, and its source map. This table IS the set of
 * accepted extensions, so what the driver claims to support and what it knows
 * how to spell cannot drift apart.
 *
 * Only the `.js` family appears, because only its format is the compile's to
 * decide: a `.cjs` emitted from a `.cts` source carries the format that source
 * pinned, and so does its `.d.cts`.
 */
const RENAMED_EXTENSION = new Map<string, ReadonlyArray<readonly [RegExp, string]>>([
  [
    ".mjs",
    [
      [/\.d\.ts$/, ".d.mts"],
      [/\.js\.map$/, ".mjs.map"],
      [/\.js$/, ".mjs"],
    ],
  ],
]);

/**
 * The name an emitted file ships under once the compile's `.js` family is
 * renamed — `index.js` → `index.mjs`, `index.d.ts` → `index.d.mts`,
 * `index.js.map` → `index.mjs.map` — or the name unchanged where the rename does
 * not reach it.
 */
export function renamedOutput(fileName: string, jsExtension: string | undefined): string {
  for (const [pattern, replacement] of (jsExtension === undefined ? undefined : RENAMED_EXTENSION.get(jsExtension)) ?? []) {
    if (pattern.test(fileName)) {
      return fileName.replace(pattern, replacement);
    }
  }
  return fileName;
}

/**
 * Repoint a renamed file's own references to its sibling map: the emitted
 * JavaScript's `//# sourceMappingURL=` comment, and the map's `file` field. Both
 * name the pre-rename spelling, and a map whose `file` disagrees with the
 * artifact is what a debugger fails to line up.
 */
function retargetSourceMap(fileName: string, text: string, jsExtension: string): string {
  if (fileName.endsWith(".js.map")) {
    /* Patched through the parser rather than by pattern: `sourcesContent` embeds
     * whole source files, so a textual match for the `file` field could as
     * easily land inside one of them. */
    const map = JSON.parse(text) as { file?: unknown };
    if (typeof map.file === "string" && map.file.endsWith(".js")) {
      map.file = `${map.file.slice(0, -".js".length)}${jsExtension}`;
    }
    return JSON.stringify(map);
  }
  if (fileName.endsWith(".js")) {
    /* Anchored at the end of the file, where the emitter puts the link: the same
     * text can appear earlier inside a string literal in the compiled source —
     * likely enough in a build tool, which is the kind of package this compiles. */
    return text.replace(
      /(\/\/# sourceMappingURL=[^\n]*)\.js\.map(\s*)$/,
      (whole, prefix: string, tail: string) => `${prefix}${jsExtension}.map${tail}`
    );
  }
  return text;
}

/**
 * Resolve as the compilation does, for the rewrite to ask what a relative
 * specifier names. The compiler's own entry point rather than the host hook
 * above, which exists to answer PACKAGE names from the manifest — a relative
 * specifier probes where it is told, and is the compiler's business either way.
 * The cache keeps asking again (the program resolved these once already) from
 * costing a second probe per import.
 */
function moduleResolver(
  ts: ITypeScript,
  host: ICompilerHost,
  options: CompilerOptions,
  root: string
): (specifier: string, containingFile: string) => string | undefined {
  const cache = ts.createModuleResolutionCache(root, name => host.getCanonicalFileName(name), options);
  return (specifier, containingFile) =>
    ts.resolveModuleName(specifier, containingFile, options, host, cache).resolvedModule?.resolvedFileName;
}

/** Whether the project emits ES modules: the ES2015..ESNext block, which stops
 * short of `node16`/`nodenext` (per-file) and `preserve` (as written). */
function emitsEsModules(ts: ITypeScript, options: CompilerOptions): boolean {
  const module = options.module;
  return typeof module === "number" && module >= ts.ModuleKind.ES2015 && module < ts.ModuleKind.Node16;
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
  assertDrivableCompiler(ts.version);
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
  const reportPath = depsReportOf(argv);
  /* The directory this driver's own kept files live in, staged in and collected
   * out again by the caller. Naming it is what asks for incremental mode. */
  const stateDirectory = argOf(argv, STATE_DIR_FLAG);
  /* What the compiler itself opened, recorded at the one place every read goes
   * through. The program's file list is the headline answer, but only this sees
   * the reads resolution makes on the way to it — a package's `package.json`,
   * a nested one a subpath resolves through — which is the half `--listFiles`
   * cannot give and which decides what a specifier names. */
  const opened: string[] = [];
  const readFile = host.readFile;
  if (reportPath !== undefined && readFile !== undefined) {
    host.readFile = (file: string, encoding?: string): string | undefined => {
      opened.push(file);
      return readFile.call(host, file, encoding);
    };
  }
  const resolver = PnpResolver.load(root, conditionsOf(ts, parsed.options));
  /* Manifest faults in the DEPENDENCIES: collected while resolving and reported
   * with everything else, rather than aborting the compilation the moment one
   * unreadable package is touched. */
  const faults = new Set<string>();
  if (resolver) {
    installResolution(ts, host, parsed.options, resolver, root, faults);
  }
  /* Resolution as the compilation does it, for the rewrite to ask what a
   * relative specifier names and for the wave to ask what an edge names. */
  const resolve = moduleResolver(ts, host, parsed.options, root);
  /* Incremental mode: the caller stages this driver's own memo of the last
   * green build into the state directory and hands over the names whose bytes
   * moved since; the driver plans what that change reaches, checks and emits
   * only that, and leaves the memo the next run works from back in the same
   * directory. With no `--state-dir` the whole program is compiled, exactly as
   * before — the flag is the whole of the difference. */
  const handover = memoHandoverOf(argv, root);
  if (handover !== undefined && reportPath === undefined) {
    throw new Error(`tsc-driver: ${STATE_DIR_FLAG} needs ${DEPS_REPORT_FLAG}, which is where the run's reads are reported`);
  }
  const namer = nodeNamer(root, resolver);
  const emitDirectory = emitDirectoryOf(parsed.options, root);
  const plan =
    handover === undefined
      ? undefined
      : planCompile(
          handover.changes,
          handover.memo,
          new Set(parsed.fileNames.map(namer).filter((name): name is string => name !== undefined)),
          sourceRootOf(parsed.options, root)
        );
  if (plan !== undefined) {
    prepareEmitTree(root, emitDirectory, plan);
  }
  /**
   * Whether the program currently built is rooted at a SUBSET of the project.
   *
   * A fact about this program rather than about the plan, and the two differ on
   * exactly the run that matters: the fallback below rebuilds rooted at
   * everything from the same plan, so a guard reading the plan's own bound would
   * answer the same both times — bailing a second time, and a bail emits
   * nothing, which the caller would commit as a green build of an empty delta.
   */
  let boundRooted = false;
  const graph =
    plan === undefined
      ? undefined
      : createWaveRun(ts, plan, root, resolver, resolve, () => boundRooted, parsed.fileNames, emitDirectory);
  const resolveLiterals = host.resolveModuleNameLiterals;
  if (graph !== undefined && resolveLiterals !== undefined) {
    /* Every specifier the program resolves, recorded where the answer is
     * already being computed: these are the use edges, and — for a dependency's
     * declaration file, which has no body — its forwarding ones. */
    host.resolveModuleNameLiterals = (literals, containingFile, redirected, options, containingSourceFile, reused) => {
      const answers = resolveLiterals.call(host, literals, containingFile, redirected, options, containingSourceFile, reused);
      literals.forEach((literal, index) =>
        graph.resolved(containingFile, literal.text, answers[index]?.resolvedModule?.resolvedFileName)
      );
      return answers;
    };
  }
  /**
   * The program the wave runs against, rooted at the caller's **bound**.
   *
   * The rest of the project is excluded from the ROOTS only, never from the
   * program: the compiler pulls in whatever the roots import, as ordinary
   * sources with the standing they have in a full compile. What shrinks is
   * construction, not meaning — which is why a wave's emit is byte-identical to
   * a full compile's.
   *
   * `undefined` roots at every project file: a cold build, a caller that could
   * not bound its change, and the fallback below.
   */
  const buildProgram = (roots: ReadonlySet<string> | undefined): IProgram => {
    boundRooted = roots !== undefined;
    return ts.createProgram({
      rootNames: programRoots(parsed, roots, root),
      options: parsed.options,
      host,
      projectReferences: parsed.projectReferences,
    });
  };
  let program = buildProgram(plan?.roots);
  /* Relative specifiers are corrected during emit, where resolution answers what
   * each names; the rewrites below then act on the text that produces. One
   * rewriter serves both phases — the JavaScript and the declarations land in
   * the same directory, so they name each other identically. */
  const jsExtension = emitExtensionOf(argv);
  const layout = emitLayoutOf(ts, parsed.options, root, jsExtension);
  if (jsExtension !== undefined && layout === undefined) {
    /* Renaming without rewriting is the exact failure `--emit-extension` refuses
     * `.cjs` for, and it is reachable the other way round too: only an ES-module
     * emit has its specifiers corrected ({@link emitLayoutOf}), so a CommonJS one
     * renamed to `.mjs` would ship CommonJS syntax under a name node reads as an
     * ES module, its extensionless `require`s naming files that are not there. */
    throw new Error(`tsc-driver: --emit-extension needs an ES-module emit; this project's 'module' produces CommonJS`);
  }
  const rewriter = layout && specifierRewriter(ts, resolve, layout);
  /* The declaration traversal doubles as the forwarding-edge recorder, and so
   * runs whether or not there is anything to rewrite: what a file republishes
   * through its own interface is a property of its declarations, not of the
   * module format they were emitted for. Under a CommonJS emit `layout` is
   * undefined and this transformer observes without changing a node. */
  const declarations =
    graph === undefined ? rewriter : specifierRewriter(ts, resolve, layout, (file, specifier) => graph.forwards(file, specifier));
  const transformers =
    rewriter === undefined && declarations === undefined
      ? undefined
      : { ...(rewriter ? { before: [rewriter] } : {}), ...(declarations ? { afterDeclarations: [declarations] } : {}) };
  /* Declarations are rewritten on their way out rather than re-read afterwards:
   * the emitter hands each file over here, so nothing incorrect is ever written
   * and the step's output is collected from a tree that was never wrong. */
  const writeEmitted: WriteFile = (fileName, text, writeByteOrderMark) => {
    const declaration = DECLARATION_FILE.test(fileName);
    const rewritable = resolver !== undefined && declaration;
    const rewritten = rewritable ? rewriteDeclaration(fileName, text, resolver) : text;
    /* After the declaration rewrite, which reports a pool path as a fault: this
     * one relativizes the compile's own root, and a fault must not be quietly
     * tidied into something that looks fine. */
    const relativized = relativizeBuildRoot(rewritten, root);
    /* **Ordering invariant, both sides.** LAST of the text corrections, so the
     * order it settles on is the order that ships — a specifier rewritten above
     * sits inside `import("…").T` members, and sorting first would key on text
     * this file never emits. And BEFORE `graph.emitted`, which takes the shape
     * hash: the base's shape came from a committed entry written through here,
     * so hashing non-canonical text would report a shape change on every re-emit
     * of a union — the wave expansion this exists to stop. */
    const canonical = declaration ? canonicalizeUnions(ts, fileName, relativized) : relativized;
    /* The rename lands here rather than on the emitted tree afterwards: the
     * specifiers inside were written by the transformer against the same
     * layout, so the two agree by construction. Only the file's own map
     * references still name the pre-rename spelling. */
    const retargeted = jsExtension === undefined ? canonical : retargetSourceMap(fileName, canonical, jsExtension);
    const written = renamedOutput(fileName, jsExtension);
    graph?.emitted(written, declaration, retargeted, writeByteOrderMark);
    host.writeFile(written, retargeted, writeByteOrderMark);
  };
  let fellBack = false;
  let built = graph === undefined ? undefined : graph.run(program, transformers, writeEmitted);
  if (graph !== undefined && graph.needsFallback()) {
    /* The safety net: the wave needed a file this program was not holding. With
     * a correct bound there is one way here — the change turned out to affect
     * global scope, which only parsing reveals. The other is a bound bug, netted
     * rather than trusted, and reported either way.
     *
     * Rooting at everything is what makes the rerun terminate as well as what
     * makes it correct: the guard asks what THIS program is rooted at, so a
     * program rooted at everything cannot trip it again. Nothing partial is
     * emitted from an abandoned run.
     *
     * Do not pass `oldProgram`: TypeScript refuses structural reuse outright
     * when the root list differs, which is the whole of what this rebuild
     * does. */
    program = buildProgram(undefined);
    built = graph.run(program, transformers, writeEmitted);
    fellBack = true;
  }
  const emitted = built ?? program.emit(undefined, writeEmitted, undefined, false, transformers);
  /* After emit, so the declaration rewriter's own resolution work counts as the
   * reading it is. Both written whether or not the compilation succeeded — a
   * failed run is not cached, so neither is ever asked for. */
  if (reportPath !== undefined && resolver !== undefined) {
    fs.writeFileSync(
      path.resolve(root, reportPath),
      serializeRunReport(readSetOf(program, opened, resolver), resolver.edges(), graph?.telemetry(fellBack))
    );
  }
  const memo = graph?.memo();
  if (stateDirectory !== undefined && memo !== undefined) {
    writeDriverState(path.resolve(root, stateDirectory), memo);
  }
  /* Sorted and deduplicated as the CLI does it: the pre-emit set already
   * carries the project's own option diagnostics, so the config errors overlap
   * it and would otherwise print twice. In wave mode the per-file diagnostics
   * come from the wave itself (a whole-program pass would defeat the point);
   * the compilation's own — the options, and the globals — are still asked once. */
  const diagnostics = ts.sortAndDeduplicateDiagnostics([
    ...parsed.errors,
    ...(graph === undefined ? ts.getPreEmitDiagnostics(program) : graph.diagnostics(program)),
    ...emitted.diagnostics,
  ]);
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
  if (emitsEsModules(ts, options) || (ts.ModuleKind.Preserve !== undefined && module === ts.ModuleKind.Preserve)) {
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
/**
 * The wave, bound to this run: what the driver records while it compiles, and
 * what it reports afterwards.
 *
 * It exists because the two are the same act. Resolution answers what every
 * specifier names, the declaration transformer visits every specifier a file
 * republishes, and the emitter hands over every file written — so the graph
 * fabr will remember is a by-product of compiling, never a second pass over the
 * result. (A pass over emitted text could not do the job anyway: it would see
 * the rewritten specifiers, and could not tell an import from a string constant
 * that looks like one.)
 */
interface IWaveRun {
  /** A specifier the declaration traversal passed, in its authored form — a
   * forwarding edge of `containingFile`. */
  forwards(containingFile: string, specifier: string): void;
  /** A specifier the program resolved, and what it named. */
  resolved(containingFile: string, specifier: string, target: string | undefined): void;
  /** A file the emitter wrote, in its final form. */
  emitted(written: string, isDeclaration: boolean, text: string, byteOrderMark: boolean): void;
  /** Run the wave, answering what a whole-program emit would have. */
  run(program: IProgram, transformers: ICustomTransformers | undefined, write: WriteFile): IEmitResult;
  /** Whether this run must be abandoned and redone rooted at every project file
   * — the wave needed a project file this program was not holding. */
  needsFallback(): boolean;
  /** The diagnostics the wave produced, plus the compilation's own. */
  diagnostics(program: IProgram): readonly Diagnostic[];
  /** The memo for the next build of this target key: the base's, merged
   * with what this run learned (see {@link mergeMemo}). */
  memo(): string;
  /** The run's own account of itself, for the report's telemetry section. */
  telemetry(fellBack: boolean): ICompileTelemetry;
}

function createWaveRun(
  ts: ITypeScript,
  plan: ICompilePlan,
  root: string,
  resolver: PnpResolver | undefined,
  resolve: (specifier: string, containingFile: string) => string | undefined,
  /** Whether the program currently built is rooted at a subset of the project —
   * read per run, since the caller rebuilds rooted at everything and runs
   * again. */
  isBoundRooted: () => boolean,
  /** Every project file the compilation has, rooted or not — the compiler's own
   * account of what is on disk, which is what tells a file the bound wrongly
   * left out from one that is legitimately absent (a deletion). */
  projectFiles: readonly string[],
  /** The output directory as a node-name prefix, so an attributed output is
   * named as the caller's entry names it. */
  emitDirectory: string
): IWaveRun {
  const nodeNameOf = nodeNamer(root, resolver);
  /** The project's files by node name — what EXISTS, as against what this
   * program was rooted at. */
  const onDisk = new Set(projectFiles.map(file => nodeNameOf(file)).filter((name): name is string => name !== undefined));
  /** Every specifier the program resolved, by the file that wrote it — the
   * authority the forwarding observer asks before resolving anything itself. */
  const resolutions = new Map<string, Map<string, string | undefined>>();
  const useEdges = new Map<string, Map<string, IMemoEdge>>();
  const forwardEdges = new Map<string, Map<string, IMemoEdge>>();
  /** The declaration hashes of this run's emit, by source — the new side of the
   * interface comparison. */
  const shapes = new Map<string, string>();
  /** The BASE build's declaration hash, by source — read from the staged base
   * output at the moment this run first overwrites it. */
  const baseShapes = new Map<string, string | undefined>();
  /**
   * What each written name held before THIS PROCESS first wrote it, hashed —
   * memoized for the life of the process, never per run, because the fallback
   * rerun re-emits over its own abandoned attempt's output and must still
   * compare against the BASE build's artifact, not its own first draft's.
   */
  const priorShapes = new Map<string, string | undefined>();
  const priorShapeOf = (written: string): string | undefined => {
    if (!priorShapes.has(written)) {
      let hash: string | undefined;
      try {
        hash = createHash(SHAPE_DIGEST).update(fs.readFileSync(written)).digest("hex");
      } catch {
        /* Nothing staged at this name — an added file, or a base that emitted
         * none — which reads as "no shape to have matched". */
        hash = undefined;
      }
      priorShapes.set(written, hash);
    }
    return priorShapes.get(written);
  };
  const emittedFiles: string[] = [];
  /** Each source that emitted, and the output names it produced — the
   * attribution a later build needs to drop a deleted file's outputs. */
  const outputs = new Map<string, string[]>();
  /** The output directory as a node-name prefix, stripped from an emitted name
   * so the attribution is in the entry's namespace (see below). Empty where the
   * compile emits beside its sources, which needs no stripping. */
  const emitPrefix = emitDirectory;
  const collected: Diagnostic[] = [];
  /** Which file's declarations the emitter is currently writing — set around
   * each per-file emit, which is what attributes a shape to its source without
   * having to infer it from the output's name. */
  let emitting: string | undefined;
  let result: IWaveResult = { wave: [] };
  /** Set when the wave needed a project file this program was not holding — a
   * bound that did not hold, or a change that turned out to affect global scope.
   * Either way the run is void and the caller rebuilds rooted at everything. */
  let fallback = false;
  /** Every file the program holds that is a node of the graph, by its name —
   * built once when the wave runs, and what the report reads back. */
  const byName = new Map<string, ISourceFileInfo>();
  /** Each file's package lookups that found nothing, as the paths they took
   * (see PnpResolver.failedLookupOf) — the memo's `failed` lines. Accumulated
   * like the edges, never cleared per run: a lookup's outcome is a fact of the
   * fixed table, the same both sides of a fallback rerun. */
  const failedLookups = new Map<string, Set<string>>();

  /** An edge, recording its target only where a later build could not re-derive
   * it: a bare name is the package table's answer (as is a package's reference
   * to itself), and anything landing inside a delivered package is bound by
   * machinery membership cannot replay. */
  const edgeFor = (specifier: string, target: string | undefined): IMemoEdge => {
    const named = target === undefined ? undefined : nodeNameOf(target);
    const derivable = isPathSpecifier(specifier) && (named === undefined || resolver?.instanceNameOf(target!) === undefined);
    return derivable || named === undefined ? { specifier } : { specifier, target: named };
  };
  const record = (
    into: Map<string, Map<string, IMemoEdge>>,
    containingFile: string,
    specifier: string,
    target: string | undefined
  ): void => {
    const name = nodeNameOf(containingFile);
    if (name === undefined) {
      return;
    }
    const edges = into.get(name) ?? new Map<string, IMemoEdge>();
    into.set(name, edges);
    edges.set(specifier, edgeFor(specifier, target));
    /* Whether any lookup this specifier's resolution made found nothing — a
     * fact the resolved edge cannot carry: tsc may have settled for the
     * `@types` sidecar (the edge then names it), or for nothing at all, and
     * either way the one change that must re-check this file is the asked-for
     * package APPEARING, which only this line gives an edge to. The sidecar's
     * own probe is asked about too — an untyped import gaining `@types`
     * typings later arrives as THAT absence resolving — and answers only where
     * the probe was actually made and failed. */
    if (!isPathSpecifier(specifier) && resolver !== undefined) {
      const split = splitSpecifier(specifier);
      for (const tried of split === undefined ? [specifier] : [specifier, typesPackageName(split.name)]) {
        const absent = resolver.failedLookupOf(tried, containingFile);
        if (absent !== undefined) {
          const held = failedLookups.get(name) ?? new Set<string>();
          failedLookups.set(name, held);
          held.add(absent);
        }
      }
    }
  };
  const edgeList = (from: Map<string, Map<string, IMemoEdge>>, name: string): IMemoEdge[] =>
    [...(from.get(name)?.values() ?? [])].sort((left, right) => (left.specifier < right.specifier ? -1 : 1));

  return {
    resolved: (containingFile, specifier, target) => {
      const held = resolutions.get(containingFile) ?? new Map<string, string | undefined>();
      resolutions.set(containingFile, held);
      held.set(specifier, target);
      /* A declaration file has no body, so what it imports it forwards — which
       * is what makes a dependency's own imports part of the graph a
       * cross-package wave walks. */
      record(DECLARATION_FILE.test(containingFile) ? forwardEdges : useEdges, containingFile, specifier, target);
    },
    forwards: (containingFile, specifier) => {
      const known = resolutions.get(containingFile);
      const target = known?.has(specifier) === true ? known.get(specifier) : resolve(specifier, containingFile);
      record(forwardEdges, containingFile, specifier, target);
    },
    emitted: (written, isDeclaration, text, byteOrderMark) => {
      const name = nodeNameOf(written);
      if (name !== undefined) {
        emittedFiles.push(name);
        if (emitting !== undefined) {
          /* Which source this output belongs to. Only the compiler knows the
           * mapping — an emit extension renames it, a declaration and a map ride
           * along — so it is RECORDED here rather than reproduced by a caller,
           * and remembering what the compiler did is what lets a later build
           * subtract the outputs of a source that has gone.
           *
           * Named relative to the OUTPUT directory, which is how the caller's
           * entry names them (its collection strips that prefix) and the same
           * namespace a shape is paired in. */
          const attributed = outputs.get(emitting) ?? [];
          outputs.set(emitting, attributed);
          attributed.push(name.startsWith(emitPrefix) ? name.slice(emitPrefix.length) : name);
        }
      }
      if (isDeclaration && emitting !== undefined) {
        /* Both sides of the interface comparison, taken here \u2014 the one moment
         * both artifacts exist: the staged base output still holds the last
         * green build's bytes (this hook runs before the write), and the new
         * declaration is in hand. Pairing by the WRITTEN name is what keeps a
         * `foo.ts` beside a `foo.mts` \u2014 or a renamed `--emit-extension` output
         * \u2014 compared against its own artifact, never a neighbour's. */
        baseShapes.set(emitting, priorShapeOf(written));
        shapes.set(
          emitting,
          createHash(SHAPE_DIGEST)
            .update(byteOrderMark ? `\ufeff${text}` : text)
            .digest("hex")
        );
      }
    },
    needsFallback: () => fallback,
    run: (program, transformers, write) => {
      /* A rebuild re-runs this from scratch, so nothing of the abandoned
       * attempt may survive into the report. */
      byName.clear();
      emittedFiles.length = 0;
      outputs.clear();
      collected.length = 0;
      shapes.clear();
      baseShapes.clear();
      fallback = false;
      for (const file of program.getSourceFiles()) {
        const name = program.isSourceFileDefaultLibrary(file) ? undefined : nodeNameOf(file.fileName);
        if (name !== undefined) {
          byName.set(name, file);
        }
      }
      const isProject = (name: string): boolean =>
        byName.has(name) && resolver?.instanceNameOf(byName.get(name)!.fileName) === undefined;
      let emitSkipped = false;
      const emitDiagnostics: Diagnostic[] = [];
      result = runWave(plan, {
        projectFiles: () => [...byName.keys()].filter(isProject),
        /* What THIS program is rooted at, which is the only form of the question
         * that survives the fallback: the caller re-runs with the same plan
         * against a program rooted at everything, and a guard reading the plan's
         * own bound would answer the same both times (see runWave). */
        isBoundRooted: () => isBoundRooted(),
        /* The wave is becoming every project file: discard the carried base
         * outputs, whose stale members a full emit cannot correct (an output
         * nothing current produces would linger into the entry). */
        expanding: () => wipeEmitTree(root, emitDirectory),
        isGlobal: name => {
          const file = byName.get(name);
          return file === undefined ? undefined : affectsGlobalScope(ts, file);
        },
        targetOf: (from, edge) => {
          if (edge.target !== undefined) {
            return edge.target;
          }
          /* The memo recorded no target because membership was expected to
           * re-derive it — and where the file is still there, this driver can
           * do better than derive it: it resolves as the compilation does.
           * Where it is NOT, live resolution structurally cannot answer (the
           * file an edge names is the file that has gone), and the base build's
           * own list of names is the one world that still holds it. */
          const resolved = resolve(edge.specifier, path.resolve(root, from));
          const live = resolved === undefined ? undefined : nodeNameOf(resolved);
          return live ?? membershipTarget(from, edge.specifier, name => plan.memo.has(name));
        },
        fileFor: name => {
          const file = byName.get(name);
          if (file === undefined) {
            /* The wave needs a file this program does not hold. Where the file
             * EXISTS, that is a bound the caller got wrong — the wave is a subset
             * of the bound by construction, so it should be unreachable — and the
             * run is void rather than answered from a program missing a file it
             * needed to check.
             *
             * Where it does not exist there is nothing to build and nothing
             * wrong: a deleted source (whose dependers the base's edges still
             * reach), or a dependency's declaration, which this compile reads
             * but never emits. */
            if (onDisk.has(name)) {
              fallback = true;
            }
            return undefined;
          }
          if (!isProject(name)) {
            return undefined;
          }
          return () => {
            emitting = name;
            try {
              const emit = program.emit(file, write, undefined, false, transformers);
              emitDiagnostics.push(...emit.diagnostics);
              emitSkipped = emitSkipped || emit.emitSkipped;
            } finally {
              emitting = undefined;
            }
            collected.push(...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file));
            const shape = shapes.get(name);
            if (shape !== undefined) {
              return shape !== baseShapes.get(name);
            }
            /* No interface artifact to compare — an imported `.json`, or a
             * hand-written declaration file, both of whose shape genuinely IS
             * their content. Whether that content moved is exactly what the
             * plan's seeds already say: they are fabr's own hash diff. */
            return plan.seeds?.has(name) ?? true;
          };
        },
      });
      fallback = fallback || result.fellBack === true;
      return { diagnostics: emitDiagnostics, emitSkipped };
    },
    diagnostics: program => [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics(), ...collected],
    memo: () => {
      const learned: DriverMemo = new Map();
      const known = new Set<string>(result.wave);
      for (const [name, file] of byName) {
        if (resolver?.instanceNameOf(file.fileName) !== undefined) {
          /* Every dependency declaration this compile read is knowledge too:
           * those candidate→candidate edges are what a cross-package wave
           * walks, and a `.d.ts` this run never opened is one whose base line
           * still stands. */
          known.add(name);
        } else if (!plan.memo.has(name)) {
          /* A held project file with no line yet — a leaf nothing waves, like
           * an imported `.json` outside the project's include globs. Its line
           * is what makes it a member a later diff's membership replay can
           * find. A held file that HAS a line is left alone: replacing it
           * would lose forwarding edges only an emit of it records. */
          known.add(name);
        }
      }
      for (const name of known) {
        const source = byName.get(name);
        if (source === undefined) {
          /* A deleted file: nothing current is known about it, and saying
           * nothing is what lets the merge drop its line. */
          continue;
        }
        learned.set(name, {
          global: affectsGlobalScope(ts, source),
          use: edgeList(useEdges, name),
          forwarding: edgeList(forwardEdges, name),
          ...(outputs.has(name) ? { outputs: [...outputs.get(name)!].sort() } : {}),
          ...(failedLookups.has(name) ? { failed: [...failedLookups.get(name)!].sort() } : {}),
        });
      }
      return serializeDriverMemo(mergeMemo(plan.memo, plan.deleted, learned));
    },
    telemetry: fellBack => ({
      wave: result.wave,
      ...(result.expanded ? { expanded: result.expanded } : {}),
      emitted: [...new Set(emittedFiles)].sort(),
      ...(fellBack ? { fellBack } : {}),
      diagnostics: [...collected].map(diagnostic => structureDiagnostic(ts, diagnostic, nodeNameOf)),
      ...(plan.roots === undefined ? {} : { bound: { roots: plan.roots.size, project: onDisk.size } }),
    }),
  };
}

/** The compile's output directory as a prefix on node names (`build/`), or the
 * empty string where output lands beside its sources. */
function emitDirectoryOf(options: CompilerOptions, root: string): string {
  const outDir = options.outDir;
  if (typeof outDir !== "string") {
    return "";
  }
  const relative = path.relative(root, path.resolve(root, outDir)).split(path.sep).join("/");
  return relative === "" || relative.startsWith("..") ? "" : `${relative}/`;
}

/** A file's name in the graph: a dependency by the path it is reached by (see
 * PnpResolver.pathNameOf), a file of this compile by its staged path — the same
 * names the read set reports and the change lists arrive in, so a seed finds its
 * node. Undefined for anything that is neither — the compiler's own libraries,
 * which are the toolchain and are keyed as target-key identity rather than as
 * inputs. */
function nodeNamer(root: string, resolver: PnpResolver | undefined): (file: string) => string | undefined {
  return file => {
    const reached = resolver?.pathNameOf(file);
    if (reached !== undefined) {
      return reached;
    }
    const relative = path.relative(root, path.resolve(file)).split(path.sep).join("/");
    return relative.startsWith("..") || path.isAbsolute(relative) ? undefined : relative;
  };
}

/** The compile's source root as a node-name prefix (`src`), or undefined where
 * the project states none — the planner then classifies no project-space
 * change and every change costs a full compile. */
function sourceRootOf(options: CompilerOptions, root: string): string | undefined {
  const rootDir = options.rootDir;
  if (typeof rootDir !== "string") {
    return undefined;
  }
  const relative = path.relative(root, path.resolve(root, rootDir)).split(path.sep).join("/");
  return relative === "" || relative.startsWith("..") ? undefined : relative;
}

/**
 * Make the staged base output tree agree with the plan before anything emits.
 *
 * A full compile (no seeds) starts from nothing — a carried tree could hold
 * outputs nothing current produces, and a whole-project emit cannot correct
 * what it does not write. A wave instead deletes exactly the outputs the memo
 * attributes to sources that are gone: only the compiler that emitted them
 * knew the source→output mapping, which is why the attribution was recorded
 * rather than left to a consumer to reproduce.
 */
function prepareEmitTree(root: string, emitDirectory: string, plan: ICompilePlan): void {
  if (plan.seeds === undefined) {
    wipeEmitTree(root, emitDirectory);
    return;
  }
  for (const name of plan.deleted) {
    for (const output of plan.memo.get(name)?.outputs ?? []) {
      const file = path.resolve(root, emitDirectory, output);
      /* Containment: an attributed name is this driver's own record, but a
       * damaged one must not reach outside the workspace. */
      if (file.startsWith(path.resolve(root) + path.sep)) {
        fs.rmSync(file, { force: true });
      }
    }
  }
}

/** Discard the staged base outputs. A compile emitting beside its sources has
 * no output directory of its own to discard — and never a carried base either,
 * since its caller had nowhere conflict-free to stage one. */
function wipeEmitTree(root: string, emitDirectory: string): void {
  if (emitDirectory === "") {
    return;
  }
  const dir = path.resolve(root, emitDirectory);
  if (dir.startsWith(path.resolve(root) + path.sep)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Whether a file's declarations are facts about the whole program rather than
 * about whoever imports it — the flag that makes a change unbounded, since
 * nothing imports a global and so no edge can reach its dependents.
 *
 * A **script** (a file that is no module) declares everything globally. A
 * module that carries any `declare module`/`declare global` block is treated
 * the same way, which is stricter than the compiler's own rule (only the global
 * form affects global scope): a module augmentation changes what some OTHER
 * module means, and the cost of being wrong here is a missed re-check, while
 * the cost of being conservative is one cold compile of a target key that rarely
 * changes.
 */
function affectsGlobalScope(ts: ITypeScript, file: ISourceFileInfo): boolean {
  /* JSON is neither: it declares nothing, and its shape is its content. */
  if (file.fileName.endsWith(".json")) {
    return false;
  }
  const isModule = ts.isExternalModule ? ts.isExternalModule(file) : file.externalModuleIndicator !== undefined;
  return !isModule || (file.moduleAugmentations ?? []).length > 0;
}

/** A diagnostic as data — enough to compare two runs' outcomes without parsing
 * rendered text, which is what a caller checking wave parity needs. The human
 * rendering is unchanged and still goes to stdout. */
function structureDiagnostic(
  ts: ITypeScript,
  diagnostic: Diagnostic,
  nodeNameOf: (file: string) => string | undefined
): IDriverDiagnostic {
  const info = diagnostic as IDiagnosticInfo;
  const at = info.file !== undefined && info.start !== undefined ? ts.getLineAndCharacterOfPosition(info.file, info.start) : undefined;
  return {
    ...(info.file ? { file: nodeNameOf((info.file as ISourceFileInfo).fileName) ?? (info.file as ISourceFileInfo).fileName } : {}),
    code: info.code,
    /* The compiler's own enum, read through its reverse mapping rather than a
     * table of numbers this driver would have to keep in step. */
    category: String(ts.DiagnosticCategory[String(info.category)] ?? info.category),
    message: ts.flattenDiagnosticMessageText(info.messageText, " "),
    ...(at ? { line: at.line + 1, character: at.character + 1 } : {}),
  };
}

/**
 * What this compilation read of the packages it was given, in the instance
 * names the step translates back to its inputs (see ReadSet.ts) — the answer
 * `tsc --listFiles` gives, plus the two halves a file listing structurally
 * cannot:
 *
 * - the **manifests** resolution consulted. tsc reads a package's `package.json`
 *   to decide which file a specifier names and never lists it, so without this
 *   an `exports` edit would move the answer with nothing in the key to say so.
 * - the **edges** taken: every lookup this run made, named by the path it took.
 *   A file's own row carries its instance's ONE canonical route (pathNameOf),
 *   so a shared package read through two requirers has its bytes named by one
 *   of them — the edge rows are what pin the OTHER requirer's binding, without
 *   which that edge could rebind with nothing in the key to say so. A fallback
 *   resolution is two rows: its access path (which finds nothing) and the
 *   pool's answer, pinned at the answering instance's own canonical route.
 *
 * Everything outside the package pool — the sources, the tool's own install,
 * the compiler's libs — is left out here: those are in the step's anchor, and
 * the resolver answering `undefined` for them is exactly that statement.
 */
function readSetOf(program: IProgram, opened: string[], resolver: PnpResolver): string[] {
  const names = new Set<string>();
  const add = (file: string): void => {
    const name = resolver.pathNameOf(file);
    if (name !== undefined) {
      names.add(name);
    }
  };
  for (const file of program.getSourceFiles()) {
    add(file.fileName);
  }
  for (const file of opened) {
    add(file);
  }
  for (const location of resolver.manifestsConsulted()) {
    add(path.join(location, "package.json"));
  }
  /* Every lookup is a fact this run depended on, named by the path it TOOK —
   * the route to the asker, then the asked name — ending at the manifest every
   * package carries. For a lookup that resolved, the row pins the answering
   * BINDING: the files it answered with may all be named by another requirer's
   * route (one canonical route per instance — pathNameOf), so this row is what
   * moves when this edge alone rebinds. For a lookup that found nothing the
   * path resolves to nothing, and replay reports it as the absence it was. */
  for (const edge of resolver.edges()) {
    const at = resolver.routeOf(edge.from);
    if (at !== undefined) {
      names.add(joinDepsPath([...at, edge.name, "package.json"]));
    }
    /* A fallback resolution is TWO rows: the access path above — which finds
     * nothing, the requirer not binding the name — and the ANSWER, pinned at
     * the winning instance's own canonical route. That is a plain-indexing
     * path (the cache replays, it never resolves a pool), and with the pool
     * restricted to the delivery's one hoist-visible copy it covers the
     * winner being edited, replaced or removed — its recorded rows die with
     * it. The one change it cannot state is an answer APPEARING where nothing
     * answered before, which requires the base build to have been green with
     * the import unresolved. */
    if (edge.via === "fallback") {
      const answered = resolver.routeOf(edge.to);
      if (answered !== undefined) {
        names.add(joinDepsPath([...answered, "package.json"]));
      }
    }
  }
  return [...names];
}

/**
 * The roots the program is built from: the caller's **bound**, intersected with
 * the project files that are actually there. `undefined` roots at everything,
 * which is the whole file list unchanged.
 *
 * Roots rather than the whole file list because **tsc discovers the rest
 * itself**, and discovers it as ordinary source: a root's imports are followed
 * from its current content, transitively, so the program ends up holding the
 * bound plus its import closure. Construction therefore costs the closure a
 * change reaches rather than the project, while every file in the program is
 * the same kind of thing it would be in a full compile.
 *
 * The intersection is what makes a **deletion** an ordinary case: a name in the
 * bound with no file behind it is simply not a root, and the wave reaches its
 * dependers through the base's edges as it does for any other change.
 */
function programRoots(parsed: IParsedCommandLine, roots: ReadonlySet<string> | undefined, root: string): string[] {
  if (roots === undefined) {
    return parsed.fileNames;
  }
  const rooted = new Set([...roots].map(name => path.resolve(root, name)));
  return parsed.fileNames.filter(file => rooted.has(path.resolve(file)));
}

/** What this driver keeps in its state directory: one file, its own memo of the
 * last green build. The name is this driver's — fabr keeps whatever is there
 * and never looks at the names. */
const DRIVER_MEMO_FILE = "memo";

/**
 * What incremental mode was handed about the last green build: the change lists
 * fabr's diff produced, and this driver's own memo back out of the state
 * directory. Undefined without `--state-dir` — the ordinary CLI-parity
 * invocation.
 *
 * The two documents fail differently, because they have different owners. The
 * CHANGES file is fabr's half of the contract: one that cannot be read means
 * the two sides disagree, which is a bug, and the failure it would otherwise
 * hide behind is *permanent full compiles that look exactly like working
 * incrementality* — so it is an error. The MEMO is this driver's own bytes
 * round-tripped through fabr unread: one this build cannot parse is an older
 * format's (or another driver's), and costs a cold compile rather than an
 * error — the version-mismatch-means-cold rule.
 *
 * The pairing is one-directional for the same reason. State handed back with no
 * change lists is fabr contradicting itself — it kept a base and then said
 * nothing about what moved — so it is an error; an empty state directory
 * alongside change lists is ordinary, being a first build or one whose state
 * was lost, and compiles cold.
 */
function memoHandoverOf(argv: string[], root: string): { changes?: IChangeLists; memo?: DriverMemo } | undefined {
  const stateDirectory = argOf(argv, STATE_DIR_FLAG);
  if (stateDirectory === undefined) {
    return undefined;
  }
  let memoText: string | undefined;
  try {
    memoText = fs.readFileSync(path.resolve(root, stateDirectory, DRIVER_MEMO_FILE), "utf8");
  } catch {
    memoText = undefined;
  }
  /* The FILE is what says there is a base, not the flag: a step composes one
   * invocation and only learns whether it kept a last green build once it has
   * looked, so it names the location either way and writes it only when it has
   * one. */
  const changesPath = argOf(argv, CHANGES_FLAG);
  if (changesPath === undefined || !fs.existsSync(path.resolve(root, changesPath))) {
    if (memoText !== undefined) {
      throw new Error(`tsc-driver: state was handed back without ${CHANGES_FLAG}, so nothing says what it is still good for`);
    }
    /* No base: a cold build that still leaves the first memo. */
    return {};
  }
  let changes: IChangeLists;
  try {
    changes = toChangeLists(JSON.parse(fs.readFileSync(path.resolve(root, changesPath), "utf8")));
  } catch (err: unknown) {
    throw new Error(`tsc-driver: unreadable change lists at ${changesPath} (${err instanceof Error ? err.message : String(err)})`);
  }
  const memo = memoText === undefined ? undefined : parseDriverMemo(memoText);
  return { changes, memo };
}

/** Leave the memo the next run works from, in the directory the caller named.
 * The directory need not exist yet — a first build is handed none. */
function writeDriverState(directory: string, memo: string): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, DRIVER_MEMO_FILE), memo);
}

/** `--deps-report <file>`: where to write what this run read, relative to the
 * working directory. Absent (the ordinary CLI-parity invocation) reports
 * nothing. */
function depsReportOf(argv: string[]): string | undefined {
  return argOf(argv, DEPS_REPORT_FLAG);
}

/** A flag's value, or undefined for an absent flag; a flag with nothing after
 * it is an error naming the flag. */
function argOf(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at < 0) {
    return undefined;
  }
  const value = argv[at + 1];
  if (value === undefined) {
    throw new Error(`tsc-driver: ${flag} needs a file`);
  }
  return value;
}

function projectOf(argv: string[]): string {
  const flag = argv.findIndex(arg => arg === "--project" || arg === "-p");
  return flag >= 0 && argv[flag + 1] !== undefined ? argv[flag + 1] : "tsconfig.json";
}

/**
 * `--emit-extension <.mjs>`: what this compile's `.js` output is named instead,
 * so its tree can ship beside another compile's without colliding. A driver
 * option rather than a compiler one — tsc picks an output extension from the
 * source's, and has no setting that would move it.
 *
 * Only `.mjs` is spelled ({@link RENAMED_EXTENSION}). `.cjs` would additionally
 * need the CommonJS emit's specifiers rewritten (`require("./util")` does not
 * find `util.cjs`), which this driver does not do — it rewrites specifiers for
 * an ES-module emit alone.
 */
function emitExtensionOf(argv: string[]): string | undefined {
  const flag = argv.indexOf("--emit-extension");
  if (flag < 0) {
    return undefined;
  }
  const extension = argv[flag + 1];
  if (extension === undefined || !RENAMED_EXTENSION.has(extension)) {
    const accepted = [...RENAMED_EXTENSION.keys()].map(known => `'${known}'`).join(", ");
    throw new Error(`tsc-driver: --emit-extension accepts ${accepted}, not '${extension ?? ""}'`);
  }
  return extension;
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
    readDirectory: (
      dir: string,
      extensions?: readonly string[],
      exclude?: readonly string[],
      include?: readonly string[],
      depth?: number
    ) => ts.sys.readDirectory(dir, extensions, exclude, include, depth),
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
