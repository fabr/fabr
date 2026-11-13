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
 * Fabr's TypeScript driver (`fabr-tsc`), run under node in a `js_compile`
 * build step. It compiles the staged `tsconfig.json` through the compiler API,
 * resolving modules through the step's PnP table, and applies the emit
 * corrections listed in the docs' `reference/js/typescript.md`. Otherwise it
 * behaves as `tsc` does: the same tsconfig, diagnostics and exit codes.
 *
 * Usage: `fabr-tsc [-p <tsconfig>] [driver flags]`, run in the staged
 * workspace as `tsc` would be (see {@link main}). With no `.pnp.data.json`
 * beside the tsconfig it resolves through the filesystem, as `tsc` does.
 *
 * It runs in the build step's process, not in fabr: it `require`s typescript
 * from its own staged install and must not depend on @fabr-build/core at
 * runtime. TypeScript's types are not available to compile against, so the
 * parts of the API used are typed structurally below.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { IConditionSet } from "../pnp/PackageExports";
import { PnpResolver, splitSpecifier, typesPackageName } from "../pnp/PnPResolver";
import { isVirtual, realpathKeepingVirtual, resolveVirtual } from "../pnp/VirtualPath";
import {
  CHANGES_FLAG,
  DEPS_REPORT_FLAG,
  IChangeLists,
  parseChangesDocument,
  serializeRunReport,
  STATE_DIR_FLAG,
} from "../pnp/ReadSet";
import { isJsonObject } from "../support/Json";
import { stagedReferences, withReferencedSources } from "../support/SourceMap";
import {
  DECLARATION_EXTENSION,
  DriverMemo,
  ICompilePlan,
  ICompileTelemetry,
  IDriverDiagnostic,
  IMemoEdge,
  membershipTarget,
  mergeMemo,
  normalizeName,
  parseDriverMemo,
  planCompile,
  serializeDriverMemo,
  SOURCE_DECLARATIONS_FLAG,
  sourceStem,
} from "./Planning";
import { IWaveResult, runWave } from "./Wave";
import { posixRelative, toPosix } from "../support/Paths";

/* The compiler API's types, as this driver uses them: opaque where it only
 * passes a value along (diagnostics, source files), spelled out where it reads
 * or builds one. */
type Diagnostic = unknown;
type SourceFile = unknown;
export type CompilerOptions = Record<string, unknown>;

