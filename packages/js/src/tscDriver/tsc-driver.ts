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
 * a workspace without one, but that keeps this a drop-in for an ordinary
 * tsconfig (and is what the stub-compiler test fixtures run through).
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
import type { IConditionSet } from "../pnp/PackageExports";
import { PnpResolver, splitSpecifier, typesPackageName } from "../pnp/PnPResolver";
import { isVirtual, realpathKeepingVirtual, resolveVirtual } from "../pnp/VirtualPath";
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
  resolutionMode?: number;
}
/** A bare specifier split into its package name and subpath. */
type ISplitSpecifier = NonNullable<ReturnType<typeof splitSpecifier>>;
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
  text: string;
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
/* The node shapes the cross-format globals rewrite reads. These are parse-tree
 * nodes (the rewrite runs first among the before-transforms), so `parent` and
 * `getStart` are present; a synthesized replacement never re-enters it. */
interface IIdentifierNode extends INode {
  text: string;
  parent?: INode;
}
interface IMetaPropertyNode extends INode {
  keywordToken: number;
  name: IIdentifierNode;
}
interface IPropertyAccessNode extends INode {
  expression: INode;
  name: INode;
}
interface ITypeOfExpressionNode extends INode {
  expression: INode;
}
interface IShorthandPropertyAssignmentNode extends INode {
  name: IIdentifierNode;
}
/** Where a node's own text sits in its file, for a diagnostic's span. */
interface IPositionedNode extends INode {
  end: number;
  getStart(source: ISourceFileNode): number;
}
/** A symbol as the ambient-reference test reads it: only where its declarations
 * live, which is what tells the global `__dirname` from a file's own binding. */
interface ISymbolInfo {
  declarations?: ReadonlyArray<{ getSourceFile(): { isDeclarationFile: boolean } }>;
}
interface ITypeChecker {
  getSymbolAtLocation(node: INode): ISymbolInfo | undefined;
  getShorthandAssignmentValueSymbol(node: INode): ISymbolInfo | undefined;
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
  getTypeChecker(): ITypeChecker;
}
type WriteFile = (fileName: string, text: string, writeByteOrderMark: boolean) => void;