interface IResolvedModule {
  resolvedFileName: string;
  /** The path the module was reached by, where that is not its file's own (a
   * link). */
  originalPath?: string;
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
/** A node parsed from emitted text, with real positions (a node the
 * declaration emitter synthesizes has none). */
interface ISyntaxNode extends INode {
  /** The offset the node's text begins at, including its leading trivia: a type
   * literal's members cover contiguous spans, so moving one moves its doc
   * comment and indentation with it. */
  pos: number;
  end: number;
  /** The offset the node's own text starts at, leading trivia skipped. */
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
/** A symbol, as far as the ambient-reference test reads it: the files its
 * declarations are in. */
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
/** The properties of a source file this driver reads: its name, whether it is
 * a module, and the module augmentations it declares. */
interface ISourceFileInfo {
  fileName: string;
  /** Present on a file that is an external module (it imports or exports
   * something); absent on a script, whose declarations are global. */
  externalModuleIndicator?: unknown;
  /** `declare module "x"` blocks, `declare global` included (see
   * {@link affectsGlobalScope}). */
  moduleAugmentations?: ReadonlyArray<unknown>;
}

/** The parts of a diagnostic this driver reads, to report it as data or to
 * filter it. */
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
  /** Get every file the program holds: the sources, and every declaration file
   * reached from them (what `--listFiles` lists). */
  getSourceFiles(): ReadonlyArray<ISourceFileInfo>;
  /** @return true if `file` is one of the compiler's default libraries (a
   * bundled or overridden `lib.*.d.ts`), otherwise false. */
  isSourceFileDefaultLibrary(file: SourceFile): boolean;
  /** Get one file's diagnostics, or every file's where none is given. */
  getSyntacticDiagnostics(file?: SourceFile): readonly Diagnostic[];
  getSemanticDiagnostics(file?: SourceFile): readonly Diagnostic[];
  /** Get the compilation's own diagnostics, which belong to no file. */
  getOptionsDiagnostics(): readonly Diagnostic[];
  getGlobalDiagnostics(): readonly Diagnostic[];
  getTypeChecker(): ITypeChecker;
  getSourceFile(fileName: string): SourceFile | undefined;
}
type WriteFile = (fileName: string, text: string, writeByteOrderMark: boolean) => void;

interface ICompilerHost {
  getCurrentDirectory(): string;
  writeFile: WriteFile;
  /** Read a file. Every file the compiler opens is read here: sources,
   * declaration files, and the `package.json`s its resolution reads. */
  readFile?: (fileName: string, encoding?: string) => string | undefined;
  /** Get a source file, which a host may answer for a name that is on no
   * disk. */
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
export interface ITypeScript {
  version: string;
  /** Read the module specifiers a file's text names, without a program. */
  preProcessFile(
    text: string,
    readImportFiles?: boolean,
    detectJavaScriptImports?: boolean
  ): { importedFiles: ReadonlyArray<{ fileName: string }> };
  /** Every compiler option this release knows. Optional: without it, every
   * option reads as unknown ({@link supportsOption}). */
  optionDeclarations?: ReadonlyArray<{ name: string }>;
  /** The module kind a compile actually emits, its unstated default applied.
   * Optional: {@link effectiveModule} falls back to the documented default. */
  getEmitModuleKind?: (options: CompilerOptions) => number;
  ModuleKind: { CommonJS: number; ES2015: number; ESNext: number; Node16: number; NodeNext: number; Preserve?: number };
  /** The resolution mode an import is written for (its `resolution-mode`
   * attribute, or what its syntax implies where that decides); the
   * compiler-options parameter arrived in TypeScript 5.3. */
  getModeForUsageLocation?(file: unknown, usage: unknown, options?: CompilerOptions): number | undefined;
  /** The compiler's own version-range matcher. Not in its declared API, so
   * optional: without it only the `*` range is known to apply. */
  VersionRange?: { tryParse(text: string): { test(version: string): boolean } | undefined };
  ModuleResolutionKind: { Node10?: number; NodeJs?: number; Node16: number; NodeNext: number; Bundler: number };
  JsxEmit: { Preserve: number };
  SyntaxKind: { ImportKeyword: number };
  /* Node construction and traversal, for the rewrites. The `update` forms take
   * every member of the node, so a caller passes back each one it is not
   * changing. */
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
    /** The third parameter is `assertions` before TypeScript 5.3 and
     * `attributes` from it, in the same position. */
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
  /** Visit the AST children of a node, punctuation excluded. */
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
  /** @return true if a file is a module rather than a script, as the compiler
   * judges it (a bare `export {}`, `import.meta` and a `.mts` extension all
   * count), otherwise false. */
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

/** The compiler major versions this driver can drive. 5.0 added the
 * resolution hook it installs (`resolveModuleNameLiterals`): an older compiler
 * would resolve through the filesystem and find no dependency. TypeScript 7
 * (the Go port) exports only `version` and `versionMajorMinor` from its
 * `typescript` entry point, and none of the API used here (`createProgram`, the
 * CompilerHost, the resolution hooks). */
const MINIMUM_TYPESCRIPT = 5;
const MAXIMUM_TYPESCRIPT = 6;

/** Throw where this driver cannot drive the compiler `version`, saying whether
 * it is too old or too new. */
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
 * A declaration file's name, in each of TypeScript's spellings: `x.d.ts`,
 * `x.d.mts`, `x.d.cts`, and the arbitrary-extension form `x.d.<ext>.ts` (5.0),
 * as `logo.d.svg.ts` declares what importing `logo.svg` yields.
 *
 * @fabr-build/js's JSPackage.ts holds the same pattern: keep the two in step
 * (this driver must not import fabr's modules at runtime).
 */
export const DECLARATION_FILE = /\.d\.(?:[cm]?ts|[^./]+\.ts)$/;

/** The digest a declaration's shape (the hash of its emitted text) is taken
 * with. Both the staged base output and this run's emit are hashed here. */
const SHAPE_DIGEST = "sha256";

/** File extensions that carry no types. A package specifier resolving to one
 * has no typings of its own, and the lookup goes on to the typings recoveries
 * and `@types` ({@link installResolution}). */
const UNTYPED = /\.[cm]?jsx?$/;

/** A format-tagged JavaScript extension, whose declarations the compiler will
 * only look for under the matching tag (`.d.cts` for `.cjs`). */
const FORMAT_TAGGED = /\.[cm]js$/;

/** tsc's own exit codes, which fabr's step reports as the tool's outcome. */
const EXIT_OK = 0;
const EXIT_ERRORS_NO_OUTPUT = 1;
export const EXIT_ERRORS = 2;

/** The members of a host that {@link installResolution} reads, and the hooks it
 * installs on it. */
export type IResolutionHost = Pick<
  ICompilerHost,
  | "fileExists"
  | "readFile"
  | "getCanonicalFileName"
  | "resolveModuleNameLiterals"
  | "resolveLibrary"
  | "resolveTypeReferenceDirectiveReferences"
>;

/**
 * Install module, library and type-reference resolution on a compiler host,
 * answering package names from the PnP table `resolver` holds, and return what
 * the rest of the compile needs from the same resolution.
 *
 * A module specifier is resolved by its kind:
 * - A relative or rooted path is the compiler's to resolve, after the first
 *   matching rule of `rewrites` renames it (only a path inside `rootDir` is
 *   renamed).
 * - An import of the compile's own package by name (`mylib/a/x`) is resolved
 *   as the relative path to the same file.
 * - A bare package name or a `#` import is answered by the resolver: the
 *   package the table binds the name to for the importing package (where it
 *   binds none, the one the compilation depends on directly), then the file
 *   that package's `exports` (or `imports`) map publishes for it under the
 *   import's conditions ({@link conditionsOf}, plus each `types@<range>` key
 *   the running compiler satisfies). The compiler then finds the file as a
 *   path: extension probing, and `types`/`main` for a package with no
 *   `exports`. For a package with no `exports` map, its `typesVersions` mapping
 *   of a subpath is tried first. An `exports` target written without an
 *   extension is completed to the runtime file beside it, or to the `index` of
 *   the directory it names, where the specifier spelled that way resolves
 *   through the map to the same file; the emit writes that spelling.
 *
 * Of the files a package publishes for a specifier, an import that loads at
 * runtime takes the first (the one node loads), unless it has no typings and a
 * later one has; an import that loads nothing (`import type`, any import in a
 * declaration file) takes the first that has typings. A specifier still without
 * typings then tries, in order: the declaration under the plain name beside a
 * `.cjs`/`.mjs` file (`index.d.ts` beside `index.cjs`), the package's own
 * `types`/`main` (for the bare package name only), and the `@types` package for
 * the name. None of them answers for a subpath the package does not publish,
 * and `@types` is not tried where the package is in the compile, publishes
 * nothing for the specifier, and the import loads at runtime. Where nothing has
 * typings the untyped file stands, and the compiler reports the missing
 * declarations as usual. Answers are cached per importing package, specifier,
 * resolution mode, and whether the import loads.
 *
 * A type reference (`types` in the tsconfig, `/// <reference types>`) looks up
 * `@types/<name>`, then `<name>`, as a dependency of the compilation, and only
 * where the compilation has neither, as one of the referencing package. A
 * library a project replaces with `@typescript/lib-<name>` is looked up as a
 * dependency of the compilation.
 *
 * `resourceNames` are the target's own resources (stylesheets, images), named
 * relative to `rootDir`. They are not staged for the compile, so they count as
 * present by name.
 *
 * The result's `finishDiagnostics` adjusts the program's diagnostics:
 * - It drops "cannot find module" at a side-effect import of a file that is
 *   present (`import "./theme.css"`), which the compiler reports under
 *   `noUncheckedSideEffectImports` for every resource.
 * - It adds "Cannot find file" (code 79001) at an import that loads at runtime
 *   and certainly names no file, where the compiler reported nothing at the
 *   same position: a relative path with an extension whose file is absent, or
 *   a subpath of an installed package that the package does not publish or
 *   whose published file is absent. A bare package name is never judged, nor is
 *   a side-effect import where the project sets `noUncheckedSideEffectImports`
 *   to false.
 */
export function installResolution(
  ts: ITypeScript,
  host: IResolutionHost,
  options: CompilerOptions,
  resolver: PnpResolver,
  root: string,
  rewrites?: IImportRewrite[],
  resourceNames?: string[]
): IInstalledResolution {
  let cache = ts.createModuleResolutionCache(root, name => host.getCanonicalFileName(name), options);
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
  /* The completed spelling of each package specifier whose `exports` target
   * was written without an extension, by importing package and specifier. */
  const completedSpecifiers = new Map<string, string>();
  /**
   * @return the files the package publishes for a specifier: the resolver's
   * candidates, in the package's own order.
   *
   * An `exports` target names a file exactly (node, bundlers and the compiler
   * add no extension to one), so a target with no extension that names no file
   * (`"./src/*": "./src/*"` asked for `pkg/src/utils`) is completed to the file
   * beside it with a runtime extension, or the `index` of the directory it
   * names, where the specifier spelled that way resolves through the same map
   * to that file. The spelling is recorded for the emit
   * ({@link IEmitLayout.packageSpecifier}); a target no spelling reaches is
   * dropped.
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
  /** @return the first file the package publishes for a specifier: the one
   * node loads. */
  const publishedPath = (specifier: string, issuer: string): string | undefined => published(specifier, issuer)[0];
  /** @return the compiler's resolution of a path the resolver produced, marked
   * an external library import, or undefined where it finds no file. The
   * compiler resolves a rooted specifier as a path, not a package name. */
  const asModule = (target: string, issuer: string): IResolvedModuleWithFailedLookupLocations | undefined => {
    const resolved = ts.resolveModuleName(target, issuer, options, host, cache);
    if (!resolved.resolvedModule) {
      return undefined;
    }
    /* Clear `resolvedUsingTsExtension`: it describes the path handed to the
     * compiler, not the specifier written, and where an `exports` map names a
     * `.d.ts` the checker would report the importing code for importing a
     * `.ts` extension.
     *
     * Drop `packageId` at a virtual location: the compiler redirects every file
     * of a `name@version` it has loaded to the first copy, and the package's
     * other virtual locations (the same package with its dependencies bound
     * differently) share its name and version. */
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
  /** @return the compiler's resolution of the first of `targets` that carries
   * declarations, in order, or undefined where none does. For a lookup that
   * loads nothing (a type reference, a library). */
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
  /** @return true if a resolution is missing or carries no typings, otherwise
   * false. */
  const untyped = (found: IResolvedModuleWithFailedLookupLocations | undefined): boolean =>
    found === undefined || UNTYPED.test(found.resolvedModule!.resolvedFileName);
  /**
   * Resolve a package specifier to one of the files the package publishes for
   * it, in the package's own order, preferring one that carries declarations
   * (as the compiler does for a map listing `types` after `import`/`require`).
   *
   * Where the import loads at runtime (`loads`), the first file decides: where
   * it is absent the specifier is unresolved, and where it has no typings a
   * later file with typings answers, else the first stands. Where the import
   * loads nothing, the first file with typings answers, else the first that
   * resolves.
   */
  const through = (
    specifier: string,
    issuer: string,
    conditions: IConditionSet,
    loads: boolean
  ): IResolvedModuleWithFailedLookupLocations | undefined => {
    const candidates = published(specifier, issuer, conditions);
    if (!loads) {
      /* Nothing loads: the first candidate that carries declarations, else the
       * first that resolves at all. */
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
    /* The first candidate is the file node loads: where it is absent the
     * import does not load, and no later candidate may answer. */
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
   * Look up typings for a specifier whose resolution (`published`) has none,
   * trying in turn: the declaration under the plain name beside a `.cjs`/`.mjs`
   * file ({@link siblingTypings}), the package's own `types`/`main` for the
   * bare package name ({@link legacyTypings}), and the `@types` package.
   * Example: a package publishing `./dist/index.cjs` for `require` with only
   * `dist/index.d.ts` beside it, where the compiler looks for
   * `dist/index.d.cts`.
   *
   * The first two are tried only where the package published a file, so a
   * subpath it does not publish stays unresolved. Returns undefined where none
   * has typings.
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
      /* `types`/`main` describe the package's main entry only, so they answer
       * for the bare package name alone. */
      if (split?.subpath === "") {
        probes.push(() => legacyTypings(split.name, issuer));
      }
    }
    /* The `@types` package, except where the package is in this compile and
     * published nothing for the specifier, and the import loads at runtime
     * (node would refuse it with ERR_PACKAGE_PATH_NOT_EXPORTED). For a package
     * not in the compile, the `@types` package stands in for it
     * (`@types/aws-lambda`). */
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
  /** @return the declaration file under the plain name beside the `.cjs`/`.mjs`
   * file a package publishes (`index.d.ts` beside `index.cjs`, where the
   * compiler looks only for `index.d.cts`), found by asking the compiler for
   * the `.js` spelling. */
  const siblingTypings = (
    specifier: string,
    issuer: string,
    conditions: IConditionSet
  ): IResolvedModuleWithFailedLookupLocations | undefined => {
    const target = published(specifier, issuer, conditions)[0];
    return target === undefined || !FORMAT_TAGGED.test(target) ? undefined : asModule(target.replace(FORMAT_TAGGED, ".js"), issuer);
  };
  /** @return the package's own `types`/`main`, found by handing the compiler
   * the package's directory. */
  const legacyTypings = (name: string, issuer: string): IResolvedModuleWithFailedLookupLocations | undefined => {
    const location = resolver.locationOf(name, issuer);
    return location === undefined ? undefined : asModule(location, issuer);
  };
  /**
   * @return where a package's `typesVersions` maps a subpath import, for a
   * package with no `exports` map. The compiler applies `typesVersions` to a
   * package it finds in `node_modules`, never to a path it is handed, which is
   * how a subpath reaches it here.
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
    if (!isJsonObject(manifest) || (manifest.exports !== undefined && manifest.exports !== null)) {
      return [];
    }
    const paths = selectedTypesVersion(ts, manifest.typesVersions);
    return paths === undefined ? [] : typesVersionsSubstitutions(paths, split.subpath).map(target => path.join(location, target));
  };
  /**
   * @return an import of this compile's own package by name, as the relative
   * specifier naming the same path from `issuer` — `mylib/a/x.module.scss` from
   * `b/c.ts` is `../a/x.module.scss` — or undefined for any other specifier.
   *
   * A bare own name names the source directory itself. Mapped from the name, not
   * resolved: a stylesheet is not staged for the compile, so its import
   * resolves only once a rewrite rule renames the relative form.
   */
  const ownRelative = (specifier: string, issuer: string): string | undefined => {
    const split = splitSpecifier(specifier);
    const location = split === undefined ? undefined : resolver.sourceLocationOf(split.name, issuer);
    if (split === undefined || location === undefined) {
      return undefined;
    }
    const relative = toPosix(path.relative(path.dirname(issuer), path.join(location, split.subpath)));
    const spelled = relative === "" ? "." : relative.startsWith("../") || relative === ".." ? relative : `./${relative}`;
    return split.subpath === "" || split.subpath.endsWith("/") ? `${spelled}/` : spelled;
  };
  /** @return a relative specifier as resolution must look for it: renamed by
   * the first matching rewrite rule (the file was renamed by an earlier step),
   * else as written. Rules select on root-relative names, so the climb prefix
   * is split off first; a specifier leaving the source root takes no rule. */
  const rewritten = (specifier: string, issuer: string): string => {
    const [prefix, selected] = splitRelativePrefix(specifier);
    const renamed =
      rewrites === undefined || !withinSourceRoot(specifier, issuer, sourceRoot) ? undefined : applyImportRewrites(selected, rewrites);
    return renamed === undefined ? specifier : prefix + renamed;
  };
  /**
   * @return the file an import names, where it is present, else undefined: for
   * a relative import, the file beside the importer (after the rewrite rules);
   * for a package specifier, the first file the package publishes for it. Asked
   * of an import the compiler could not resolve, so of a resource it cannot
   * read as a module (a stylesheet, an image, a `.wasm`). The target's own
   * resources count as present by name (`declared`); any other file must be on
   * disk.
   */
  const resourceFile = (written: string, issuer: string): string | undefined => {
    const specifier = ownRelative(written, issuer) ?? written;
    const name = splitSpecifier(specifier) !== undefined || specifier.startsWith("#");
    const file = name ? publishedPath(specifier, issuer) : path.resolve(path.dirname(issuer), rewritten(specifier, issuer));
    return file !== undefined && (declared.has(file) || host.fileExists(file)) ? file : undefined;
  };
  /* Side-effect imports of present resources, their specifiers by importing
   * file: the imports whose "cannot find module" finishDiagnostics drops. */
  const presentResources = new Map<string, Set<string>>();
  /**
   * @return true if an unresolved import certainly names no file, otherwise
   * false: a relative path with an extension whose file is absent, or a subpath
   * of an installed package that the package publishes nothing for or whose
   * published file is absent. A relative path without an extension (a bundler
   * may complete it), a `#` import and a bare package name are never judged
   * (`declare module "virtual:*"` types a bundler's virtual modules). An import
   * of the compile's own package by name is judged as the relative path it
   * names.
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
  /* Imports that load at runtime and certainly name no file, by importing file
   * then specifier, with the specifier's position: reported by
   * finishDiagnostics where the compiler reported nothing (a `declare module`
   * pattern typed the import, or, before TypeScript 5.6, side-effect imports go
   * unchecked). */
  const missingFiles = new Map<string, Map<string, { file: SourceFile; start: number; length: number; specifier: string }>>();
  /* Answers to bare-name lookups, by importing package, specifier, resolution
   * mode and whether the import loads: a name means the same to every file of
   * one package. */
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
      /* A relative or rooted path: the compiler's to resolve, after any
       * rewrite rule. */
      return ts.resolveModuleName(rewritten(specifier, issuer), issuer, options, host, cache);
    }
    const key = `${resolver.locatorOf(issuer)}\0${specifier}\0${mode}\0${String(loads)}`;
    const held = answers.get(key);
    if (held !== undefined) {
      return held;
    }
    /* A bare name, or a `#` import (from the importing package's `imports`
     * map), is the resolver's to answer: the compiler never searches
     * `node_modules`. The published file answers where it has typings;
     * otherwise the typings recoveries are tried, and the untyped file stands
     * where none answers. */
    const conditions = conditionsFor(mode);
    const versioned = split === undefined ? undefined : typedAmong(typesVersionsTargets(split, issuer), issuer, options);
    const published = versioned ?? through(specifier, issuer, conditions, loads);
    const answer =
      (untyped(published) ? recoverTypings(specifier, split, published, issuer, conditions, loads) : undefined) ?? published ?? {};
    answers.set(key, answer);
    return answer;
  };
  host.resolveModuleNameLiterals = (literals, containingFile, _redirected, _options, containingSourceFile) => {
    /* A file's unresolved imports are passed again whenever it is resolved, so
     * what was recorded of them is recorded afresh. */
    presentResources.delete(containingFile);
    missingFiles.delete(containingFile);
    return literals.map(literal => {
      const answer = resolveModule(
        literal.text,
        containingFile,
        ts.getModeForUsageLocation?.(containingSourceFile, literal, options) ?? defaultMode,
        loadsAtRuntime(ts, literal, containingSourceFile)
      );
      if (
        answer.resolvedModule === undefined &&
        isSideEffectImport(ts, literal) &&
        resourceFile(literal.text, containingFile) !== undefined
      ) {
        presentResources.set(containingFile, (presentResources.get(containingFile) ?? new Set()).add(literal.text));
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
        const missing = missingFiles.get(containingFile) ?? new Map();
        missingFiles.set(
          containingFile,
          missing.set(literal.text, { file: containingSourceFile, start, length: node.end - start, specifier: literal.text })
        );
      }
      return answer;
    });
  };
  /* A project replaces one of the compiler's built-in libraries by depending on
   * `@typescript/lib-<name>`, which the compiler looks for in `node_modules`:
   * look it up in the table instead, as a dependency of the compilation. */
  host.resolveLibrary = (libraryName, resolveFrom, libraryOptions) =>
    typedAmong(published(libraryName, path.join(root, "tsconfig.json")), resolveFrom, libraryOptions) ?? { resolvedModule: undefined };
  host.resolveTypeReferenceDirectiveReferences = (directives, containingFile) =>
    directives.map(directive => {
      const name = typeof directive === "string" ? directive : directive.fileName;
      /* A type reference names a types package first (`node` is `@types/node`),
       * and only then a package of that name shipping its own — the order tsc
       * uses when it walks `node_modules/@types`. */
      for (const candidate of [typesPackageName(name), name]) {
        /* Look up from the compile root first, and from the referencing file's
         * package only where the root binds nothing: a types package declares
         * globals for the whole program, and two versions of one duplicate them
         * (two `@types/node` make every DOM `addEventListener` ambiguous). */
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
  /* Drop the compiler's "cannot find module" at a side-effect import of a
   * resource that is present. Under `noUncheckedSideEffectImports` the
   * compiler reports one at every resource, reading none as a module; a
   * missing resource is still reported, and a `declare module` pattern still
   * applies. */
  const withoutPresentResources = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] =>
    diagnostics.filter(diagnostic => {
      const info = diagnostic as IDiagnosticInfo & { length?: number };
      const text = (info.file as { text?: string } | undefined)?.text;
      if (!MODULE_NOT_FOUND.has(info.code) || text === undefined || info.start === undefined || info.length === undefined) {
        return true;
      }
      const specifier = text.slice(info.start + 1, info.start + info.length - 1);
      return presentResources.get((info.file as ISourceFileInfo).fileName)?.has(specifier) !== true;
    });
  /* Finish a run's diagnostics: drop the reports at present resources, and add
   * "Cannot find file" at each import that certainly names no file where the
   * compiler reported nothing at the same position. Given `file`, add only that
   * file's, and only for that version of it (a language service asks one file
   * at a time). */
  const finishDiagnostics = (diagnostics: readonly Diagnostic[], file?: SourceFile): readonly Diagnostic[] => {
    const kept = withoutPresentResources(diagnostics);
    const reportedAt = new Set(
      kept.map(diagnostic => {
        const info = diagnostic as IDiagnosticInfo;
        return `${(info.file as ISourceFileInfo | undefined)?.fileName ?? ""}\0${String(info.start)}`;
      })
    );
    const candidates =
      file === undefined
        ? [...missingFiles.values()].flatMap(missing => [...missing.values()])
        : [...(missingFiles.get((file as ISourceFileInfo).fileName)?.values() ?? [])].filter(missing => missing.file === file);
    const added = candidates
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
    invalidate: () => {
      cache = ts.createModuleResolutionCache(root, name => host.getCanonicalFileName(name), options);
      answers.clear();
    },
    packageSpecifier: (specifier, containingFile) => completedSpecifiers.get(`${resolver.locatorOf(containingFile)}\0${specifier}`),
    ownSpecifier: ownRelative,
    exists: file => declared.has(file) || host.fileExists(file),
  };
}

/** What {@link installResolution} returns, for the rest of the compile. */
export interface IInstalledResolution {
  /** Finish the program's diagnostics (see {@link installResolution}); given
   * `file`, only those of that file. */
  finishDiagnostics(diagnostics: readonly Diagnostic[], file?: SourceFile): readonly Diagnostic[];
  /** Forget every lookup's answer, so the next asks the files again; a language
   * service calls it when its files may have changed. */
  invalidate(): void;
  /** @return the completed spelling of a package specifier whose `exports`
   * target was written without an extension, or undefined. */
  packageSpecifier(specifier: string, containingFile: string): string | undefined;
  /** @return the relative specifier for an import of the compile's own package
   * by name, or undefined for any other specifier. */
  ownSpecifier(specifier: string, containingFile: string): string | undefined;
  /** @return true if a file is on disk or is one of the target's own
   * resources, otherwise false. */
  exists(file: string): boolean;
}

/** What an extensionless `exports` target is completed with, in order: a
 * runtime file beside it, else the `index` of the directory it names. */
const RUNTIME_SUFFIXES = [".js", ".mjs", ".cjs", "/index.js", "/index.mjs", "/index.cjs"];

/** The code of the driver's own report of an import of a missing file — outside
 * every range the compiler assigns. */
const MISSING_FILE_ERROR = 79001;

/** The compiler's "cannot find module" reports, as its lookup of a module
 * specifier makes them (2882 a side-effect import's). */
const MODULE_NOT_FOUND = new Set([2307, 2792, 2882]);

/** @return true if `literal` is the specifier of an import that binds nothing
 * (`import "./theme.css"`), otherwise false. */
function isSideEffectImport(ts: ITypeScript, literal: IStringLiteralLike): boolean {
  const parent = (literal as { parent?: INode }).parent;
  return parent !== undefined && ts.isImportDeclaration(parent) && (parent as IImportDeclarationNode).importClause === undefined;
}

/** @return true if the import whose specifier is `literal` loads anything at
 * runtime, otherwise false: an import in a declaration file, an `import type`
 * or `export type`, and an `import("…")` type load nothing. */
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

/** @return true if the running compiler satisfies a version range, as it
 * judges `typesVersions` keys, otherwise false; without its matcher, only `*`
 * is known to. */
function compilerSatisfies(ts: ITypeScript, range: string): boolean {
  const parsed = ts.VersionRange?.tryParse(range);
  return parsed === undefined ? range.trim() === "*" : parsed.test(ts.version);
}

/** @return true if an `exports` condition key is a versioned `types@<range>`
 * key the running compiler satisfies — the compiler's own rule for such keys —
 * otherwise false. */
function versionedTypesKeyApplies(ts: ITypeScript, condition: string): boolean {
  return condition.startsWith("types@") && compilerSatisfies(ts, condition.slice("types@".length));
}

/** @return the `typesVersions` path map the running compiler selects — the
 * first entry whose version range it satisfies — or undefined when none applies
 * or the field is not a map. */
function selectedTypesVersion(ts: ITypeScript, typesVersions: unknown): Map<string, string[]> | undefined {
  if (!isJsonObject(typesVersions)) {
    return undefined;
  }
  for (const [range, paths] of Object.entries(typesVersions)) {
    if (compilerSatisfies(ts, range)) {
      return isJsonObject(paths)
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

/** @return the substitutions a `typesVersions` path map gives `subpath`,
 * matched as the compiler matches `paths`: an exact key, else the single-`*`
 * pattern with the longest prefix, its capture filling each substitution's
 * `*`. */
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

/* Every quoted specifier a declaration file can carry a path in: the
 * `import("…")` type the declaration emitter synthesizes, and the written forms
 * (`from`, `require(`, `/// <reference path>`). */
const QUOTED_SPECIFIER = /(import\s*\(\s*|from\s*|require\s*\(\s*|<reference\s+path\s*=\s*)(["'])([^"']+)\2/g;

/** @return true if a specifier names a location rather than a package — the
 * only kind that can point into the tree pool — otherwise false. */
function isPathSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || path.isAbsolute(specifier);
}

/**
 * Rewrite each path specifier in an emitted declaration file that points into
 * an installed package to the package's name and subpath, and return the text.
 *
 * To name a type it cannot otherwise express (a type inferred from a
 * dependency), the declaration emitter writes an `import("…")` of the resolved
 * file. Under `node_modules` it derives the package name from the path; here it
 * writes the path into the tree pool, which resolves to nothing in any
 * consumer. A path inside a package's location is mapped to that package, the
 * rest of the path its subpath.
 *
 * Throws where a specifier still points into the tree pool (a package with no
 * entry in the PnP table): a fabr bug.
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
 * Remove the compile's own directory (`root/`) from emitted text, leaving
 * root-relative paths, as the source maps use, and return the text.
 *
 * The compiler names a source by the absolute path it was given, so any emit
 * carrying a source path (`_jsxFileName` under the automatic JSX runtime's dev
 * variant) would carry the staging directory, which differs on every build.
 * Applied to every emitted file.
 */
export function relativizeBuildRoot(text: string, root: string): string {
  /* TypeScript spells paths with forward slashes whatever the platform. */
  const prefix = `${root.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
  return text.includes(prefix) ? text.split(prefix).join("") : text;
}

/**
 * Sort every union's members by their text, and every type literal's named
 * members by name, in code-unit order, in an emitted declaration file, and
 * return the text. The compiler orders a union by type id, which depends on the
 * order types were created in the program, so a full compile and an incremental
 * one (a wave) would otherwise print the same type differently.
 *
 * `interface` and class bodies are left as written. Unnamed members (call,
 * construct and index signatures) keep their positions: overload resolution
 * reads them in order. The text is spliced, never reprinted, so separators,
 * indentation and each member's doc comment stay as the compiler wrote them;
 * nested types are sorted innermost first.
 */
export function canonicalizeUnions(ts: ITypeScript, fileName: string, text: string): string {
  /* A file with neither character holds no union or type literal: skip the
   * parse. */
  if (!text.includes("|") && !text.includes("{")) {
    return text;
  }
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  /** @return the text of a node's own name, or undefined for one with none. */
  const nameOf = (node: ISyntaxNode): string | undefined =>
    node.name === undefined ? undefined : text.slice(node.name.getStart(source), node.name.end);
  /** Sort `indices` by their `keys` in code-unit order (never a locale
   * comparison); ties keep their original order. */
  const byKey = (keys: ReadonlyArray<string>, indices: ReadonlyArray<number>): number[] =>
    [...indices].sort((a, b) => (keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : a - b));
  /** @return the canonical text of everything between `from` and `to`, with
   * each child replaced by its own canonical text and every gap between them —
   * punctuation, whitespace, comments — carried across untouched. */
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
  /** @return `node`'s text with its members' canonical texts placed in
   * `order`, each into a member's original span. */
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
      /* Named members move only into each other's slots; an unnamed one keeps
       * its index. */
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
  /** What `.js` output is renamed to (`--emit-extension`). Output of a source
   * that pinned its own format (`.mts`, `.cjs`) keeps its extension. See
   * {@link RENAMED_EXTENSION}. */
  jsExtension?: string;
  /**
   * The import rewrite rules ({@link REWRITES_FLAG}): the first rule matching a
   * relative specifier as written (not the file it resolves to) gives the
   * specifier the emit writes instead. A rule is matched against the specifier
   * without its climb prefix ({@link splitRelativePrefix}), and its replacement
   * then takes this compile's extension rule ({@link renamedIfEmitted}). Each
   * rule arrives compiled, as a regular expression and a `$n` replacement.
   * fabr writes them for stylesheets, where `import styles from
   * "./x.module.scss"` names a file no step produces.
   */
  rewrites?: IImportRewrite[];
  /**
   * Whether relative specifiers are also rewritten to name the file this
   * compile emits (`./bar` → `./bar.js`): set for an ES-module emit only.
   * Rewrite rules apply either way.
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
  /** Whether a file is there for the output to load — on disk, or one of the
   * target's own resources, which are not staged for the compile. */
  exists?: (file: string) => boolean;
}

/**
 * Split a relative specifier into its climb prefix (its leading `./` and `../`
 * segments) and the rest, which the rewrite rules select on: `../a/x.scss` →
 * `["../", "a/x.scss"]`. A rule's selector is over root-relative names, with no
 * `.`/`..` segments; the prefix is re-attached to what the rule produces.
 */
export function splitRelativePrefix(specifier: string): [string, string] {
  const climb = /^(?:\.\.?\/)+/.exec(specifier);
  const prefix = climb === null ? "" : climb[0];
  return [prefix, specifier.substring(prefix.length)];
}

/**
 * @return true if a relative specifier names a path strictly inside `rootDir`,
 * the condition for a rewrite rule applying to it, otherwise false (always
 * false with no `rootDir`). Lexical: it touches no filesystem, and a climb that
 * stays inside the root is accepted.
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
 * @return the name the first matching rule gives `relative`, or undefined where
 * none matches. Doubled slashes are collapsed and leading and trailing ones
 * removed, as the rules' producer does: an unmatched recursive group
 * substitutes as empty.
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
 * @return a rewrite rule's replacement with its extension mapped as this
 * compile emits it ({@link EMITTED_EXTENSION}, `--emit-extension` applied to
 * `.js`), or unchanged where this compile emits nothing for its extension. A
 * css-module's `.js` shim is a source of this compile and is renamed with its
 * output; a stylesheet is not, and is kept as written.
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
 * @return where this compile's output for `source` lands, or undefined where it
 * has none to name: a declaration, an extension this compiler emits nothing
 * for, a source outside `rootDir`, or an `outDir` with no stated `rootDir` (the
 * compiler infers that from the whole file list, which is not given here).
 * With no `outDir` the output sits beside its source.
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
  /* The rename applies to `.js` alone: `.mjs`/`.cjs` output is from a source
   * that pinned its own format. */
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

/** @return the specifier naming `target` from a file emitted into `from`:
 * relative, said explicitly (a bare `bar.js` would name a package), in forward
 * slashes. */
export function emittedSpecifier(from: string, target: string): string {
  const relative = posixRelative(from, target);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

/**
 * Make the transformer that rewrites module specifiers in four forms
 * (`import … from`, `export … from`, `import("…")` calls and `import("…").T`
 * types):
 * - An import of the compile's own package by name becomes the relative
 *   specifier for the same file (`layout.ownSpecifier`), then is rewritten as
 *   any relative specifier.
 * - A package specifier whose `exports` target the resolution completed is
 *   written completed (`layout.packageSpecifier`).
 * - A relative specifier inside `rootDir` that a rewrite rule matches takes the
 *   rule's replacement.
 * - Otherwise, where `layout.rewriteExtensions` is set, a relative specifier is
 *   rewritten to name the file this compile emits for what it resolves to
 *   (`./bar` → `./bar.js`, `./dir` → `./dir/index.js`), as node's ES-module
 *   loader requires and `tsc` does not write. One that resolves nowhere, or to
 *   a file this compile does not emit, or that names an existing file exactly
 *   other than the one it resolves to, is left as written.
 *
 * Resolve, never append an extension: only resolution tells a directory from a
 * file, and knows `./bar.js` already names `bar.ts`. Keep it a transform: a
 * scan of emitted text cannot tell an import from a string that holds one.
 *
 * With no `layout`, or for a file this compile emits nothing for, nothing is
 * rewritten and the traversal only calls `observe`.
 */
function specifierRewriter(
  ts: ITypeScript,
  resolve: (specifier: string, containingFile: string) => string | undefined,
  layout: IEmitLayout | undefined,
  /**
   * Called with each specifier the traversal passes, as authored (before any
   * rewrite), and the file it is in. On the declaration traversal this records
   * what each declaration imports, the `import("…")` types the emitter
   * synthesizes included.
   */
  observe?: (containingFile: string, specifier: string) => void
): TransformerFactory {
  return context => sourceFile => {
    /* With no layout, or no output for this file, nothing is rewritten; the
     * traversal still runs where there is an observer. */
    const emitted = layout && emittedPathOf(sourceFile.fileName, layout);
    if (emitted === undefined && observe === undefined) {
      return sourceFile;
    }
    const from = emitted === undefined ? undefined : path.dirname(emitted);
    /** @return the replacement for a specifier node, or undefined to leave it
     * be — which covers anything that is not a rewritable specifier, so a
     * caller may hand over whatever sits in the position. */
    const rewrite = (node: INode | undefined): INode | undefined => {
      if (node === undefined || !ts.isStringLiteral(node)) {
        return undefined;
      }
      const written = (node as IStringLiteralNode).text;
      /* Observe before the filters below: a declaration importing a bare name
       * passes that package's types on to its own importers. */
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
    /** @return what a relative specifier is written as in the output, or
     * undefined to keep it as it is. */
    const relativeSpecifier = (specifier: string): string | undefined => {
      /* Rewrite rules come before the extension rewrite, and apply whatever
       * the module system. */
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
      /* A specifier naming a file exactly loads that file at runtime, whatever
       * the compiler resolved it to: `./x.css` beside an `x.css.ts` names the
       * stylesheet, though the compiler, appending `.ts`, finds the module. */
      const named = path.resolve(path.dirname(sourceFile.fileName), specifier);
      if (resolved !== undefined && path.resolve(resolved) !== named && layout!.exists?.(named)) {
        return undefined;
      }
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
      /* `import("./x").T`, which the declaration emitter writes for a type it
       * cannot otherwise name. Extensionless, a node16/nodenext consumer reports
       * TS2834, or under skipLibCheck reads the type as `any`. */
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

/** The cross-format globals rewrite: its transformer and its diagnostics
 * finisher. */
interface ICrossFormatGlobals {
  transformer: TransformerFactory;
  /** The run's diagnostics, finished: the checker's TS1343s on meta-properties
   * the rewrite replaced are dropped. */
  finishDiagnostics(diagnostics: readonly Diagnostic[]): readonly Diagnostic[];
}

/**
 * Make the transformer that rewrites one module format's globals for an emit in
 * the other, with the diagnostics finisher that goes with it, or return
 * undefined where the project emits neither ES modules nor CommonJS
 * (`node16`/`nodenext`/`preserve` take each file's format from the source).
 * `tsc` emits these globals unchanged, and they throw `ReferenceError` at
 * runtime.
 *
 * Under an ES-module emit, `__dirname`/`__filename` become
 * `import.meta.dirname`/`.filename` (node 20.11 and later). Under a CommonJS
 * emit, the `import.meta` members in {@link CJS_META_MEMBERS} are rewritten,
 * and `finishDiagnostics` drops the checker's TS1343 at each `import.meta` the
 * rewrite replaced. Anything else (`require`/`module`/`exports` under an
 * ES-module emit, another `import.meta` member under CommonJS) is left as the
 * compiler has it, diagnostics included.
 *
 * Only a reference to an ambient declaration (every declaration in a `.d.ts`)
 * is rewritten, so a file's own `__dirname` binding is kept, and the direct
 * operand of `typeof` is left alone. Scripts, `.d.ts` and JSON files, and
 * sources that pinned their own format (`.cts`/`.cjs` under an ES-module emit,
 * `.mts`/`.mjs` under CommonJS) are skipped.
 *
 * `program` is a thunk: the wave's fallback rebuilds the program under the same
 * transformer.
 */
function crossFormatGlobals(ts: ITypeScript, options: CompilerOptions, program: () => IProgram): ICrossFormatGlobals | undefined {
  const direction = emitsEsModules(ts, options) ? "esm" : effectiveModule(ts, options) === ts.ModuleKind.CommonJS ? "cjs" : undefined;
  if (direction === undefined) {
    return undefined;
  }
  const f = ts.factory;
  /* Meta-property starts this rewrite replaced, per file — the span the
   * checker reports TS1343 at, so the two match up. */
  const disposed = new Map<string, Set<number>>();

  const esmTransform = (context: unknown, sourceFile: ISourceFileNode): INode => {
    const checker = program().getTypeChecker();
    /** @return true if `node` is a value reference resolving to the ambient
     * global — every declaration in a declaration file — rather than to a
     * binding of the source's own, or to some property that happens to share
     * the name, otherwise false. */
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
        /* Keep the direct operand of `typeof`: rewriting it would change what
         * the guard detects. A deeper expression is visited normally. */
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
  /* A source that pinned its own format (`legacy.cts` emits `legacy.cjs`) loads
   * as that format whatever `module` says, so it is skipped. */
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
      /* A script has no module format to bridge. */
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
 * @return the layout this compile's specifiers are rewritten in, or undefined
 * where nothing would be rewritten. The extension rewrite is set for an
 * ES-module emit only (not CommonJS, `preserve`, or `node16`/`nodenext`, which
 * decide each file's format); rewrite rules, completed package specifiers and
 * own-package specifiers apply under any module system.
 */
function emitLayoutOf(
  ts: ITypeScript,
  options: CompilerOptions,
  root: string,
  jsExtension?: string,
  rewrites?: IImportRewrite[],
  packageSpecifier?: (specifier: string, containingFile: string) => string | undefined,
  ownSpecifier?: (specifier: string, containingFile: string) => string | undefined,
  exists?: (file: string) => boolean
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
    exists,
  };
}

/**
 * The renames each `--emit-extension` applies to the compile's `.js` output:
 * the JavaScript, its declaration, and their source maps. Its keys are the
 * accepted extensions. Output of a source that pinned its format (a `.cjs` and
 * its `.d.cts` from a `.cts`) is not renamed.
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
 * @return the name an emitted file ships under once the compile's `.js` family is
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
 * Rename the references between an emitted file and its source map to match
 * `--emit-extension`: an emitted file's `//# sourceMappingURL=` comment
 * (JavaScript and declaration alike), and a map's `file` field. Returns the
 * text.
 */
function retargetSourceMap(fileName: string, text: string, jsExtension: string): string {
  if (fileName.endsWith(".map")) {
    /* Parse rather than match text: `sourcesContent` embeds whole source files,
     * which may hold the same text. */
    const map = JSON.parse(text) as { file?: unknown };
    if (typeof map.file === "string") {
      map.file = renamedOutput(map.file, jsExtension);
    }
    return JSON.stringify(map);
  }
  /* Match the link at the end of the file, where the emitter puts it: the same
   * text may appear earlier in a string literal. An inline (`data:`) map names
   * no file, so it renames to itself. */
  return text.replace(
    /(\/\/# sourceMappingURL=)([^\n]*?)(\s*)$/,
    (whole, prefix: string, target: string, tail: string) => `${prefix}${renamedOutput(target, jsExtension)}${tail}`
  );
}

/**
 * Make a resolver that resolves a specifier with the compiler's own
 * `resolveModuleName` over the host's files (not the installed resolution
 * hooks), cached: what the specifier rewrite and the wave ask of a relative
 * specifier.
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

/** @return true if the project emits ES modules — the ES2015..ESNext block,
 * which stops short of `node16`/`nodenext` (per-file) and `preserve` (as
 * written) — otherwise false. */
function emitsEsModules(ts: ITypeScript, options: CompilerOptions): boolean {
  const module = effectiveModule(ts, options);
  return module >= ts.ModuleKind.ES2015 && module < ts.ModuleKind.Node16;
}

/**
 * @return the module kind this compile emits: the stated `module`, else the
 * compiler's own default for the target (`commonjs` below ES2015, `es2015` from
 * it). Every decision by module kind reads this.
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

/**
 * Make the host read through PnP virtual paths: each filesystem call is made on
 * the physical path, while the names the compiler holds, and `realpath`'s
 * answers, stay virtual (the virtual path tells the resolver which package
 * entry a file belongs to). Install it before any other host wrapper, so that
 * recorded reads hold the virtual names.
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

/** @return the first specifier in `text` that points inside the tree pool, if
 * any. */
function treeReferenceIn(text: string, from: string, treeRoots: ReadonlyArray<string>): string | undefined {
  for (const [, , , specifier] of text.matchAll(QUOTED_SPECIFIER)) {
    const target = isPathSpecifier(specifier) ? path.resolve(from, specifier) + path.sep : undefined;
    if (target !== undefined && treeRoots.some(pool => target.startsWith(pool))) {
      return specifier;
    }
  }
  return undefined;
}

/** Render diagnostics as `tsc` does: coloured, with source context, where
 * `pretty`, plain otherwise. */
export function renderDiagnostics(ts: ITypeScript, diagnostics: readonly Diagnostic[], host: ICompilerHost, pretty: boolean): string {
  const formatHost = {
    getCanonicalFileName: (fileName: string) => host.getCanonicalFileName(fileName),
    getCurrentDirectory: () => host.getCurrentDirectory(),
    getNewLine: () => host.getNewLine(),
  };
  return pretty ? ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost) : ts.formatDiagnostics(diagnostics, formatHost);
}

/**
 * Compile the project in the current directory (the staged workspace) as `tsc`
 * would, and return `tsc`'s exit code: 0 with no diagnostics, 1 where there are
 * diagnostics and emit was skipped, 2 where there are diagnostics and output
 * was emitted. Diagnostics are written to stdout, as `tsc` writes them.
 *
 * `argv` holds the arguments after the program name. The project is the one
 * `-p`/`--project` names, else `tsconfig.json`. Where the project states none,
 * the driver sets `moduleResolution` ({@link resolutionFor}) and, where the
 * compiler has the option, `noUncheckedSideEffectImports: true`. Where a PnP
 * table (`.pnp.data.json`) is staged, modules resolve through it
 * ({@link installResolution}) and emitted declarations are rewritten
 * ({@link rewriteDeclaration}). The emit also gets the specifier rewrite
 * ({@link specifierRewriter}) and the cross-format globals rewrite
 * ({@link crossFormatGlobals}) where they apply, and every emitted file
 * {@link relativizeBuildRoot}, a declaration also {@link canonicalizeUnions}.
 *
 * Driver flags:
 * - `--deps-report <file>`: write what the compile read of its packages
 *   ({@link readSetOf}) and the dependency edges it used, with the
 *   incremental run's telemetry.
 * - `--state-dir <dir>` (needs `--deps-report`) with `--changes <file>`:
 *   compile incrementally, from this driver's memo in `<dir>` and the change
 *   lists, checking and emitting only the files the change reaches (a wave),
 *   then write the new memo to `<dir>`. Where the change reaches no file this
 *   compile checks, no program is built.
 * - `--source-declarations <dir>`: compile a source whose declaration is in
 *   `<dir>` (another compile emitted it) against that declaration, neither
 *   checking nor emitting it.
 * - `--emit-extension .mjs`: rename the `.js` output ({@link emitExtensionOf});
 *   needs an ES-module emit.
 * - `--rewrite-imports <file>`: the import rewrite rules
 *   ({@link importRewritesOf}).
 * - `--resources <file>`: the target's own resource names
 *   ({@link resourceNamesOf}).
 * - `--source-paths <file>`: name each source map's sources by the references
 *   the file lists.
 *
 * Throws where the compiler is out of range, the project is missing or
 * unreadable, a flag's value is missing or malformed, `--state-dir` is given
 * without `--deps-report`, a memo is handed back without change lists, or an
 * emitted declaration still points into the tree pool.
 */
export function main(argv: string[]): number {
  // typescript is fetched by fabr into this step's own install and required at
  // runtime: its types are not available at compile time.
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
  /* Set only where the project states none. Not validated again:
   * {@link resolutionFor} picks a value this compiler accepts. */
  if (parsed.options.moduleResolution === undefined) {
    parsed.options.moduleResolution = resolutionFor(ts, parsed.options);
  }
  /* Check side-effect imports (`import "./typo.css"`) where this compiler has
   * the option (TypeScript 5.6+) and the project does not state it. */
  if (parsed.options[CHECK_SIDE_EFFECT_IMPORTS] === undefined && supportsOption(ts, CHECK_SIDE_EFFECT_IMPORTS)) {
    parsed.options[CHECK_SIDE_EFFECT_IMPORTS] = true;
  }
  const host = ts.createCompilerHost(parsed.options, true);
  readThroughVirtualPaths(host);
  const reportPath = depsReportOf(argv);
  /* The directory this driver keeps its state in, staged in and collected by
   * the caller; naming it asks for incremental mode. */
  const stateDirectory = argOf(argv, STATE_DIR_FLAG);
  /* Every file the compiler read, the `package.json`s resolution reads
   * included, which the program's file list does not hold. */
  const opened: string[] = [];
  const readFile = host.readFile;
  if (reportPath !== undefined && readFile !== undefined) {
    host.readFile = (file: string, encoding?: string): string | undefined => {
      opened.push(file);
      return readFile.call(host, file, encoding);
    };
  }
  /* Every file the compiler probed and found absent: such a file appearing
   * would change a resolution, so it is reported as read. {@link readSetOf}
   * keeps only those inside the compile's packages. */
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
  /* A dependency's invalid `exports` map is not reported: it is read as the
   * compiler reads it. */
  const resolver = PnpResolver.load(root, conditionsOf(ts, parsed.options), { validateExports: false });
  /* One rule set for both resolution and emit, so the emit names the file
   * resolution found. */
  const rewrites = importRewritesOf(argv, root);
  /* With no PnP table, resolution is the compiler's, with no resource
   * handling. */
  const installed = resolver
    ? installResolution(ts, host, parsed.options, resolver, root, rewrites, resourceNamesOf(argv, root))
    : undefined;
  /* For the specifier rewrite and the wave to ask what a specifier names. */
  const resolve = moduleResolver(ts, host, parsed.options, root);
  /* Incremental mode: the caller stages this driver's memo of the last green
   * build in the state directory and hands over the names whose content changed
   * since; the driver plans what the change reaches ({@link planCompile}),
   * checks and emits only that, and writes the new memo back. With no
   * `--state-dir` the whole program is compiled. */
  const handover = memoHandoverOf(argv, root);
  if (handover !== undefined && reportPath === undefined) {
    throw new Error(`tsc-driver: ${STATE_DIR_FLAG} needs ${DEPS_REPORT_FLAG}, which is where the run's reads are reported`);
  }
  const namer = nodeNamer(root, resolver);
  const emitDirectory = emitDirectoryOf(parsed.options, root);
  const declarationDirectory = argOf(argv, SOURCE_DECLARATIONS_FLAG);
  const declared =
    declarationDirectory === undefined ? new Map<string, string>() : sourceDeclarationsOf(root, declarationDirectory, parsed, namer);
  const projectNames = new Set(parsed.fileNames.map(namer).filter((name): name is string => name !== undefined));
  const handedOver =
    handover?.changes === undefined || declarationDirectory === undefined
      ? { changes: handover?.changes, moved: new Set<string>() }
      : withDeclarationChanges(handover.changes, declarationDirectory, projectNames, sourceRootOf(parsed.options, root));
  const plan =
    handover === undefined
      ? undefined
      : planCompile(handedOver.changes, handover.memo, projectNames, sourceRootOf(parsed.options, root));
  if (plan !== undefined) {
    prepareEmitTree(root, emitDirectory, plan, declared);
  }
  if (plan !== undefined && reportPath !== undefined && !reachesCheckedFiles(plan, declared, handedOver.moved)) {
    /* No file this compile checks can see the change: the last green build's
     * output and memo stand, and no program is built. */
    const compile: ICompileTelemetry = { wave: [...(plan.seeds ?? [])].sort(), emitted: [], diagnostics: [] };
    fs.writeFileSync(path.resolve(root, reportPath), serializeRunReport([], [], { compile }));
    if (stateDirectory !== undefined) {
      writeDriverState(path.resolve(root, stateDirectory), serializeDriverMemo(plan.memo));
    }
    return EXIT_OK;
  }
  /**
   * Whether the program last built is rooted at a subset of the project files
   * (the plan's `roots`). Read from the program, not the plan: the fallback
   * below rebuilds rooted at every file from the same plan.
   */
  let boundRooted = false;
  const graph =
    plan === undefined
      ? undefined
      : createWaveRun(ts, plan, root, resolver, resolve, () => boundRooted, parsed.fileNames, emitDirectory, {
          declared,
          moved: handedOver.moved,
        });
  const resolveLiterals = host.resolveModuleNameLiterals;
  if (graph !== undefined && resolveLiterals !== undefined) {
    /* Record every specifier the program resolves: a source's imports are its
     * memo's `use` edges, a declaration file's its `forwarding` edges. */
    host.resolveModuleNameLiterals = (literals, containingFile, redirected, options, containingSourceFile, reused) => {
      const answers = resolveLiterals.call(host, literals, containingFile, redirected, options, containingSourceFile, reused);
      literals.forEach((literal, index) =>
        graph.resolved(containingFile, literal.text, answers[index]?.resolvedModule?.resolvedFileName)
      );
      return answers;
    };
  }
  /**
   * Build the program rooted at the project files among `roots`, or at every
   * project file where `roots` is undefined. The compiler adds whatever the
   * roots import, as ordinary sources, so a wave's emit is the same as a full
   * compile's.
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
  /* Specifiers are rewritten during emit, and the text corrections in
   * `writeEmitted` act on the result. One layout serves the JavaScript and the
   * declarations, which land in the same directory. */
  const jsExtension = emitExtensionOf(argv);
  const referenceOf = stagedReferences(argv, root);
  const layout = emitLayoutOf(
    ts,
    parsed.options,
    root,
    jsExtension,
    rewrites,
    installed?.packageSpecifier,
    installed?.ownSpecifier,
    installed?.exists
  );
  if (jsExtension !== undefined && layout?.rewriteExtensions !== true) {
    /* Only an ES-module emit has its specifiers rewritten ({@link emitLayoutOf}):
     * CommonJS renamed to `.mjs` would load as an ES module, its extensionless
     * `require`s naming files that are not there. */
    throw new Error(`tsc-driver: --emit-extension needs an ES-module emit; this project's 'module' produces CommonJS`);
  }
  const rewriter = layout && specifierRewriter(ts, resolve, layout);
  /* First among the before-transforms, so it visits the parse tree: its
   * ambient test asks the checker about original nodes. */
  const crossFormat = crossFormatGlobals(ts, parsed.options, () => program);
  /* In incremental mode the declaration traversal also records forwarding
   * edges, so it runs even where nothing is rewritten (under a CommonJS emit
   * `layout` is undefined and it only observes). */
  const declarations =
    graph === undefined ? rewriter : specifierRewriter(ts, resolve, layout, (file, specifier) => graph.forwards(file, specifier));
  const before = [crossFormat?.transformer, rewriter].filter((entry): entry is TransformerFactory => entry !== undefined);
  const transformers =
    before.length === 0 && declarations === undefined
      ? undefined
      : { ...(before.length > 0 ? { before } : {}), ...(declarations ? { afterDeclarations: [declarations] } : {}) };
  /* Correct each emitted file as the emitter hands it over, before it is
   * written. */
  const writeEmitted: WriteFile = (fileName, text, writeByteOrderMark) => {
    const declaration = DECLARATION_FILE.test(fileName);
    const rewritable = resolver !== undefined && declaration;
    const rewritten = rewritable ? rewriteDeclaration(fileName, text, resolver) : text;
    /* After the declaration rewrite, so a path it reports as a fault is not
     * first changed by this one. */
    const relativized = relativizeBuildRoot(rewritten, root);
    /* Keep this last of the text corrections, so it sorts the text that ships
     * (rewritten specifiers sit inside `import("…").T` members), and before
     * `graph.emitted` hashes the shape: the base build's shape was hashed from
     * sorted text, so hashing anything else would report every union as
     * changed. */
    const canonical = declaration ? canonicalizeUnions(ts, fileName, relativized) : relativized;
    /* The specifiers inside were already written against the renamed layout;
     * only the file's own map references still need renaming. */
    const retargeted = jsExtension === undefined ? canonical : retargetSourceMap(fileName, canonical, jsExtension);
    /* A map names its sources by their fabr references (`--source-paths`). */
    const referenced =
      referenceOf !== undefined && fileName.endsWith(".map")
        ? withReferencedSources(retargeted, fileName, root, referenceOf)
        : retargeted;
    const written = renamedOutput(fileName, jsExtension);
    graph?.emitted(written, declaration, referenced, writeByteOrderMark);
    host.writeFile(written, referenced, writeByteOrderMark);
  };
  let fellBack = false;
  let built = graph === undefined ? undefined : graph.run(program, transformers, writeEmitted);
  if (graph !== undefined && graph.needsFallback()) {
    /* The wave needed a file this program did not hold: the change turned out
     * to affect global scope, or the plan's roots were wrong. Compile again in
     * full, rooted at every file and over a wiped emit tree (`run`'s `full`),
     * so every file the abandoned attempt emitted is written again; the
     * telemetry records the fallback.
     *
     * Do not pass `oldProgram`: the compiler reuses no structure when the root
     * list differs. */
    program = buildProgram(undefined);
    built = graph.run(program, transformers, writeEmitted, true);
    fellBack = true;
  }
  /* Without a wave, the whole project at once — less the sources another
   * compile checked and emitted, which are in the program only to be compiled
   * against. */
  const checked = declared.size === 0 ? undefined : checkedFiles(program, parsed, namer, resolver, declared);
  const emitted =
    built ??
    (checked === undefined
      ? program.emit(undefined, writeEmitted, undefined, false, transformers)
      : emitEach(program, checked, writeEmitted, transformers));
  /* Written after emit, so the declaration rewriter's reads are included, and
   * whether or not the compile succeeded. */
  if (reportPath !== undefined && resolver !== undefined) {
    const compile = graph?.telemetry(fellBack);
    fs.writeFileSync(
      path.resolve(root, reportPath),
      serializeRunReport(readSetOf(program, opened, missed, resolver), resolver.edges(), compile === undefined ? {} : { compile })
    );
  }
  const memo = graph?.memo();
  if (stateDirectory !== undefined && memo !== undefined) {
    writeDriverState(path.resolve(root, stateDirectory), memo);
  }
  /* Sorted and deduplicated as `tsc` does: the config errors overlap the
   * pre-emit set's option diagnostics. In incremental mode the per-file
   * diagnostics are the wave's, with the compilation's option and global
   * diagnostics. Finished after emit, once the cross-format transform has seen
   * every `import.meta` it replaced. */
  const collected = [
    ...parsed.errors,
    ...(graph !== undefined
      ? graph.diagnostics(program)
      : checked === undefined
        ? ts.getPreEmitDiagnostics(program)
        : [
            ...program.getOptionsDiagnostics(),
            ...program.getGlobalDiagnostics(),
            ...checked.flatMap(file => [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)]),
          ]),
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
 * @return the `exports` conditions this compilation satisfies, as node applies
 * them loading its output: `types`; `require` for a CommonJS import and
 * `import` otherwise (by `mode`, an import's `resolution-mode`, else the
 * emitted module kind); `module-sync` (an ES-module entry node 22 and later can
 * `require`); and the project's `customConditions`. The package's map decides
 * their priority, not this order.
 *
 * The other module system's condition is not included, and nor is a platform
 * condition (`node`, `browser`), so a package splitting its types by platform
 * resolves to its `default`, as under `tsc`.
 */
export function conditionsOf(ts: ITypeScript, options: CompilerOptions, mode?: number): string[] {
  const custom = Array.isArray(options.customConditions) ? (options.customConditions as string[]) : [];
  const commonjs = mode === undefined ? effectiveModule(ts, options) === ts.ModuleKind.CommonJS : mode === ts.ModuleKind.CommonJS;
  return ["types", commonjs ? "require" : "import", "module-sync", ...custom];
}

/** The option that makes an unresolvable side-effect import an error. Added in
 * TypeScript 5.6, so a compile may be driven by a compiler without it. */
export const CHECK_SIDE_EFFECT_IMPORTS = "noUncheckedSideEffectImports";

/** @return true if this compiler declares the option `name`, otherwise false;
 * false for every option where the compiler does not expose
 * {@link ITypeScript.optionDeclarations}. */
export function supportsOption(ts: ITypeScript, name: string): boolean {
  return ts.optionDeclarations?.some(option => option.name === name) === true;
}

/**
 * @return the `moduleResolution` for a project that states none, by the module
 * kind it emits and the compiler's version:
 * - `nodenext` resolves `NodeNext`, and the rest of the node family (`node16`,
 *   `node18`) `Node16`, as the compiler requires (TS5110).
 * - An ES-module or `preserve` emit resolves `bundler`.
 * - A CommonJS emit resolves `bundler` from TypeScript 6 (which makes `node10`
 *   an error, TS5107), and `node10` before it (which refuses `bundler` with
 *   CommonJS, TS5095).
 * - Any other (`amd`, `umd`, `system`, `none`) resolves `node10`.
 *
 * With a PnP table, this driver answers every bare specifier itself whichever
 * is chosen.
 */
export function resolutionFor(ts: ITypeScript, options: CompilerOptions): number {
  const kinds = ts.ModuleResolutionKind;
  const module = effectiveModule(ts, options);
  const node10 = kinds.Node10 ?? kinds.NodeJs!;
  /* The node family resolves its own way (TS5109/TS5110): `nodenext` with
   * NodeNext, every other member (`node16`, `node18`) with Node16. */
  if (module === ts.ModuleKind.NodeNext) {
    return kinds.NodeNext;
  }
  if (module >= ts.ModuleKind.Node16 && module < ts.ModuleKind.NodeNext) {
    return kinds.Node16;
  }
  /* `bundler` pairs with an ES-module or `preserve` emit (TS5095), and with
   * CommonJS from TypeScript 6; anything else takes `node10`. */
  if (emitsEsModules(ts, options) || (ts.ModuleKind.Preserve !== undefined && module === ts.ModuleKind.Preserve)) {
    return kinds.Bundler;
  }
  const commonjs = module === ts.ModuleKind.CommonJS;
  const legacy = Number(ts.version.split(".")[0]) < 6;
  return commonjs && !legacy ? kinds.Bundler : node10;
}

/**
 * An incremental compile (a wave, {@link runWave}) bound to this run: it
 * records the edges, outputs and declaration shapes the compile reports as it
 * resolves and emits, runs the wave over a program, and reports the result.
 * A file's `use` edges are what it imports; its `forwarding` edges are what its
 * declarations import, which its importers see through it.
 */
interface IWaveRun {
  /** Record a specifier the declaration traversal passed, in its authored form
   * — a forwarding edge of `containingFile`. */
  forwards(containingFile: string, specifier: string): void;
  /** Record a specifier the program resolved, and what it named. */
  resolved(containingFile: string, specifier: string, target: string | undefined): void;
  /** Record a file the emitter wrote, in its final form. */
  emitted(written: string, isDeclaration: boolean, text: string, byteOrderMark: boolean): void;
  /** Run the wave over `program`, returning the emit result a whole-program
   * emit would. `full` (the fallback rerun) wipes the emit tree and waves every
   * project file. */
  run(program: IProgram, transformers: ICustomTransformers | undefined, write: WriteFile, full?: boolean): IEmitResult;
  /** @return true if the wave needed a project file this program did not hold,
   * so the run must be redone rooted at every project file, otherwise false. */
  needsFallback(): boolean;
  /** @return the diagnostics the wave produced, plus the compilation's own. */
  diagnostics(program: IProgram): readonly Diagnostic[];
  /** @return the memo for the next build of this target key: the base's, merged
   * with what this run learned (see {@link mergeMemo}). */
  memo(): string;
  /** @return the run's own account of itself, for the report's telemetry
   * section. */
  telemetry(fellBack: boolean): ICompileTelemetry;
}

function createWaveRun(
  ts: ITypeScript,
  plan: ICompilePlan,
  root: string,
  resolver: PnpResolver | undefined,
  resolve: (specifier: string, containingFile: string) => string | undefined,
  /** Whether the program currently built is rooted at a subset of the project
   * files; read per run, since the fallback rebuilds rooted at every file. */
  isBoundRooted: () => boolean,
  /** Every project file the compilation has, rooted or not: what is on disk. */
  projectFiles: readonly string[],
  /** The output directory as a node-name prefix, so an attributed output is
   * named as the caller's entry names it. */
  emitDirectory: string,
  /** The sources another compile checked and emitted (by node name, with the
   * declaration it emitted for each — see {@link sourceDeclarationsOf}), and
   * those whose declaration changed since the base build. */
  sourceDeclarations: { declared: ReadonlyMap<string, string>; moved: ReadonlySet<string> }
): IWaveRun {
  const nodeNameOf = nodeNamer(root, resolver);
  /** The project's files by node name: what exists, whatever the program is
   * rooted at. */
  const onDisk = new Set(projectFiles.map(file => nodeNameOf(file)).filter((name): name is string => name !== undefined));
  /** Every specifier the program resolved and what it named, by the file that
   * wrote it; `forwards` reads these before resolving a specifier itself. */
  const resolutions = new Map<string, Map<string, string | undefined>>();
  const useEdges = new Map<string, Map<string, IMemoEdge>>();
  const forwardEdges = new Map<string, Map<string, IMemoEdge>>();
  /** The shapes of this run's emitted declarations, by source. */
  const shapes = new Map<string, string>();
  /** The last green build's declaration shapes, by source: read from the staged
   * base output as this run first overwrites it. */
  const baseShapes = new Map<string, string | undefined>();
  /**
   * What each written name held before this process first wrote it, hashed.
   * Kept for the whole process, not cleared per run: the fallback rerun writes
   * over its first attempt's output and must still compare against the last
   * green build's.
   */
  const priorShapes = new Map<string, string | undefined>();
  const priorShapeOf = (written: string): string | undefined => {
    if (!priorShapes.has(written)) {
      let hash: string | undefined;
      try {
        hash = createHash(SHAPE_DIGEST).update(fs.readFileSync(written)).digest("hex");
      } catch {
        /* Nothing staged at this name (an added file, or a base that emitted
         * none): no shape. */
        hash = undefined;
      }
      priorShapes.set(written, hash);
    }
    return priorShapes.get(written);
  };
  const emittedFiles: string[] = [];
  /** The output names each source emitted, so a later build can remove a
   * deleted source's outputs. */
  const outputs = new Map<string, string[]>();
  /** The output directory as a node-name prefix, stripped from each output name
   * recorded in `outputs`; empty where the compile emits beside its sources. */
  const emitPrefix = emitDirectory;
  const collected: Diagnostic[] = [];
  /** The source the emitter is currently emitting, set around each per-file
   * emit: what each output and shape is attributed to. */
  let emitting: string | undefined;
  let result: IWaveResult = { wave: [] };
  /** Set where the wave needed a project file this program did not hold (the
   * plan's roots were wrong, or the change affects global scope): the caller
   * then compiles again rooted at every file. */
  let fallback = false;
  /** Every file the program holds that is a node of the graph, by node name;
   * filled when the wave runs. */
  const byName = new Map<string, ISourceFileInfo>();
  /** Each file's package lookups that found nothing, as the paths they took
   * (PnpResolver.failedLookupOf): the memo's `failed` lines. Not cleared per
   * run: the table is the same on both sides of a fallback rerun. */
  const failedLookups = new Map<string, Set<string>>();

  /** Make an edge, recording its target only where a later build could not
   * derive it from the specifier and the memo's names ({@link membershipTarget}):
   * a bare name, and a path into an installed package, record their target. */
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
    /* Record each lookup of a bare name, and of its `@types` package, that
     * found nothing: the edge cannot say so, and the package appearing later
     * must re-check this file. */
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
  const forwards = (containingFile: string, specifier: string): void => {
    const known = resolutions.get(containingFile);
    const target = known?.has(specifier) === true ? known.get(specifier) : resolve(specifier, containingFile);
    record(forwardEdges, containingFile, specifier, target);
  };

  return {
    resolved: (containingFile, specifier, target) => {
      const held = resolutions.get(containingFile) ?? new Map<string, string | undefined>();
      resolutions.set(containingFile, held);
      held.set(specifier, target);
      /* A declaration file has no body, so what it imports it forwards. */
      record(DECLARATION_FILE.test(containingFile) ? forwardEdges : useEdges, containingFile, specifier, target);
    },
    forwards,
    emitted: (written, isDeclaration, text, byteOrderMark) => {
      const name = nodeNameOf(written);
      if (name !== undefined) {
        emittedFiles.push(name);
        if (emitting !== undefined) {
          /* Attribute the output to the source being emitted, named relative
           * to the output directory, as the caller's entry names it. */
          const attributed = outputs.get(emitting) ?? [];
          outputs.set(emitting, attributed);
          attributed.push(name.startsWith(emitPrefix) ? name.slice(emitPrefix.length) : name);
        }
      }
      if (isDeclaration && emitting !== undefined) {
        /* Take both shapes now: the staged base output still holds the last
         * green build's bytes (this runs before the write). Pair by the written
         * name, so `foo.ts` and `foo.mts`, or an `--emit-extension` output, each
         * compare against their own artifact. */
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
      /* Clear the abandoned attempt's records, if any. */
      byName.clear();
      emittedFiles.length = 0;
      outputs.clear();
      collected.length = 0;
      shapes.clear();
      baseShapes.clear();
      fallback = false;
      if (full) {
        /* Wipe the files the abandoned attempt emitted. */
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
        /* Read from this program, not the plan: the fallback reruns the same
         * plan rooted at every file. */
        isBoundRooted: () => isBoundRooted(),
        voided: () => fallback,
        /* The wave is growing to every project file: discard the staged base
         * outputs, which a full emit would leave where nothing produces them
         * now. */
        expanding: () => wipeEmitTree(root, emitDirectory),
        isGlobal: name => {
          const file = byName.get(name);
          return file === undefined ? undefined : affectsGlobalScope(ts, file);
        },
        targetOf: (from, edge) => {
          if (edge.target !== undefined) {
            return edge.target;
          }
          /* No target recorded: resolve the specifier, and where its file is
           * gone, derive the target from the memo's names. */
          const resolved = resolve(edge.specifier, path.resolve(root, from));
          const live = resolved === undefined ? undefined : nodeNameOf(resolved);
          return live ?? membershipTarget(from, edge.specifier, name => plan.memo.has(name));
        },
        fileFor: name => {
          const file = byName.get(name);
          if (file === undefined) {
            /* The wave needs a file this program does not hold. Where the file
             * exists, the plan's roots were wrong: void the run. Where it does
             * not, it is a deleted source or a dependency's declaration, with
             * nothing to emit. */
            if (onDisk.has(name)) {
              fallback = true;
            }
            return undefined;
          }
          if (!isProject(name)) {
            return undefined;
          }
          const declaration = sourceDeclarations.declared.get(name);
          if (declaration !== undefined) {
            /* Checked and emitted by another compile: its forwarding edges are
             * what its declaration imports, and its shape moved where that
             * declaration changed, or the memo has no line for it. */
            return () => {
              for (const imported of ts.preProcessFile(fs.readFileSync(declaration, "utf8"), true, false).importedFiles) {
                forwards(file.fileName, imported.fileName);
              }
              return sourceDeclarations.moved.has(name) || !plan.memo.has(name);
            };
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
            /* No emitted declaration to compare (an imported `.json`, a
             * hand-written declaration file): its shape is its content, which
             * changed where the plan seeds it. */
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
          /* A dependency's declaration file this compile read gets a line, for
           * a wave across packages to walk; one it did not read keeps its
           * old line. */
          known.add(name);
        } else if (!plan.memo.has(name)) {
          /* A project file the program holds with no line yet (an imported
           * `.json` outside the include globs) gets one, so a later change to
           * it is found. A file that has a line keeps it: replacing it would
           * lose forwarding edges only its emit records. */
          known.add(name);
        }
      }
      for (const name of known) {
        const source = byName.get(name);
        if (source === undefined) {
          /* A deleted file: leave it out, so the merge drops its line. */
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

/** @return the compile's output directory as a prefix on node names (`build/`),
 * or the empty string where output lands beside its sources. */
function emitDirectoryOf(options: CompilerOptions, root: string): string {
  const outDir = options.outDir;
  if (typeof outDir !== "string") {
    return "";
  }
  const relative = posixRelative(root, path.resolve(root, outDir));
  return relative === "" || relative.startsWith("..") ? "" : `${relative}/`;
}

/** Make the function naming a file in the graph: a dependency's file by the
 * path it is reached by (PnpResolver.pathNameOf), a file of the workspace by
 * its path relative to `root`, the names the read set and the change lists
 * use. It returns undefined for any other file (the compiler's own
 * libraries). */
function nodeNamer(root: string, resolver: PnpResolver | undefined): (file: string) => string | undefined {
  return file => {
    const reached = resolver?.pathNameOf(file);
    if (reached !== undefined) {
      return reached;
    }
    const relative = posixRelative(root, path.resolve(file));
    return relative.startsWith("..") || path.isAbsolute(relative) ? undefined : relative;
  };
}

/** @return the compile's source root as a node-name prefix (`src`), or
 * undefined where the project states none (every change is then a full
 * compile). */
function sourceRootOf(options: CompilerOptions, root: string): string | undefined {
  const rootDir = options.rootDir;
  if (typeof rootDir !== "string") {
    return undefined;
  }
  const relative = posixRelative(root, path.resolve(root, rootDir));
  return relative === "" || relative.startsWith("..") ? undefined : relative;
}

/**
 * Make the staged base output tree agree with the plan before anything emits:
 * for a full compile (no seeds), remove it; for a wave, remove the outputs the
 * memo attributes to deleted sources and to sources another compile now
 * declares (`declared`).
 */
function prepareEmitTree(root: string, emitDirectory: string, plan: ICompilePlan, declared: ReadonlyMap<string, string>): void {
  if (plan.seeds === undefined) {
    wipeEmitTree(root, emitDirectory);
    return;
  }
  for (const name of [...plan.deleted, ...declared.keys()]) {
    for (const output of plan.memo.get(name)?.outputs ?? []) {
      const file = path.resolve(root, emitDirectory, output);
      /* Never remove outside the workspace, whatever a damaged memo says. */
      if (file.startsWith(path.resolve(root) + path.sep)) {
        fs.rmSync(file, { force: true });
      }
    }
  }
}

/** Remove the staged base output directory; nothing where the compile emits
 * beside its sources. */
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
 * @return true if a file's declarations may affect the whole program, so that
 * no import edge reaches everything a change to it affects, otherwise false: a
 * script (a file that is no module), or a module with any `declare module` or
 * `declare global` block. A JSON file never does. The compiler counts only
 * `declare global` as affecting global scope.
 */
function affectsGlobalScope(ts: ITypeScript, file: ISourceFileInfo): boolean {
  /* JSON is neither: it declares nothing, and its shape is its content. */
  if (file.fileName.endsWith(".json")) {
    return false;
  }
  const isModule = ts.isExternalModule ? ts.isExternalModule(file) : file.externalModuleIndicator !== undefined;
  return !isModule || (file.moduleAugmentations ?? []).length > 0;
}

/** Structure a diagnostic as data, for comparing two runs' outcomes. */
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
    /* Named through the compiler's enum's reverse mapping. */
    category: String(ts.DiagnosticCategory[String(info.category)] ?? info.category),
    message: ts.flattenDiagnosticMessageText(info.messageText, " "),
    ...(at ? { line: at.line + 1, character: at.character + 1 } : {}),
  };
}

/**
 * @return what this compilation read of the packages it was given
 * ({@link PnpResolver.readSetOf}): the program's files, every file the
 * compiler opened (`package.json`s included), and every file it probed and
 * found absent. Files outside the packages (the sources, the tool's own
 * install, the compiler's libraries) are left out.
 */
function readSetOf(program: IProgram, opened: string[], missed: ReadonlySet<string>, resolver: PnpResolver): string[] {
  /* An absent file is listed like a present one: a read-set row is a path
   * either way. */
  return resolver.readSetOf([...program.getSourceFiles().map(file => file.fileName), ...opened, ...missed]);
}

/**
 * @return each project source another compile emitted a declaration for, by
 * node name, with that declaration's path: `<directory>/a/x.d.ts` declares the
 * source at `<rootDir>/a/x.ts` (or `.tsx`, `.js`, `.jsx`), a `.d.mts` an `.mts`
 * or `.mjs`, a `.d.cts` a `.cts` or `.cjs`.
 */
function sourceDeclarationsOf(
  root: string,
  directory: string,
  parsed: IParsedCommandLine,
  namer: (file: string) => string | undefined
): Map<string, string> {
  const declared = new Map<string, string>();
  const rootDir = parsed.options.rootDir;
  if (typeof rootDir !== "string") {
    return declared;
  }
  for (const file of parsed.fileNames) {
    const extension = path.extname(file);
    const declarationExtension = DECLARATION_EXTENSION.get(extension);
    const name = namer(file);
    if (declarationExtension === undefined || DECLARATION_FILE.test(file) || name === undefined) {
      continue;
    }
    const relative = path.relative(path.resolve(root, rootDir), file);
    const declaration = path.resolve(root, directory, relative.slice(0, -extension.length) + declarationExtension);
    if (fs.existsSync(declaration)) {
      declared.set(name, declaration);
    }
  }
  return declared;
}

/**
 * Fold the changes to the declarations under `directory` into the changes to
 * the sources they declare: a declaration's own name is no file of this
 * compile's graph, while the source it declares is, and whether its interface
 * moved is whether the declaration did. `moved` is every project source a
 * changed or deleted declaration declares; each is seeded as changed.
 */
function withDeclarationChanges(
  changes: IChangeLists,
  directory: string,
  projectFiles: ReadonlySet<string>,
  sourceRoot: string | undefined
): { changes: IChangeLists; moved: Set<string> } {
  const prefix = `${normalizeName(directory)}/`;
  const isDeclaration = (name: string): boolean => name.startsWith(prefix);
  const declaredBy = (name: string): string[] => {
    const stem = sourceStem(name.slice(prefix.length));
    return [...DECLARATION_EXTENSION]
      .filter(([, declarationExtension]) => name.endsWith(declarationExtension))
      .map(([extension]) => `${sourceRoot}/${stem}${extension}`)
      .filter(source => projectFiles.has(source));
  };
  const moved = new Set(
    sourceRoot === undefined ? [] : [...changes.changed, ...changes.deleted].filter(isDeclaration).flatMap(declaredBy)
  );
  const changed = changes.changed.filter(name => !isDeclaration(name));
  const deleted = changes.deleted.filter(name => !isDeclaration(name));
  return { changes: { changed: [...new Set([...changed, ...moved])].sort(), deleted }, moved };
}

/**
 * @return true if the changes `plan` starts from can reach a file this compile
 * checks, otherwise false: they can wherever there is no bound, a deletion, or
 * a seed that is not a declared source, whose declaration moved, that the memo
 * does not know, or that affects global scope (a declared source passes a
 * change on only where its declaration moved).
 */
function reachesCheckedFiles(plan: ICompilePlan, declared: ReadonlyMap<string, string>, moved: ReadonlySet<string>): boolean {
  return (
    plan.seeds === undefined ||
    plan.deleted.size > 0 ||
    [...plan.seeds].some(
      name => !declared.has(name) || moved.has(name) || !plan.memo.has(name) || plan.memo.get(name)?.global === true
    )
  );
}

/** @return the project's files that are this compile's to check and emit:
 * every root, and every project file the program holds as a root imports it
 * (as a wave's project files are: no default library, nothing of a package
 * `resolver` installs), but the sources another compile emitted a declaration
 * for. */
function checkedFiles(
  program: IProgram,
  parsed: IParsedCommandLine,
  namer: (file: string) => string | undefined,
  resolver: PnpResolver | undefined,
  declared: ReadonlyMap<string, string>
): SourceFile[] {
  const roots = new Set(parsed.fileNames.map(file => path.resolve(file)));
  return program.getSourceFiles().filter(file => {
    if (program.isSourceFileDefaultLibrary(file) || resolver?.instanceNameOf(file.fileName) !== undefined) {
      return false;
    }
    const name = namer(file.fileName);
    return name === undefined ? roots.has(path.resolve(file.fileName)) : !declared.has(name);
  });
}

/** Emit each of `files`, as one result. */
function emitEach(
  program: IProgram,
  files: readonly SourceFile[],
  write: WriteFile,
  transformers: ICustomTransformers | undefined
): IEmitResult {
  const results = files.map(file => program.emit(file, write, undefined, false, transformers));
  return { emitSkipped: results.some(result => result.emitSkipped), diagnostics: results.flatMap(result => [...result.diagnostics]) };
}

/**
 * @return the program's roots: the project files among `roots` (project-relative
 * names), or every project file where `roots` is undefined. The compiler adds
 * what the roots import. A name in `roots` with no file (a deletion) is no
 * root.
 */
function programRoots(parsed: IParsedCommandLine, roots: ReadonlySet<string> | undefined, root: string): string[] {
  if (roots === undefined) {
    return parsed.fileNames;
  }
  const rooted = new Set([...roots].map(name => path.resolve(root, name)));
  return parsed.fileNames.filter(file => rooted.has(path.resolve(file)));
}

/** The file this driver keeps in its state directory: its memo of the last
 * green build. */
const DRIVER_MEMO_FILE = "memo";

/**
 * Read what incremental mode was handed about the last green build: the change
 * lists (`--changes`) and this driver's memo from the state directory.
 *
 * @return undefined without `--state-dir`; `{}` where no change-lists file
 * exists (a cold build, which writes the first memo); otherwise the change
 * lists, with the memo where one is present and parses (a memo this build
 * cannot parse, or none, means a cold compile).
 *
 * Throws where a memo is present but no change-lists file is, or where the
 * change lists cannot be read.
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
  /* The change-lists file, not the flag, says there is a base: the caller
   * names the location either way, and writes the file only where it has
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
    changes = parseChangesDocument(fs.readFileSync(path.resolve(root, changesPath), "utf8"));
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

/** Read `--deps-report <file>`: where to write what this run read, relative to
 * the working directory. Absent (the ordinary CLI-parity invocation) reports
 * nothing. */
function depsReportOf(argv: string[]): string | undefined {
  return argOf(argv, DEPS_REPORT_FLAG);
}

/** @return a flag's value, or undefined for an absent flag; a flag with nothing
 * after it is an error naming the flag. */
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

/** @return the project to compile: `--project <path>`/`-p <path>` as the CLI
 * spells it, else `tsconfig.json` in the working directory. */
function projectOf(argv: string[]): string {
  const flag = argv.findIndex(arg => arg === "--project" || arg === "-p");
  return flag >= 0 && argv[flag + 1] !== undefined ? argv[flag + 1] : "tsconfig.json";
}

/** The flag naming a file of import rewrite rules, a JSON array of
 * `{pattern, replacement}`, applied both before resolution and at emit. See
 * {@link IEmitLayout.rewrites}. */
const REWRITES_FLAG = "--rewrite-imports";

/** The flag naming a file of the target's own resources (files no step
 * compiles, not staged for the compile): a JSON array of rootDir-relative
 * names. See {@link installResolution}. */
const RESOURCES_FLAG = "--resources";

/**
 * Read the resource names this compile was handed, or undefined without
 * `--resources`. Throws where the file cannot be read or is not a JSON list of
 * strings.
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
    throw new Error(
      `tsc-driver: cannot read the ${RESOURCES_FLAG} names at '${named}': ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.some(name => typeof name !== "string")) {
    throw new Error(`tsc-driver: the ${RESOURCES_FLAG} names at '${named}' are not a list of strings`);
  }
  return parsed as string[];
}

/**
 * Read the `--rewrite-imports` rules this compile was handed, or undefined
 * without the flag. Throws where the file cannot be read, is not a list of
 * pattern/replacement pairs, or holds a pattern that is not a valid regular
 * expression.
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
    throw new Error(
      `tsc-driver: cannot read the ${REWRITES_FLAG} rules at '${named}': ${err instanceof Error ? err.message : String(err)}`
    );
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
    /* Compile it here, so a malformed expression is reported against the
     * document. */
    try {
      new RegExp(rule.pattern);
    } catch (err) {
      throw new Error(`tsc-driver: the ${REWRITES_FLAG} rule at index ${index} is not a valid expression: ${String(err)}`);
    }
    return { pattern: rule.pattern, replacement: rule.replacement };
  });
}

/**
 * Read `--emit-extension <ext>`: what this compile's `.js` output is renamed
 * to, so its tree can ship beside another compile's, or undefined without the
 * flag. Only `.mjs` is accepted ({@link RENAMED_EXTENSION}): `.cjs` would need a
 * CommonJS emit's specifiers rewritten (`require("./util")` does not find
 * `util.cjs`), which this driver does not do. Throws for any other value.
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
 * Make the host a config file is read through: the compiler's own `sys`, which
 * the config parser walks to expand `include` globs (a host missing
 * `readDirectory` yields a project with no files). An unrecoverable config
 * diagnostic throws; recoverable ones come back in `errors`.
 */
export function configHost(ts: ITypeScript): unknown {
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