interface ICompilerHost {
  getCurrentDirectory(): string;
  writeFile: WriteFile;
  /** Every file the compiler opens goes through here — sources, declaration
   * files, and the `package.json`s its resolution consults. */
  readFile?: (fileName: string, encoding?: string) => string | undefined;
  /** How the compiler obtains a source file, which a host may answer for a name
   * that is on no disk. */
  getSourceFile(fileName: string, languageVersion: unknown, onError?: unknown, shouldCreate?: boolean): SourceFile | undefined;
  fileExists(fileName: string): boolean;
  directoryExists?: (directoryName: string) => boolean;
  getDirectories?: (path: string) => string[];
  realpath?: (path: string) => string;
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
  /** Every compiler option this release knows, for asking whether it has one
   * rather than whether its version implies it. Optional: a compiler that does
   * not expose the table answers "no" to every such question. */
  optionDeclarations?: ReadonlyArray<{ name: string }>;
  /** The module kind a compile actually emits, its unstated default applied.
   * Optional: {@link effectiveModule} falls back to the documented default. */
  getEmitModuleKind?: (options: CompilerOptions) => number;
  ModuleKind: { CommonJS: number; ES2015: number; ESNext: number; Node16: number; NodeNext: number; Preserve?: number };
  /** The resolution mode an import is written for (its `resolution-mode`
   * attribute, or what its syntax implies where that decides); the
   * compiler-options parameter arrived in TypeScript 5.3. */
  getModeForUsageLocation?(file: unknown, usage: unknown, options?: CompilerOptions): number | undefined;
  /** The compiler's own version-range matcher — not in its declared API, so
   * optional: without it only the `*` range is known to apply. */
  VersionRange?: { tryParse(text: string): { test(version: string): boolean } | undefined };
  ModuleResolutionKind: { Node10?: number; NodeJs?: number; Node16: number; NodeNext: number; Bundler: number };
  JsxEmit: { Preserve: number };
  SyntaxKind: { ImportKeyword: number };
  /* Node construction and traversal, for the specifier rewrite. The `update`
   * forms take the node's own members back, so a caller passes through
   * everything it is not changing. */
  factory: {
    createStringLiteral(text: string): IStringLiteralNode;
    createIdentifier(text: string): IIdentifierNode;
    createPropertyAccessExpression(expression: INode, name: string | INode): INode;
    createMetaProperty(keywordToken: number, name: INode): INode;
    createCallExpression(expression: INode, typeArguments: unknown, args: readonly INode[]): INode;
    createStrictEquality(left: INode, right: INode): INode;
    createParenthesizedExpression(expression: INode): INode;
    createPropertyAssignment(name: string | INode, initializer: INode): INode;
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
  isIdentifier(node: INode): boolean;
  isMetaProperty(node: INode): boolean;
  isPropertyAccessExpression(node: INode): boolean;
  isTypeOfExpression(node: INode): boolean;
  isTypeQueryNode(node: INode): boolean;
  isQualifiedName(node: INode): boolean;
  isPropertyAssignment(node: INode): boolean;
  isShorthandPropertyAssignment(node: INode): boolean;
  isImportSpecifier(node: INode): boolean;
  isExportSpecifier(node: INode): boolean;
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
  ScriptTarget: { Latest: number; ES2015: number };
  ScriptKind: { TS: number };
  /** Whether a file is a module rather than a script — the compiler's own
   * judgment, since "has an import or an export" has more forms than it looks
   * (a bare `export {}`, `import.meta`, a `.mts` extension). */
  isExternalModule?(file: SourceFile): boolean;
  /** A diagnostic's message text, which is a chain rather than a string. */
  flattenDiagnosticMessageText(text: unknown, newLine: string): string;
  DiagnosticCategory: { Error: number; [name: string]: unknown };
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

/**
 * A declaration file, in each of TypeScript's spellings: `x.d.ts` and the module
 * forms, plus 5.0's arbitrary-extension form `x.d.<ext>.ts` — which is how a
 * hand-written resource declaration is spelled (`logo.d.svg.ts` declares what
 * importing `logo.svg` yields). Narrower, this driver would take one for an
 * ordinary `.ts` and claim it emits `logo.d.svg.js`.
 *
 * JSPackage.ts carries the same rule for the host side; the driver must not
 * import fabr's modules at runtime, so the two are kept in step by hand.
 */
const DECLARATION_FILE = /\.d\.(?:[cm]?ts|[^./]+\.ts)$/;

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
  rewrites?: IImportRewrite[],
  resourceNames?: string[]
): IInstalledResolution {
  const cache = ts.createModuleResolutionCache(root, name => host.getCanonicalFileName(name), options);
  /** The compile's source root, which bounds where a rewrite rule applies and
   * which the declared resource names are relative to. */
  const sourceRoot = typeof options.rootDir === "string" ? path.resolve(root, options.rootDir) : undefined;
  const declared: ReadonlySet<string> = new Set((resourceNames ?? []).map(name => path.resolve(sourceRoot ?? root, name)));
  /** The module system an import is written for when it doesn't say: the
   * output's. */
  const defaultMode = effectiveModule(ts, options) === ts.ModuleKind.CommonJS ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext;
  /* The conditions an import written for `mode` satisfies, including the
   * versioned `types@<range>` keys the running compiler's version admits. */
  const conditionSets = new Map<number, IConditionSet>();
  const conditionsFor = (mode: number): IConditionSet => {
    let set = conditionSets.get(mode);
    if (set === undefined) {
      const plain = new Set(conditionsOf(ts, options, mode));
      set = { has: condition => plain.has(condition) || (plain.has("types") && versionedTypesKeyApplies(ts, condition)) };
      conditionSets.set(mode, set);
    }
    return set;
  };
  /* Package specifiers written without the extension their `exports` target
   * needs, by importing package and specifier: what the emit names instead. */
  const completedSpecifiers = new Map<string, string>();
  /**
   * What the package publishes for a specifier: the resolver's candidates, in
   * the package's own order.
   *
   * An `exports` target names a file exactly — node, bundlers and the compiler
   * add no extension to one — so a target written without one
   * (`"./src/*": "./src/*"` asked for `pkg/src/utils`) names nothing. It is
   * completed instead, as a relative import is: to the file beside it with a
   * runtime extension, or the `index` file of the directory it names, provided
   * the specifier spelled that way resolves through the same map to that same
   * file — which is then what the emit writes ({@link IEmitLayout.packageSpecifier}).
   * A target no such spelling reaches stays a candidate for nothing.
   */
  const published = (specifier: string, issuer: string, conditions: IConditionSet = conditionsFor(defaultMode)): string[] => {
    const candidates = resolver.resolveAll(specifier, issuer, conditions);
    const split = splitSpecifier(specifier);
    if (split === undefined || !resolver.hasExportsMap(split.name, issuer)) {
      return candidates;
    }
    return candidates.flatMap(candidate => {
      if (path.extname(candidate) !== "" || host.fileExists(candidate)) {
        return [candidate];
      }
      const file = RUNTIME_SUFFIXES.map(suffix => candidate + suffix).find(found => host.fileExists(found));
      const spelled = file === undefined ? undefined : specifier + file.slice(candidate.length);
      if (file === undefined || spelled === undefined || !resolver.resolveAll(spelled, issuer, conditions).includes(file)) {
        return [];
      }
      completedSpecifiers.set(`${resolver.locatorOf(issuer)}\0${specifier}`, spelled);
      return [file];
    });
  };
  /** The first path the resolver publishes for a specifier — what node would
   * load, and so the only candidate a resource may be taken from. */
  const publishedPath = (specifier: string, issuer: string): string | undefined => published(specifier, issuer)[0];
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
     * error in the importing code — code that wrote a bare package name.
     *
     * `packageId` is dropped at a virtual location: the compiler redirects every
     * file of a `name@version` it has already loaded to the first copy, and a
     * virtual location is one WIRING of a package whose other wirings share its
     * name and version — the redirect would resolve them all through one. */
    const { packageId, ...module } = resolved.resolvedModule;
    return {
      resolvedModule: {
        ...module,
        ...(isVirtual(module.resolvedFileName) ? {} : { packageId }),
        isExternalLibraryImport: true,
        resolvedUsingTsExtension: undefined,
      },
    };
  };
  /** The first of a package's published `targets` that carries declarations,
   * walked in the package's own order — how the compiler reads a map whose
   * `types` key follows `import`/`require`. For a lookup that loads nothing
   * (a type reference, a library), so no condition gates the others. */
  const typedAmong = (
    targets: readonly string[],
    issuer: string,
    resolveOptions: CompilerOptions
  ): IResolvedModuleWithFailedLookupLocations | undefined => {
    for (const target of targets) {
      const resolved = ts.resolveModuleName(target, issuer, resolveOptions, host, cache);
      if (resolved.resolvedModule && !UNTYPED.test(resolved.resolvedModule.resolvedFileName)) {
        return resolved;
      }
    }
    return undefined;
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
  const through = (
    specifier: string,
    issuer: string,
    conditions: IConditionSet,
    loads: boolean
  ): IResolvedModuleWithFailedLookupLocations | undefined => {
    const candidates = published(specifier, issuer, conditions);
    if (!loads) {
      /* Nothing loads, so no condition gates the others: the first candidate
       * that carries declarations, else the first that resolves at all. */
      let first: IResolvedModuleWithFailedLookupLocations | undefined;
      for (const candidate of candidates) {
        const found = asModule(candidate, issuer);
        if (found !== undefined && !untyped(found)) {
          return found;
        }
        first ??= found;
      }
      return first;
    }
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
    split: ISplitSpecifier | undefined,
    published: IResolvedModuleWithFailedLookupLocations | undefined,
    issuer: string,
    conditions: IConditionSet,
    loads: boolean
  ): IResolvedModuleWithFailedLookupLocations | undefined => {
    const probes: Array<() => IResolvedModuleWithFailedLookupLocations | undefined> = [];
    if (published !== undefined) {
      probes.push(() => siblingTypings(specifier, issuer, conditions));
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
     *
     * An import that loads nothing (`import type`) is the second case whatever
     * the package publishes.
     */
    const declared = split !== undefined && resolver.locationOf(split.name, issuer) !== undefined;
    if (split !== undefined && (published !== undefined || !declared || !loads)) {
      const sidecar = typesPackageName(split.name);
      probes.push(() => through(split.subpath ? `${sidecar}/${split.subpath}` : sidecar, issuer, conditions, loads));
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
  const siblingTypings = (specifier: string, issuer: string, conditions: IConditionSet): IResolvedModuleWithFailedLookupLocations | undefined => {
    const target = published(specifier, issuer, conditions)[0];
    return target === undefined || !FORMAT_TAGGED.test(target) ? undefined : asModule(target.replace(FORMAT_TAGGED, ".js"), issuer);
  };
  /** The package's own `types`/`main`, reached by handing the compiler the
   * package DIRECTORY — the pre-`exports` resolution, which is where a package
   * that never added a `types` condition still keeps its declarations. */
  const legacyTypings = (name: string, issuer: string): IResolvedModuleWithFailedLookupLocations | undefined => {
    const location = resolver.locationOf(name, issuer);
    return location === undefined ? undefined : asModule(location, issuer);
  };
  /**
   * Where a package's `typesVersions` sends a subpath import, for a package
   * with no `exports` map (which would otherwise decide alone): the compiler
   * applies it when it finds a package in `node_modules`, but never when handed
   * a path, which is how a subpath reaches it here.
   */
  const typesVersionsTargets = (split: ISplitSpecifier, issuer: string): string[] => {
    const location = split.subpath === "" ? undefined : resolver.locationOf(split.name, issuer);
    const text = location === undefined ? undefined : host.readFile?.(path.join(location, "package.json"));
    if (location === undefined || text === undefined) {
      return [];
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(text);
    } catch {
      return [];
    }
    if (!isRecord(manifest) || (manifest.exports !== undefined && manifest.exports !== null)) {
      return [];
    }
    const paths = selectedTypesVersion(ts, manifest.typesVersions);
    return paths === undefined ? [] : typesVersionsSubstitutions(paths, split.subpath).map(target => path.join(location, target));
  };
  /**
   * An import of this compile's own package by name, as the relative specifier
   * naming the same path from `issuer` — `mylib/a/x.module.scss` from `b/c.ts`
   * is `../a/x.module.scss` — or undefined for any other specifier.
   *
   * Mapped from the NAME, never by resolving it: a stylesheet is not staged for
   * the compile, so its import resolves only once a rewrite rule has renamed it,
   * and the rules apply to the relative form this produces. A bare own name
   * names the source directory itself.
   */
  const ownRelative = (specifier: string, issuer: string): string | undefined => {
    const split = splitSpecifier(specifier);
    const location = split === undefined ? undefined : resolver.sourceLocationOf(split.name, issuer);
    if (split === undefined || location === undefined) {
      return undefined;
    }
    const relative = path.relative(path.dirname(issuer), path.join(location, split.subpath)).split(path.sep).join("/");
    const spelled = relative === "" ? "." : relative.startsWith("../") || relative === ".." ? relative : `./${relative}`;
    return split.subpath === "" || split.subpath.endsWith("/") ? `${spelled}/` : spelled;
  };
  /** A relative specifier as resolution must look for it: a rewrite rule
   * first, where one names it — the file it names was renamed by an earlier
   * step. The rules select on root-relative names, hence the prefix split; a
   * rule is refused for a specifier leaving the source root, no step here
   * having produced what is up there. */
  const rewritten = (specifier: string, issuer: string): string => {
    const [prefix, selected] = splitRelativePrefix(specifier);
    const renamed =
      rewrites === undefined || !withinSourceRoot(specifier, issuer, sourceRoot) ? undefined : applyImportRewrites(selected, rewrites);
    return renamed === undefined ? specifier : prefix + renamed;
  };
  /**
   * The file an import names when that file is a RESOURCE the compiler cannot
   * read as a module — a stylesheet, an image, a `.wasm` — and it is there:
   * for a relative import, beside the importer (after the rewrite rules); for a
   * package subpath, the file the package's `exports` publishes (so a path it
   * does not publish is never one, however plainly it sits there). The
   * target's own resources are not staged for the compile, so the step names
   * them (`declared`); a dependency's are mounted, so they are asked about.
   */
  const resourceFile = (written: string, issuer: string): string | undefined => {
    const specifier = ownRelative(written, issuer) ?? written;
    const name = splitSpecifier(specifier) !== undefined || specifier.startsWith("#");
    const file = name ? publishedPath(specifier, issuer) : path.resolve(path.dirname(issuer), rewritten(specifier, issuer));
    return file !== undefined && (declared.has(file) || host.fileExists(file)) ? file : undefined;
  };
  /* Side-effect imports of existing resources, by importing file and
   * specifier: the imports whose "cannot find module" the finisher drops. */
  const presentResources = new Set<string>();
  /**
   * Whether an import the compiler left unresolved certainly names a file that
   * is not there: a relative path with an extension (one without, a bundler may
   * complete), or a path into a DELIVERED package that the package does not
   * publish or whose published file is missing. A bare name of no package is
   * not judged — `declare module "virtual:*"` is how a bundler plugin's virtual
   * modules are typed. An import of the compile's own package by name is judged
   * as the relative path it names.
   */
  const certainlyMissing = (written: string, issuer: string): boolean => {
    const specifier = ownRelative(written, issuer) ?? written;
    const split = splitSpecifier(specifier);
    if (split === undefined) {
      if (specifier.startsWith("#") || path.extname(specifier) === "") {
        return false;
      }
      const file = path.resolve(path.dirname(issuer), rewritten(specifier, issuer));
      return !declared.has(file) && !host.fileExists(file);
    }
    const location = split.subpath === "" ? undefined : resolver.locationOf(split.name, issuer);
    if (location === undefined || resolver.instanceNameOf(path.join(location, "package.json")) === undefined) {
      return false;
    }
    const file = publishedPath(specifier, issuer);
    return file === undefined || !host.fileExists(file);
  };
  /* A target that turned the side-effect check off (`ts/allow_unchecked_side_effect_imports`)
   * has its side-effect imports left alone here too. */
  const sideEffectsUnchecked = options[CHECK_SIDE_EFFECT_IMPORTS] === false;
  /* Imports that load and certainly name a missing file, by importing file and
   * specifier, with where the specifier is written: reported by the finisher
   * wherever the compiler reported nothing — a `declare module` pattern let it
   * through, or (before TypeScript 5.6) side-effect imports go unchecked. */
  const missingFiles = new Map<string, { file: SourceFile; start: number; length: number; specifier: string }>();
  /* One answer per (asking package, specifier). A name means the same thing to
   * every file of one package — that is what the table says — so the file part
   * is probed once rather than once per import site: a compile asks tens of
   * thousands of times and holds hundreds of distinct answers. */
  const answers = new Map<string, IResolvedModuleWithFailedLookupLocations>();
  const resolveModule = (
    specifier: string,
    issuer: string,
    mode = defaultMode,
    loads = true
  ): IResolvedModuleWithFailedLookupLocations => {
    const own = ownRelative(specifier, issuer);
    if (own !== undefined) {
      return ts.resolveModuleName(rewritten(own, issuer), issuer, options, host, cache);
    }
    const split = splitSpecifier(specifier);
    if (split === undefined && !specifier.startsWith("#")) {
      /* Not a name at all: a relative or rooted path, which is the compiler's
       * own business and bounded — it probes where it is told, it does not
       * search.
       *
       * A rewrite rule first, where one names this specifier: the file it names
       * was renamed by an earlier step, so what resolution must find is the new
       * name. The rules select on root-relative names, hence the prefix split;
       * a rule is refused for a specifier leaving the source root, no step here
       * having produced what is up there. */
      return ts.resolveModuleName(rewritten(specifier, issuer), issuer, options, host, cache);
    }
    const key = `${resolver.locatorOf(issuer)}\0${specifier}\0${mode}\0${String(loads)}`;
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
    const conditions = conditionsFor(mode);
    const versioned = split === undefined ? undefined : typedAmong(typesVersionsTargets(split, issuer), issuer, options);
    const published = versioned ?? through(specifier, issuer, conditions, loads);
    const answer = (untyped(published) ? recoverTypings(specifier, split, published, issuer, conditions, loads) : undefined) ?? published ?? {};
    answers.set(key, answer);
    return answer;
  };
  host.resolveModuleNameLiterals = (literals, containingFile, _redirected, _options, containingSourceFile) =>
    literals.map(literal => {
      const answer = resolveModule(
        literal.text,
        containingFile,
        ts.getModeForUsageLocation?.(containingSourceFile, literal, options) ?? defaultMode,
        loadsAtRuntime(ts, literal, containingSourceFile)
      );
      if (answer.resolvedModule === undefined && isSideEffectImport(ts, literal) && resourceFile(literal.text, containingFile) !== undefined) {
        presentResources.add(`${containingFile}\0${literal.text}`);
      }
      if (
        answer.resolvedModule === undefined &&
        containingSourceFile !== undefined &&
        loadsAtRuntime(ts, literal, containingSourceFile) &&
        !(sideEffectsUnchecked && isSideEffectImport(ts, literal)) &&
        certainlyMissing(literal.text, containingFile)
      ) {
        const node = literal as IStringLiteralLike & { getStart(file: unknown): number; end: number };
        const start = node.getStart(containingSourceFile);
        missingFiles.set(`${containingFile}\0${literal.text}`, { file: containingSourceFile, start, length: node.end - start, specifier: literal.text });
      }
      return answer;
    });
  /* A project may REPLACE one of the compiler's built-in libraries by depending
   * on `@typescript/lib-<name>` — a package the compiler looks for in
   * node_modules, which the PnP workspace does not have, so it is answered from
   * the same table as any other lookup. Without this the compiler silently
   * falls back to its bundled lib and the difference surfaces as type errors in
   * the project's own code. */
  host.resolveLibrary = (libraryName, resolveFrom, libraryOptions) =>
    typedAmong(published(libraryName, path.join(root, "tsconfig.json")), resolveFrom, libraryOptions) ?? { resolvedModule: undefined };
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
        const conditions = conditionsFor((typeof directive === "string" ? undefined : directive.resolutionMode) ?? defaultMode);
        const fromRoot = published(candidate, root, conditions);
        const resolved = typedAmong(fromRoot.length > 0 ? fromRoot : published(candidate, issuer, conditions), issuer, options);
        if (resolved?.resolvedModule) {
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
  /* A side-effect import of a resource is checked only under
   * `noUncheckedSideEffectImports`, where the compiler reports one it cannot
   * resolve at its specifier — as every resource is, the compiler reading none
   * as a module. That report is dropped where the file is there, so the check
   * still catches a missing one; nothing else about the import changes, and a
   * `declare module` pattern applies to it as it would anywhere. */
  const withoutPresentResources = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] =>
    diagnostics.filter(diagnostic => {
      const info = diagnostic as IDiagnosticInfo & { length?: number };
      const text = (info.file as { text?: string } | undefined)?.text;
      if (!MODULE_NOT_FOUND.has(info.code) || text === undefined || info.start === undefined || info.length === undefined) {
        return true;
      }
      const specifier = text.slice(info.start + 1, info.start + info.length - 1);
      return !presentResources.has(`${(info.file as ISourceFileInfo).fileName}\0${specifier}`);
    });
  /* An import of a missing file the compiler let through — a `declare module`
   * pattern types it, or the compiler does not check side-effect imports — but
   * nothing will load. Reported only where the compiler reported nothing at the
   * same specifier, so never twice. */
  const finishDiagnostics = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] => {
    const kept = withoutPresentResources(diagnostics);
    const reportedAt = new Set(
      kept.map(diagnostic => {
        const info = diagnostic as IDiagnosticInfo;
        return `${(info.file as ISourceFileInfo | undefined)?.fileName ?? ""}\0${String(info.start)}`;
      })
    );
    const added = [...missingFiles.values()]
      .filter(missing => !reportedAt.has(`${(missing.file as unknown as ISourceFileInfo).fileName}\0${String(missing.start)}`))
      .map(
        missing =>
          ({
            file: missing.file,
            start: missing.start,
            length: missing.length,
            messageText: `Cannot find file '${missing.specifier}'.`,
            category: ts.DiagnosticCategory.Error,
            code: MISSING_FILE_ERROR,
          }) as unknown as Diagnostic
      );
    return added.length === 0 ? kept : [...kept, ...added];
  };
  return {
    finishDiagnostics,
    packageSpecifier: (specifier, containingFile) => completedSpecifiers.get(`${resolver.locatorOf(containingFile)}\0${specifier}`),
    ownSpecifier: ownRelative,
  };
}

/** What installing resolution hands back to the compile: the diagnostic
 * finisher, the package specifiers the emit must write completed, and the
 * relative form of an import of the compile's own package. */
interface IInstalledResolution {
  finishDiagnostics(diagnostics: readonly Diagnostic[]): readonly Diagnostic[];
  packageSpecifier(specifier: string, containingFile: string): string | undefined;
  ownSpecifier(specifier: string, containingFile: string): string | undefined;
}

/** What an extensionless `exports` target is completed with, in order: a
 * runtime file beside it, else the `index` of the directory it names. */
const RUNTIME_SUFFIXES = [".js", ".mjs", ".cjs", "/index.js", "/index.mjs", "/index.cjs"];

/** The code of the driver's own report of an import of a missing file — outside
 * every range the compiler assigns. */
const MISSING_FILE_ERROR = 79001;

/** The compiler's "cannot find module" reports, as its lookup of a module
 * specifier makes them. */
const MODULE_NOT_FOUND = new Set([2307, 2792]);

/** Whether `literal` is the specifier of an import that binds nothing
 * (`import "./theme.css"`). */
function isSideEffectImport(ts: ITypeScript, literal: IStringLiteralLike): boolean {
  const parent = (literal as { parent?: INode }).parent;
  return parent !== undefined && ts.isImportDeclaration(parent) && (parent as IImportDeclarationNode).importClause === undefined;
}

/** Whether the import `literal` names loads anything at runtime: not a
 * declaration file's, nor an `import type`/`export type`, nor an `import("…")`
 * type — the runtime's refusals apply only to what runs. */
function loadsAtRuntime(ts: ITypeScript, literal: IStringLiteralLike, file: SourceFile | undefined): boolean {
  if ((file as { isDeclarationFile?: boolean } | undefined)?.isDeclarationFile === true) {
    return false;
  }
  const parent = (literal as { parent?: INode }).parent;
  if (parent === undefined) {
    return true;
  }
  if (ts.isImportDeclaration(parent)) {
    return (parent as IImportDeclarationNode & { importClause?: { isTypeOnly?: boolean } }).importClause?.isTypeOnly !== true;
  }
  if (ts.isExportDeclaration(parent)) {
    return !(parent as IExportDeclarationNode).isTypeOnly;
  }
  return !ts.isLiteralTypeNode(parent);
}

/** Whether the running compiler satisfies a version range, as it judges
 * `typesVersions` keys; without its matcher, only `*` is known to. */
function compilerSatisfies(ts: ITypeScript, range: string): boolean {
  const parsed = ts.VersionRange?.tryParse(range);
  return parsed === undefined ? range.trim() === "*" : parsed.test(ts.version);
}

/** Whether an `exports` condition key is a versioned `types@<range>` key the
 * running compiler satisfies — the compiler's own rule for such keys. */
function versionedTypesKeyApplies(ts: ITypeScript, condition: string): boolean {
  return condition.startsWith("types@") && compilerSatisfies(ts, condition.slice("types@".length));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `typesVersions` path map the running compiler selects — the first entry
 * whose version range it satisfies — or undefined when none applies or the
 * field is not a map. */
function selectedTypesVersion(ts: ITypeScript, typesVersions: unknown): Map<string, string[]> | undefined {
  if (!isRecord(typesVersions)) {
    return undefined;
  }
  for (const [range, paths] of Object.entries(typesVersions)) {
    if (compilerSatisfies(ts, range)) {
      return isRecord(paths)
        ? new Map(
            Object.entries(paths).map(([pattern, substitutions]): [string, string[]] => [
              pattern,
              Array.isArray(substitutions) ? substitutions.filter((sub): sub is string => typeof sub === "string") : [],
            ])
          )
        : undefined;
    }
  }
  return undefined;
}

/** The substitutions a `typesVersions` path map gives `subpath`, matched as the
 * compiler matches `paths`: an exact key, else the single-`*` pattern with the
 * longest prefix, its capture filling each substitution's `*`. */
function typesVersionsSubstitutions(paths: ReadonlyMap<string, string[]>, subpath: string): string[] {
  const exact = paths.get(subpath);
  if (exact !== undefined) {
    return exact;
  }
  let best: { prefix: number; captured: string; substitutions: string[] } | undefined;
  for (const [pattern, substitutions] of paths) {
    const star = pattern.indexOf("*");
    if (star < 0 || pattern.indexOf("*", star + 1) >= 0) {
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    const fits = subpath.length >= prefix.length + suffix.length && subpath.startsWith(prefix) && subpath.endsWith(suffix);
    if (fits && (best === undefined || prefix.length > best.prefix)) {
      best = { prefix: prefix.length, captured: subpath.slice(prefix.length, subpath.length - suffix.length), substitutions };
    }
  }
  return best === undefined ? [] : best.substitutions.map(substitution => substitution.replace("*", best.captured));
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
 * IS the package root, so the remainder maps one for one).
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
 * function of its cache key, and a content-hashed resource name derived from it
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
 * a spuriously moved shape. Applied to every compile, full and wave alike, so the 
 * two agree by construction.
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
  /**
   * What an emitted import specifier is named instead: the specifier as written
   * to the one the emit must name in its place (see {@link REWRITES_FLAG}), as
   * ordered RULES — first match wins.
   *
   * Generic over specifiers, with no notion of what kind of file is being
   * named: a rule states a replacement, and which names have rules is the
   * producer's business. The rules fabr generates today are for stylesheets,
   * where `import styles from "./x.module.scss"` names a file no step produces
   * and the name alone cannot say whether the stand-in is the stylesheet or a
   * shim exporting its class map.
   *
   * A selector matches the specifier as WRITTEN, not the file the import
   * resolves to — two stylesheet spellings reach one declaration shape, so only
   * the written form separates them. Matched against the specifier minus its
   * climb prefix ({@link splitRelativePrefix}), and the replacement then goes
   * through this compile's own extension rule ({@link renamedIfEmitted}).
   *
   * Rules rather than the pairs resolving them against this compile's sources,
   * because the document is action key material: as pairs it grows with the
   * stylesheet count and any one of them appearing rebuilds the whole compile.
   * They arrive pre-compiled to a regex and a `$n` replacement, so applying them
   * needs no glob language here — the producer owns that, and this driver only
   * runs what it was given.
   */
  rewrites?: IImportRewrite[];
  /**
   * Whether relative specifiers additionally get this compile's emitted
   * EXTENSION (`./bar` → `./bar.js`). ES-module-only: a CommonJS emit resolves
   * extensionless specifiers itself.
   *
   * Resource renaming is not gated on it — a `require("./x.module.scss")` names a
   * file no step produces however the module was emitted, and the test pipeline
   * compiles CommonJS. The two rewrites share this traversal and nothing else.
   */
  rewriteExtensions: boolean;
  /** What a package specifier the resolution completed is written as instead
   * (`three/src/math/MathUtils` → `three/src/math/MathUtils.js`), whatever the
   * module system: an `exports` target names a file exactly, for `require` as
   * for `import`. */
  packageSpecifier?: (specifier: string, containingFile: string) => string | undefined;
  /** The relative specifier an import of this compile's own package by name is
   * written as (`mylib/a/x` → `../a/x`), whatever the module system; the
   * relative rewrites then apply to it as to any other. */
  ownSpecifier?: (specifier: string, containingFile: string) => string | undefined;
}

/**
 * A relative specifier split into its climb prefix and the name the rules
 * select on — `../a/x.scss` → `["../", "a/x.scss"]`.
 *
 * The two notations look alike and are not. A rule's selector is a glob over
 * names relative to a ROOT, which cannot climb and admits no `.`/`..` segment.
 * A module specifier is relative to the importing FILE, where the prefix is
 * what makes it relative at all — without it, `x.scss` is a bare specifier,
 * i.e. a package.
 *
 * The prefix is re-attached to whatever the rule produces, which addresses the
 * directory the specifier did so long as the rule preserves depth.
 */
export function splitRelativePrefix(specifier: string): [string, string] {
  const climb = /^(?:\.\.?\/)+/.exec(specifier);
  const prefix = climb === null ? "" : climb[0];
  return [prefix, specifier.substring(prefix.length)];
}

/**
 * Whether a relative specifier names something inside this compile's own source
 * root — the condition for a rewrite rule applying to it. No step of this
 * compile produced a file above the root, so a renamed twin of one would not
 * exist.
 *
 * Lexical: a relative specifier is a path, so this resolves nothing and touches
 * no filesystem. A climb of any depth is ordinary (`../../../etc/x.scss` in a
 * deep tree lands inside the root); what is refused is a climb that leaves.
 */
export function withinSourceRoot(specifier: string, issuer: string, rootDir: string | undefined): boolean {
  if (rootDir === undefined) {
    return false;
  }
  const relative = path.relative(rootDir, path.resolve(path.dirname(issuer), specifier));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** One rewrite rule: a regular expression over import specifiers as written,
 * and the `$n` replacement producing the specifier to emit in its place. */
export interface IImportRewrite {
  pattern: string;
  replacement: string;
}

/**
 * The name the first matching rule gives `relative`, or undefined where none
 * matches.
 *
 * Deliberately the whole of the interpretation: the rules arrive compiled, so
 * this needs nothing but `RegExp`. The trailing tidy-up mirrors the producer's
 * own — an unmatched recursive group substitutes as empty, which can leave a
 * doubled or edge slash for a path at the tree root.
 */
export function applyImportRewrites(relative: string, rules: IImportRewrite[]): string | undefined {
  for (const rule of rules) {
    const expression = new RegExp(rule.pattern);
    if (expression.test(relative)) {
      return relative
        .replace(expression, rule.replacement)
        .replace(/\/{2,}/g, "/")
        .replace(/^\/+|\/+$/g, "");
    }
  }
  return undefined;
}

/**
 * A stand-in name put through this compile's OWN extension rules, where it is
 * something this compile emits.
 *
 * The table's targets are of two kinds and the difference matters under
 * `--emit-extension`. A css-module's shim is an ordinary `.js` SOURCE of this
 * compile, so a compile renaming its JavaScript renames the shim too and the
 * specifier has to follow — otherwise a dual package's ES-module format imports
 * the CommonJS shim while its own sits beside it unused. The stylesheet is not a
 * compile output at all (the css step delivers it), so it is kept verbatim. The
 * same {@link EMITTED_EXTENSION} table decides which is which, so there is no
 * second rule to keep in step.
 */
function renamedIfEmitted(name: string, layout: IEmitLayout): string {
  const extension = path.extname(name);
  const mapped = EMITTED_EXTENSION.get(extension);
  if (mapped === undefined) {
    return name;
  }
  const emitted = mapped === ".js" && layout.jsExtension !== undefined ? layout.jsExtension : mapped;
  return name.slice(0, -extension.length) + emitted;
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
      const written = (node as IStringLiteralNode).text;
      /* Before the relative-specifier filter below: a bare name is not
       * rewritable, but a declaration that imports one forwards that package's
       * interface to everyone who consumes it. */
      observe?.(sourceFile.fileName, written);
      if (from === undefined) {
        return undefined;
      }
      const specifier = layout!.ownSpecifier?.(written, sourceFile.fileName) ?? written;
      if (!specifier.startsWith(".")) {
        const completed = layout!.packageSpecifier?.(specifier, sourceFile.fileName);
        return completed === undefined ? undefined : ts.factory.createStringLiteral(completed);
      }
      const next = relativeSpecifier(specifier) ?? specifier;
      return next === written ? undefined : ts.factory.createStringLiteral(next);
    };
    /** What a relative specifier is written as in the output, or undefined to
     * keep it as it is. */
    const relativeSpecifier = (specifier: string): string | undefined => {
      /* Rules run ahead of the extension rule below and apply whatever the
       * module system: a rule names its replacement outright, where the
       * extension rule only derives one, and `require` names a renamed file no
       * more correctly than `import` does. */
      const [prefix, selected] = splitRelativePrefix(specifier);
      const matched =
        layout!.rewrites === undefined || !withinSourceRoot(specifier, sourceFile.fileName, layout!.rootDir)
          ? undefined
          : applyImportRewrites(selected, layout!.rewrites);
      if (matched !== undefined) {
        return prefix + renamedIfEmitted(matched, layout!);
      }
      if (!layout!.rewriteExtensions) {
        return undefined;
      }
      const resolved = resolve(specifier, sourceFile.fileName);
      const target = resolved === undefined ? undefined : emittedPathOf(resolved, layout!);
      return target === undefined ? undefined : emittedSpecifier(from!, target);
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

/** The CommonJS globals with an `import.meta` spelling to rewrite to under an
 * ES-module emit. */
const CJS_PATH_GLOBALS = new Set(["__dirname", "__filename"]);

/** How each `import.meta` member is spelled in CommonJS; a member absent here
 * is left as written, with the checker's own diagnostic on it. */
const CJS_META_MEMBERS = new Map<string, (f: ITypeScript["factory"]) => INode>([
  ["dirname", f => f.createIdentifier("__dirname")],
  ["filename", f => f.createIdentifier("__filename")],
  [
    "url",
    f =>
      f.createPropertyAccessExpression(
        f.createCallExpression(
          f.createPropertyAccessExpression(
            f.createCallExpression(f.createIdentifier("require"), undefined, [f.createStringLiteral("node:url")]),
            "pathToFileURL"
          ),
          undefined,
          [f.createIdentifier("__filename")]
        ),
        "href"
      ),
  ],
  /* Parenthesized: the access this replaces was a primary expression, and the
   * printer will not add the parens a `!import.meta.main` operand needs. */
  [
    "main",
    f =>
      f.createParenthesizedExpression(
        f.createStrictEquality(f.createPropertyAccessExpression(f.createIdentifier("require"), "main"), f.createIdentifier("module"))
      ),
  ],
]);

/** The checker's "'import.meta' is only allowed when '--module' is …" grammar
 * error, dropped where the rewrite replaced the meta-property it is about. */
const IMPORT_META_MODULE_ERROR = 1343;

interface ICrossFormatGlobals {
  transformer: TransformerFactory;
  /** The run's diagnostics, finished: the checker's TS1343s on meta-properties
   * the rewrite replaced are dropped. */
  finishDiagnostics(diagnostics: readonly Diagnostic[]): readonly Diagnostic[];
}

/**
 * Bridge the module-system globals across an emit whose format differs from the
 * source's shape — an emit-time correction like the specifier rewrite beside it.
 * `@types/node` declares `__dirname`/`__filename` as unconditional ambient
 * globals and the checker accepts `import.meta` wherever the module option
 * allows it, so a CommonJS-shaped source emitted as ES modules (or the reverse
 * — one half of a `dual` package) typechecks clean and throws `ReferenceError`
 * at runtime. Under an ES-module emit, `__dirname`/`__filename` become
 * `import.meta.dirname`/`.filename` (node ≥20.11); under a CommonJS emit,
 * `import.meta` members are rewritten per {@link CJS_META_MEMBERS}. The bridge
 * only rewrites: anything without a rewrite (`require`/`module`/`exports` under
 * an ES-module emit, an unmapped `import.meta` under a CommonJS one) is left
 * exactly as the compiler has it, diagnostics included.
 *
 * Only a reference resolving to an AMBIENT declaration (every declaration in a
 * `.d.ts`) is rewritten — a file shadowing `__dirname` with its own
 * binding keeps it — and a direct `typeof` operand is left alone: rewriting
 * `typeof __dirname` would flip what the guard detects. Scripts are skipped
 * (no module format to bridge), and so are `node16`/`nodenext`/`preserve`
 * projects, whose per-file format follows the source's own declared one.
 *
 * Undefined where no direction applies. `program` is a thunk because the wave
 * fallback rebuilds the program under the same transformers.
 */
function crossFormatGlobals(ts: ITypeScript, options: CompilerOptions, program: () => IProgram): ICrossFormatGlobals | undefined {
  const direction = emitsEsModules(ts, options)
    ? "esm"
    : effectiveModule(ts, options) === ts.ModuleKind.CommonJS
      ? "cjs"
      : undefined;
  if (direction === undefined) {
    return undefined;
  }
  const f = ts.factory;
  /* Meta-property starts this rewrite replaced, per file — the span the
   * checker reports TS1343 at, so the two match up. */
  const disposed = new Map<string, Set<number>>();

  const esmTransform = (context: unknown, sourceFile: ISourceFileNode): INode => {
    const checker = program().getTypeChecker();
    /** Whether `node` is a value reference resolving to the ambient global —
     * every declaration in a declaration file — rather than to a binding of the
     * source's own, or to some property that happens to share the name. */
    const ambientReference = (node: IIdentifierNode): boolean => {
      const parent = node.parent;
      if (parent === undefined) {
        return false;
      }
      if (ts.isPropertyAccessExpression(parent) && (parent as IPropertyAccessNode).name === node) {
        return false;
      }
      if (ts.isPropertyAssignment(parent) && (parent as IPropertyAccessNode).name === node) {
        return false;
      }
      if (ts.isQualifiedName(parent) || ts.isTypeQueryNode(parent) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) {
        return false;
      }
      const symbol = ts.isShorthandPropertyAssignment(parent)
        ? checker.getShorthandAssignmentValueSymbol(parent)
        : checker.getSymbolAtLocation(node);
      const declarations = symbol?.declarations ?? [];
      return declarations.length > 0 && declarations.every(declaration => declaration.getSourceFile().isDeclarationFile);
    };
    const metaAccess = (name: string): INode =>
      f.createPropertyAccessExpression(
        f.createMetaProperty(ts.SyntaxKind.ImportKeyword, f.createIdentifier("meta")),
        name === "__dirname" ? "dirname" : "filename"
      );
    const visit = (node: INode): INode => {
      if (ts.isTypeOfExpression(node)) {
        /* The DIRECT operand of a typeof guard keeps its spelling — rewriting it
         * flips what the guard detects; a deeper expression is visited normally. */
        const operand = (node as ITypeOfExpressionNode).expression;
        if (ts.isIdentifier(operand)) {
          const name = (operand as IIdentifierNode).text;
          if (CJS_PATH_GLOBALS.has(name)) {
            return node;
          }
        }
        return ts.visitEachChild(node, visit, context);
      }
      if (ts.isShorthandPropertyAssignment(node)) {
        /* `{ __dirname }` — the reference is the whole assignment, and its
         * replacement has to carry the property name the shorthand implied. */
        const name = (node as IShorthandPropertyAssignmentNode).name;
        if (CJS_PATH_GLOBALS.has(name.text) && ambientReference(name)) {
          return f.createPropertyAssignment(f.createIdentifier(name.text), metaAccess(name.text));
        }
        return node;
      }
      if (ts.isIdentifier(node)) {
        const name = (node as IIdentifierNode).text;
        if (CJS_PATH_GLOBALS.has(name) && ambientReference(node as IIdentifierNode)) {
          return metaAccess(name);
        }
        return node;
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(sourceFile, visit);
  };

  const cjsTransform = (context: unknown, sourceFile: ISourceFileNode): INode => {
    const isImportMeta = (node: INode): boolean =>
      ts.isMetaProperty(node) && (node as IMetaPropertyNode).keywordToken === ts.SyntaxKind.ImportKeyword;
    const dispose = (node: INode): void => {
      const starts = disposed.get(sourceFile.fileName) ?? new Set<number>();
      starts.add((node as IPositionedNode).getStart(sourceFile));
      disposed.set(sourceFile.fileName, starts);
    };
    const visit = (node: INode): INode => {
      if (ts.isPropertyAccessExpression(node) && isImportMeta((node as IPropertyAccessNode).expression)) {
        const access = node as IPropertyAccessNode;
        const member = ts.isIdentifier(access.name) ? (access.name as IIdentifierNode).text : undefined;
        const replacement = member === undefined ? undefined : CJS_META_MEMBERS.get(member)?.(f);
        if (replacement !== undefined) {
          dispose(access.expression);
          return replacement;
        }
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(sourceFile, visit);
  };

  const scan = direction === "esm" ? [...CJS_PATH_GLOBALS] : ["import.meta"];
  /* A source that pinned its own module format lands in an emitted file node
   * loads as that format whatever the project's `module` says (`legacy.cts`
   * emits into `legacy.cjs`), and there the OTHER direction's globals are the
   * defined ones — so the bridge leaves it alone. */
  const pinned = direction === "esm" ? [".cts", ".cjs"] : [".mts", ".mjs"];
  return {
    transformer: context => sourceFile => {
      if (
        sourceFile.fileName.endsWith(".d.ts") ||
        sourceFile.fileName.endsWith(".json") ||
        pinned.some(extension => sourceFile.fileName.endsWith(extension)) ||
        !scan.some(token => sourceFile.text.includes(token))
      ) {
        return sourceFile;
      }
      /* A script has no module format to bridge (and under an ES-module package
       * is broken in ways no expression rewrite reaches). */
      const isModule = ts.isExternalModule
        ? ts.isExternalModule(sourceFile)
        : (sourceFile as unknown as ISourceFileInfo).externalModuleIndicator !== undefined;
      if (!isModule) {
        return sourceFile;
      }
      return direction === "esm" ? esmTransform(context, sourceFile) : cjsTransform(context, sourceFile);
    },
    finishDiagnostics: diagnostics =>
      diagnostics.filter(diagnostic => {
        const info = diagnostic as IDiagnosticInfo;
        if (info.code !== IMPORT_META_MODULE_ERROR || info.file === undefined || info.start === undefined) {
          return true;
        }
        return disposed.get((info.file as ISourceFileInfo).fileName)?.has(info.start) !== true;
      }),
  };
}

/**
 * The layout this compile's specifiers are rewritten in, or undefined where
 * neither rewrite applies.
 *
 * **Extension** rewriting is ES-module-only: CommonJS resolves extensionless
 * specifiers itself, `preserve` exists to keep what was written, and
 * `node16`/`nodenext` decide per file from the enclosing package's type — a
 * judgment this driver would have to reproduce rather than read. **Resource**
 * rewriting is not, so a table alone earns a layout.
 */
function emitLayoutOf(
  ts: ITypeScript,
  options: CompilerOptions,
  root: string,
  jsExtension?: string,
  rewrites?: IImportRewrite[],
  packageSpecifier?: (specifier: string, containingFile: string) => string | undefined,
  ownSpecifier?: (specifier: string, containingFile: string) => string | undefined
): IEmitLayout | undefined {
  const rewriteExtensions = emitsEsModules(ts, options);
  if (!rewriteExtensions && rewrites === undefined && packageSpecifier === undefined && ownSpecifier === undefined) {
    return undefined;
  }
  const directory = (value: unknown): string | undefined => (typeof value === "string" ? path.resolve(root, value) : undefined);
  return {
    rootDir: directory(options.rootDir),
    outDir: directory(options.outDir),
    preserveJsx: options.jsx === ts.JsxEmit.Preserve,
    jsExtension,
    rewrites,
    rewriteExtensions,
    packageSpecifier,
    ownSpecifier,
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
      [/\.d\.ts\.map$/, ".d.mts.map"],
      [/\.js\.map$/, ".mjs.map"],
      [/\.js$/, ".mjs"],
    ],
  ],
]);

/**
 * The name an emitted file ships under once the compile's `.js` family is
 * renamed — `index.js` → `index.mjs`, `index.d.ts` → `index.d.mts`, and each
 * one's `.map` alongside — or the name unchanged where the rename does not
 * reach it.
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
 * Repoint a renamed file's own references to its sibling map: an emitted
 * file's `//# sourceMappingURL=` comment (JavaScript and declaration alike), and
 * a map's `file` field. Both name the pre-rename spelling, and a map whose
 * `file` disagrees with the artifact is what a debugger fails to line up.
 */
function retargetSourceMap(fileName: string, text: string, jsExtension: string): string {
  if (fileName.endsWith(".map")) {
    /* Patched through the parser rather than by pattern: `sourcesContent` embeds
     * whole source files, so a textual match for the `file` field could as
     * easily land inside one of them. */
    const map = JSON.parse(text) as { file?: unknown };
    if (typeof map.file === "string") {
      map.file = renamedOutput(map.file, jsExtension);
    }
    return JSON.stringify(map);
  }
  /* Anchored at the end of the file, where the emitter puts the link: the same
   * text can appear earlier inside a string literal in the compiled source —
   * likely enough in a build tool, which is the kind of package this compiles.
   * An inline (`data:`) map names no file, so it renames to itself. */
  return text.replace(
    /(\/\/# sourceMappingURL=)([^\n]*?)(\s*)$/,
    (whole, prefix: string, target: string, tail: string) => `${prefix}${renamedOutput(target, jsExtension)}${tail}`
  );
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
  const module = effectiveModule(ts, options);
  return module >= ts.ModuleKind.ES2015 && module < ts.ModuleKind.Node16;
}

/**
 * The module kind this compile emits: the stated `module`, else the compiler's
 * own default for the target (`commonjs` below ES2015, `es2015` from it). Every
 * reader that decides by module kind asks here, so an unstated `module` means
 * one thing throughout.
 */
function effectiveModule(ts: ITypeScript, options: CompilerOptions): number {
  if (ts.getEmitModuleKind !== undefined) {
    return ts.getEmitModuleKind(options);
  }
  if (typeof options.module === "number") {
    return options.module;
  }
  const target = typeof options.target === "number" ? options.target : 0;
  return target >= ts.ScriptTarget.ES2015 ? ts.ModuleKind.ES2015 : ts.ModuleKind.CommonJS;
}

/** The first specifier in `text` that points inside the tree pool, if any. */
/**
 * Let the compiler reach packages through PnP virtual locations: every
 * filesystem question is asked of the physical path, while the names the
 * compiler holds — and `realpath`'s answers — stay virtual, since the virtual
 * path is what tells the resolver which row a file belongs to. Installed before
 * anything else wraps the host, so whatever records reads records the virtual
 * names.
 */
function readThroughVirtualPaths(host: ICompilerHost): void {
  const { readFile, fileExists, directoryExists, getDirectories, realpath } = host;
  if (readFile !== undefined) {
    host.readFile = (file, encoding) => readFile.call(host, resolveVirtual(file), encoding);
  }
  host.fileExists = file => fileExists.call(host, resolveVirtual(file));
  if (directoryExists !== undefined) {
    host.directoryExists = directory => directoryExists.call(host, resolveVirtual(directory));
  }
  if (getDirectories !== undefined) {
    host.getDirectories = directory => getDirectories.call(host, resolveVirtual(directory));
  }
  if (realpath !== undefined) {
    host.realpath = file => realpathKeepingVirtual(file, real => realpath.call(host, real));
  }
}

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
  /* Side-effect imports checked where this compiler can (TypeScript 5.6+):
   * `import "./typo.css"` resolving to nothing is a mistake, and unchecked it
   * is a silent one. Probed rather than version-tested, and left alone where
   * the project stated it — the opt-out flag is how a target says no. */
  if (parsed.options[CHECK_SIDE_EFFECT_IMPORTS] === undefined && supportsOption(ts, CHECK_SIDE_EFFECT_IMPORTS)) {
    parsed.options[CHECK_SIDE_EFFECT_IMPORTS] = true;
  }
  const host = ts.createCompilerHost(parsed.options, true);
  readThroughVirtualPaths(host);
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
  /* What the compiler probed and found ABSENT, from the one place every
   * existence check goes through. Resolution picks among a package's
   * published candidates by probing them, so a failed probe is a fact the
   * answer depends on: that file APPEARING moves the resolution, and only a
   * recorded row can move the key with it. Filtered to the package pool in
   * readSetOf like every other row — a miss in the sources or the tool's own
   * install stays the anchor's business. */
  const missed = new Set<string>();
  const fileExists = host.fileExists;
  if (reportPath !== undefined) {
    host.fileExists = (file: string): boolean => {
      const found = fileExists.call(host, file);
      if (!found) {
        missed.add(file);
      }
      return found;
    };
  }
  /* A dependency's invalid `exports` map is read as the compiler reads it: a
   * fault in that package, which its runtime reports and the compile has no
   * cause to (docs `reference/typescript.md`). */
  const resolver = PnpResolver.load(root, conditionsOf(ts, parsed.options), { validateExports: false });
  /* One table, read once: resolution must find the file the emit will name, so
   * the two consumers below cannot be given different answers. */
  const rewrites = importRewritesOf(argv, root);
  /* Resource resolution rides here rather than standing alone: it answers where
   * ordinary resolution found nothing, which needs this driver to BE the
   * resolver. A compile with no manifest leaves resolution to the compiler and
   * so has no resource fallback either — every compile fabr runs has one. */
  const installed = resolver
    ? installResolution(ts, host, parsed.options, resolver, root, rewrites, resourceNamesOf(argv, root))
    : undefined;
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
  const layout = emitLayoutOf(ts, parsed.options, root, jsExtension, rewrites, installed?.packageSpecifier, installed?.ownSpecifier);
  if (jsExtension !== undefined && layout?.rewriteExtensions !== true) {
    /* Renaming without rewriting is the exact failure `--emit-extension` refuses
     * `.cjs` for, and it is reachable the other way round too: only an ES-module
     * emit has its specifiers corrected ({@link emitLayoutOf}), so a CommonJS one
     * renamed to `.mjs` would ship CommonJS syntax under a name node reads as an
     * ES module, its extensionless `require`s naming files that are not there. */
    throw new Error(`tsc-driver: --emit-extension needs an ES-module emit; this project's 'module' produces CommonJS`);
  }
  const rewriter = layout && specifierRewriter(ts, resolve, layout);
  /* First among the before-transforms, so it visits the parse tree (its ambient
   * test asks the checker about original nodes); the specifier rewriter only
   * replaces specifier literals, which this never reads. */
  const crossFormat = crossFormatGlobals(ts, parsed.options, () => program);
  /* The declaration traversal doubles as the forwarding-edge recorder, and so
   * runs whether or not there is anything to rewrite: what a file republishes
   * through its own interface is a property of its declarations, not of the
   * module format they were emitted for. Under a CommonJS emit `layout` is
   * undefined and this transformer observes without changing a node. */
  const declarations =
    graph === undefined ? rewriter : specifierRewriter(ts, resolve, layout, (file, specifier) => graph.forwards(file, specifier));
  const before = [crossFormat?.transformer, rewriter].filter((entry): entry is TransformerFactory => entry !== undefined);
  const transformers =
    before.length === 0 && declarations === undefined
      ? undefined
      : { ...(before.length > 0 ? { before } : {}), ...(declarations ? { afterDeclarations: [declarations] } : {}) };
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
     * The rerun is FULL — rooted at everything, waving everything, over a
     * wiped emit tree (`run`'s `full`) — because the abandoned attempt may
     * have emitted drafts before the void was detected, and only a full
     * re-emit is guaranteed to cover every one of them. Rooting at everything
     * is also what makes it terminate: the guard asks what THIS program is
     * rooted at, so it cannot trip again.
     *
     * Do not pass `oldProgram`: TypeScript refuses structural reuse outright
     * when the root list differs, which is the whole of what this rebuild
     * does. */
    program = buildProgram(undefined);
    built = graph.run(program, transformers, writeEmitted, true);
    fellBack = true;
  }
  const emitted = built ?? program.emit(undefined, writeEmitted, undefined, false, transformers);
  /* After emit, so the declaration rewriter's own resolution work counts as the
   * reading it is. Both written whether or not the compilation succeeded — a
   * failed run is not cached, so neither is ever asked for. */
  if (reportPath !== undefined && resolver !== undefined) {
    fs.writeFileSync(
      path.resolve(root, reportPath),
      serializeRunReport(readSetOf(program, opened, missed, resolver), resolver.edges(), graph?.telemetry(fellBack))
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
   * the compilation's own — the options, and the globals — are still asked once.
   * Finished through the cross-format rewrite AFTER emit, which is when it has
   * seen every meta-property it disposed of (the emit above ran the transform). */
  const collected = [
    ...parsed.errors,
    ...(graph === undefined ? ts.getPreEmitDiagnostics(program) : graph.diagnostics(program)),
    ...emitted.diagnostics,
  ];
  const bridged = crossFormat === undefined ? collected : crossFormat.finishDiagnostics(collected);
  const diagnostics = ts.sortAndDeduplicateDiagnostics(installed === undefined ? bridged : installed.finishDiagnostics(bridged));
  if (diagnostics.length > 0) {
    /* Diagnostics go to stdout, as the CLI writes them. */
    process.stdout.write(renderDiagnostics(ts, diagnostics, host, parsed.options.pretty !== false));
  }
  if (diagnostics.length === 0) {
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
 * - The OTHER module system's condition, unless an import asks for it (its
 *   `resolution-mode`, passed as `mode`). A package publishing only `import`
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
function conditionsOf(ts: ITypeScript, options: CompilerOptions, mode?: number): string[] {
  const custom = Array.isArray(options.customConditions) ? (options.customConditions as string[]) : [];
  const commonjs = mode === undefined ? effectiveModule(ts, options) === ts.ModuleKind.CommonJS : mode === ts.ModuleKind.CommonJS;
  return ["types", commonjs ? "require" : "import", "module-sync", ...custom];
}

/** The option that makes an unresolvable side-effect import an error. Added in
 * TypeScript 5.6, so a compile may be driven by a compiler without it. */
export const CHECK_SIDE_EFFECT_IMPORTS = "noUncheckedSideEffectImports";

/** Whether this compiler knows an option, asked of the compiler rather than of
 * its version. A compiler predating {@link ITypeScript.optionDeclarations}
 * knows nothing this is used for. */
export function supportsOption(ts: ITypeScript, name: string): boolean {
  return ts.optionDeclarations?.some(option => option.name === name) === true;
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
  const module = effectiveModule(ts, options);
  const node10 = kinds.Node10 ?? kinds.NodeJs!;
  /* The node* family resolves its own way or not at all (TS5109/TS5110).
   * `nodenext` tracks node; every other member of the family — `node16`,
   * `node18`, whatever is added next — pairs with Node16. */
  if (module === ts.ModuleKind.NodeNext) {
    return kinds.NodeNext;
  }
  if (module >= ts.ModuleKind.Node16 && module < ts.ModuleKind.NodeNext) {
    return kinds.Node16;
  }
  /* `bundler` pairs only with an ES-module or `preserve` emit (TS5095) — plus a
   * CommonJS one from TypeScript 6, which is the whole reason this function
   * exists. Anything else the ecosystem still emits (`amd`, `umd`, `system`,
   * `none`) takes `node10`, which every compiler accepts. */
  if (emitsEsModules(ts, options) || (ts.ModuleKind.Preserve !== undefined && module === ts.ModuleKind.Preserve)) {
    return kinds.Bundler;
  }
  const commonjs = module === ts.ModuleKind.CommonJS;
  const legacy = Number(ts.version.split(".")[0]) < 6;
  return commonjs && !legacy ? kinds.Bundler : node10;
}

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
  /** Run the wave, answering what a whole-program emit would have. `full`
   * discards the plan's bound and the emit tree and waves every project file
   * — the fallback rerun, whose abandoned first attempt left drafts in the
   * tree that only a full re-emit over a fresh one is guaranteed to cover. */
  run(program: IProgram, transformers: ICustomTransformers | undefined, write: WriteFile, full?: boolean): IEmitResult;
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
    run: (program, transformers, write, full = false) => {
      /* A rebuild re-runs this from scratch, so nothing of the abandoned
       * attempt may survive into the report. */
      byName.clear();
      emittedFiles.length = 0;
      outputs.clear();
      collected.length = 0;
      shapes.clear();
      baseShapes.clear();
      fallback = false;
      if (full) {
        /* The abandoned attempt emitted drafts from an incomplete program;
         * a rerun of the same wave would leave any it does not reach. Fresh
         * tree, every project file — full-compile parity by construction. */
        wipeEmitTree(root, emitDirectory);
      }
      const runPlan = full ? { ...plan, seeds: undefined } : plan;
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
      result = runWave(runPlan, {
        projectFiles: () => [...byName.keys()].filter(isProject),
        /* What THIS program is rooted at, which is the only form of the question
         * that survives the fallback: the caller re-runs with the same plan
         * against a program rooted at everything, and a guard reading the plan's
         * own bound would answer the same both times (see runWave). */
        isBoundRooted: () => isBoundRooted(),
        voided: () => fallback,
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
            return runPlan.seeds?.has(name) ?? true;
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
function readSetOf(program: IProgram, opened: string[], missed: ReadonlySet<string>, resolver: PnpResolver): string[] {
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
  /* Probed-and-absent files, recorded as the absences they were: replay
   * resolves each row against the delivery at hand, so a row that was absent
   * and now names a file moves the key. A row is a path either way — present
   * and absent spell identically. */
  for (const file of missed) {
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
    /* A lookup the requirer's own edges did not answer — through the fallback
     * pool, or not at all — is decided by the top level's table, which IS the
     * pool (and the surface a barred package's row carries): the direct member
     * of that name, or none. So it is a second row, `<name> package.json`, a
     * plain index of the direct members, and it moves when that member is
     * edited, replaced, removed, or appears where nothing answered before. */
    if (edge.via !== "own") {
      names.add(joinDepsPath([edge.name, "package.json"]));
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
    throw new Error(`tsc-driver: ${flag} needs a value`);
  }
  return value;
}

/** The project to compile: `--project <path>`/`-p <path>` as the CLI spells it,
 * else `tsconfig.json` in the working directory. */
function projectOf(argv: string[]): string {
  const flag = argv.findIndex(arg => arg === "--project" || arg === "-p");
  return flag >= 0 && argv[flag + 1] !== undefined ? argv[flag + 1] : "tsconfig.json";
}

/** Where the caller states which file a specifier really names — a JSON array
 * of compiled rename rules, applied BOTH before resolution (what the lookup
 * must find) and at emit (what the emitted code must say). One document because
 * it answers one question: which module the specifier means. See
 * {@link IEmitLayout.rewrites}. */
const REWRITES_FLAG = "--rewrite-imports";

/** Where the caller names the target's own RESOURCES — the delivered files no step
 * compiles, which the compiler is not given the bytes of. A JSON array of
 * rootDir-relative names. See {@link installResolution}. */
const RESOURCES_FLAG = "--resources";

/**
 * The resource names this compile was handed, or none where it was handed no
 * document. Names rather than files: the compiler never reads a resource (only
 * asks whether it is there), so staging the bytes would put every stylesheet's
 * CONTENT into the action key and rebuild the compile for a colour change.
 */
function resourceNamesOf(argv: string[], root: string): string[] | undefined {
  const named = argOf(argv, RESOURCES_FLAG);
  if (named === undefined) {
    return undefined;
  }
  const file = path.resolve(root, named);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`tsc-driver: cannot read the ${RESOURCES_FLAG} names at '${named}': ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.some(name => typeof name !== "string")) {
    throw new Error(`tsc-driver: the ${RESOURCES_FLAG} names at '${named}' are not a list of strings`);
  }
  return parsed as string[];
}

/**
 * A rename-rule document this compile was handed, or undefined if it was handed
 * none. `flag` names which — the two documents share a format and differ only in
 * when the rules apply.
 *
 * A file rather than an argument because it is data of no fixed size, and a
 * *separate* file rather than a tsconfig key because tsc owns that document — an
 * unknown member there is at best ignored and at worst a diagnostic. The caller
 * writes it only when there is something in it, so a compile declaring none
 * carries no trace of the mechanism.
 */
function importRewritesOf(argv: string[], root: string): IImportRewrite[] | undefined {
  const named = argOf(argv, REWRITES_FLAG);
  if (named === undefined) {
    return undefined;
  }
  const file = path.resolve(root, named);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`tsc-driver: cannot read the ${REWRITES_FLAG} rules at '${named}': ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`tsc-driver: the ${REWRITES_FLAG} rules at '${named}' are not a list`);
  }
  return parsed.map((entry, index) => {
    const rule = entry as { pattern?: unknown; replacement?: unknown };
    if (typeof rule?.pattern !== "string" || typeof rule?.replacement !== "string") {
      throw new Error(`tsc-driver: the ${REWRITES_FLAG} rule at index ${index} is not a pattern/replacement pair`);
    }
    /* Compiled here rather than at the point of use, so a malformed expression
     * is reported against the document that carried it. */
    try {
      new RegExp(rule.pattern);
    } catch (err) {
      throw new Error(`tsc-driver: the ${REWRITES_FLAG} rule at index ${index} is not a valid expression: ${String(err)}`);
    }
    return { pattern: rule.pattern, replacement: rule.replacement };
  });
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
