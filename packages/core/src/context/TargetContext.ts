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

import { FetchOptions, IFetchRequest } from "../core/BuildCache";
import { Computable } from "../core/Computable";
import { ITaskReport } from "../support/Execute";
import { FileSet, FileSource } from "../core/FileSet";
import { RepositoryPublishRef, Repository, SourceRef } from "../core/Repository";
import { collectLists, ResolutionOptions } from "./CollectionPoint";
import { FileSetRef } from "../core/FileSetRef";
import { PartialRepositoryRef } from "../core/PartialRepositoryRef";
import { NamespaceRef } from "../core/NamespaceRef";
import { IProjection, Miss } from "../core/Reference";
import { materializeTargets } from "../core/TargetRef";
import { RunnableArgument, RunnableFileSet } from "../core/RunnableFileSet";
import { Dependency, PackageFileSet } from "../core/PackageFileSet";
import { Requirement } from "../resolver/Types";
import { declaredRequirement } from "../resolver/PackageResolver";
import { Flag } from "../core/Flag";
import { RuleBlockDefinition, SubTargetInputs } from "../rules/Types";
import { Constraints, operationOf } from "../model/Constraints";
import { IFetchReport, ITargetBuildTask, TaskDescription } from "../model/BuildEvents";
import { ExecutionContext } from "../model/ExecutionContext";
import { ITargetOrigin, TARGET_PROVENANCE } from "../model/Target";
import {
  DeclKind,
  declPosn,
  IPropertyDecl,
  isNameValue,
  IMapItemDecl,
  isPropertyDecl,
  ISpliceDecl,
  ITargetDecl,
  ITargetDefDecl,
  IValue,
  PropertyType,
  declName,
  mergedDecls,
  soleDecl,
} from "../model/AST";
import { DependencyFailedError, NameResolutionError } from "../model/Errors";
import { FabrError } from "../core/Errors";
import { Name } from "../core/Name";
import { Property } from "../model/Property";
import { writtenSeparator } from "../model/Namespace";
import { IDependencyStack, requestingTargets, useSiteOf } from "./Stack";
import { ReferenceLabel } from "../model/Errors";
import {
  collectRunnable,
  CommandValue,
  ICommandStageLookup,
  IPositionedName,
  MaterializedCommandPipeline,
  MaterializedCommandStage,
} from "./Commands";
import { ContainedSources, PackageSources } from "./Collection";
import type { InternalBuildContext, IRepositoryMember, ISplicedEntry } from "./BuildContext";
import { validatePropertyShape } from "../model/Validate";
import type { ResolvedTarget } from "./ResolvedTarget";
import type { PropertyMap } from "./PropertyMap";

/**
 * The context a target's rule runs in, for both `requirements` and `evaluate`:
 * it looks up the target's properties and the globals, and builds sub-targets.
 * A rule has no work directory. All work on content is done by the build
 * actions it yields, or by the sub-targets it builds.
 *
 * A rule cannot tell whether it is building a declared or an anonymous target.
 * Only the per-property-type readers (`getProperty`, `getFileProperty`,
 * `getRewriteRules`, `getProjection`, `getMap`, `getCommandStages`,
 * `getWildcardProperties`) and the identity and attribution members (`name`,
 * `taskDescription`, `getDeclaredContext`, `stampProvenance`, `failure`)
 * differ between the two implementations. Everything else is built on those
 * and shared here.
 */
export abstract class TargetContext {
  protected readonly context: InternalBuildContext;
  public readonly stack?: IDependencyStack;
  /** The schema of the target's type, whose declared defaults answer for a
   * property the target supplies no value for. */
  protected readonly targetDef: ITargetDefDecl;

  constructor(context: InternalBuildContext, targetDef: ITargetDefDecl, stack?: IDependencyStack) {
    this.context = context;
    this.targetDef = targetDef;
    this.stack = stack;
  }

  private readonly ruleStates = new Map<object, unknown>();

  /**
   * Get the state `rule` keeps for this target, from stating what it requires
   * to evaluating it, made by `make` on first use.
   */
  public ruleState<T>(rule: object, make: () => T): T {
    if (!this.ruleStates.has(rule)) {
      this.ruleStates.set(rule, make());
    }
    return this.ruleStates.get(rule) as T;
  }

  /**
   * Get the declared default for `name` as a property decl, or undefined if the
   * schema declares none. Every accessor consults it where the target supplies
   * no value: an unwritten property on a declared target, or an absent key in a
   * sub-target's inputs. A sub-target's creator omits a key to take the default
   * and passes an empty value to suppress it. The `*` entry has no default.
   */
  protected declaredDefault(name: string): IPropertyDecl | undefined {
    return this.targetDef.properties.get(name)?.default;
  }

  /** The name of the (declared) target being built — what a rule refers to
   * itself as; for an anonymous sub-target, its declared owner's name. */
  public abstract get name(): string;

  /** The name the target is declared under in its configuration: what its own configuration resolves it by. */
  protected get declaredName(): string {
    return this.name;
  }

  /** Get the configuration this target's own name is resolved in: its own,
   *  as the file declaring it sees it. */
  protected get ownConfiguration(): InternalBuildContext {
    return this.context.inFile(this.getDeclaredContext().target.source.file);
  }

  /** The operation this target's configuration is under (see
   * {@link operationOf}). */
  public get operation(): string {
    return operationOf(this.context.getConstraints());
  }

  /** Get a STRING property's value, looked up from the target's declaration or
   * taken from a sub-target's inputs; undefined where it is unwritten and has no
   * default. */
  public abstract getProperty(name: string, overrides?: Constraints): Computable<Property | undefined>;

  /** Get the sources a FILES property names, unmaterialized: looked up from the
   * target's declaration, or taken from a sub-target's inputs, which are
   * already content. */
  public abstract getFileProperty(name: string, overrides?: Constraints): Computable<SourceRef[]>;

  /**
   * Read a PACKAGES property as packages (see {@link PackageSources}): for a
   * requirement on packages, where a target is the package of its name and
   * the lot is resolved together. {@link getFileProperty} as a requirement
   * is the files of what the property names, and nothing more.
   */
  public getPackageProperty(name: string, overrides?: Constraints): Computable<PackageSources> {
    const schema = this.targetDef.properties.get(name) ?? this.targetDef.properties.get("*");
    if (schema !== undefined && schema.type !== PropertyType.Packages) {
      return Computable.reject(
        new FabrError(`internal: '${name}' of ${this.targetDef.name} is not declared PACKAGES, and is read as packages`).withHelp(
          `declare it \`${name} = PACKAGES;\` in the targetdef, or read it with getFileProperty`
        )
      );
    }
    return this.getFileProperty(name, overrides).then(sources => new PackageSources(sources));
  }

  /**
   * Read a FILES property as contained (see {@link ContainedSources}): the
   * collection point leaves its projections pending, for a rule that places the
   * container and locates entries within it ({@link FileSetRef.locate}).
   */
  public getContainedFileProperty(name: string, overrides?: Constraints): Computable<ContainedSources> {
    return this.getFileProperty(name, overrides).then(sources => new ContainedSources(sources));
  }

  /**
   * Read a property for the loose files it names: the files in hand, with a
   * target, a package and a repository's reference left out, unbuilt. Read
   * from `evaluate`: nothing it names is then a requirement of the target, so
   * a target it names may depend on this one. (Among a rule's requirements,
   * the targets a property names are resolved where it is read.)
   */
  public getLooseFileProperty(name: string, overrides?: Constraints): Computable<FileSet[]> {
    return this.getFileProperty(name, overrides).then(sources =>
      sources.filter((source): source is FileSet => source instanceof FileSet && !(source instanceof PackageFileSet))
    );
  }

  /**
   * Get a REWRITE property's values: each a `sel -> tmpl` rename or a bare
   * constant, in written order. `makeRewrite` turns them into a first-match-wins
   * mapping function. A caller may instead hand them to a build step's driver
   * as rules ({@link Name.toRenameRule}).
   */
  public abstract getRewriteRules(name: string, overrides?: Constraints): Computable<Name[]>;

  /** Look up a projection property's one selector (with any `-> tmpl` rename,
   * such as `generate`'s `output`), substituted, for a step to apply with
   * {@link Name.makeProjector}. Undefined where the property is unwritten. More
   * than one value is an error. */
  public abstract getProjection(name: string, overrides?: Constraints): Computable<Name | undefined>;

  /** Look up a MAP property's value (see {@link InternalBuildContext.lookupMap}).
   * An unwritten property yields an empty map. */
  public abstract getMap(name: string, overrides?: Constraints): Computable<PropertyMap>;

  /** Get the names of the properties of its type this target has a value for: those it is given, and those its type gives a default. */
  public abstract getPropertyNames(): Computable<string[]>;

  /**
   * Describe an action of this target as a task: the declared target under this
   * evaluation's constraints, with a labelled sub-target's action verb
   * ("Compiling X" rather than "Building X"). Read once per action performed.
   */
  public abstract taskDescription(): ITargetBuildTask;

  /** Get the context of the declared target this evaluation belongs to (this
   * one, for a declared target). */
  public abstract getDeclaredContext(): DeclaredTargetContext;

  /** Stamp the target's provenance onto a FileSet it yields: the declared
   * target's TARGET_PROVENANCE step. An anonymous target adds none, since its
   * declared owner's stamp covers the composed result. */
  public abstract stampProvenance(result: FileSet): FileSet;

  /** Wrap a failure into this target's error boundary — a DependencyFailedError
   * identifying the declared target (an anonymous sub-target additionally
   * carries its action-verb label, for "Compiling X failed" rendering). */
  public abstract failure(err: Error): DependencyFailedError;

  /** Look up the wildcard (reference-keyed) properties written in this target's
   * body, such as the members of a `sync` (`@npm:@fabr-build/core:${VERSION} =
   * core`). Each comes back as its `key`, the written reference substituted,
   * and its `decl`, whose span positions a per-member error and whose `name`
   * reads the member's content with `getFileProperty`. Nothing is read beyond
   * the keys. A member whose guard excludes this configuration is left out;
   * properties the schema declares are not members, and an anonymous target has
   * none. `${...}` in a key substitutes under `overrides`. */
  public abstract getWildcardProperties(overrides?: Constraints): Computable<{ key: Name; decl: IPropertyDecl }[]>;

  /** Look up a COMMAND property's stages, substituted, each name carrying its
   * written span (see {@link InternalBuildContext.lookupCommand}). The rule-facing
   * form is {@link getCommandProperty}. Empty where the property is unwritten. */
  protected abstract getCommandStages(name: string): Computable<ICommandStageLookup[]>;

  /** Get a COMMAND property's value, to pass on to a sub-target. A rule that
   * runs the command itself reads {@link getCommandProperty} instead. */
  public getCommand(name: string): Computable<CommandValue> {
    return this.getCommandStages(name).then(stages => new CommandValue(stages));
  }

  /**
   * Materialize a COMMAND property's pipeline for a `generate` rule: each
   * stage's command as a runnable, its arguments with globs expanded over `srcs`
   * (a glob matching nothing is an error), its `< source` as a single-file set
   * and its redirections as the names of the files they capture. Empty where the
   * property is unwritten.
   */
  public getCommandProperty(name: string, srcs: FileSet): Computable<MaterializedCommandPipeline> {
    return this.getCommandStages(name).then(stages =>
      Computable.forAll(
        stages.map(stage => this.materializeStage(stage, srcs)),
        (...resolved: MaterializedCommandStage[]) => resolved
      )
    );
  }

  /** Materialize one stage, as {@link getCommandProperty} describes. */
  private materializeStage(stage: ICommandStageLookup, srcs: FileSet): Computable<MaterializedCommandStage> {
    return Computable.forAll(
      [this.materializeCommandRunnable(stage), this.materializeStdin(stage), this.expandArgs(stage.args, srcs)],
      (runnable: RunnableFileSet, stdin: FileSet | undefined, args: string[]): MaterializedCommandStage => ({
        runnable,
        args,
        stdin,
        stdout: stage.stdout?.name.toString(),
        stderr: stage.stderr?.name.toString(),
        mergedTo: stage.mergedTo,
      })
    );
  }

  /** Expand a stage's args over the staged `srcs`: a glob arg matches file names
   * in `srcs` (failglob — an empty match is a positioned error); a literal arg
   * passes through. */
  private expandArgs(args: IPositionedName[], srcs: FileSet): Computable<string[]> {
    return Computable.forAll(
      args.map(arg => {
        if (!arg.name.hasGlob()) {
          return Computable.resolve([arg.name.toString()]);
        }
        return srcs.find(arg.name).then(matched => {
          const names = [...matched].map(([fileName]) => fileName).sort();
          if (names.length === 0) {
            throw new NameResolutionError(arg.name, declPosn(arg.ref), useSiteOf(this.stack), "no files in 'srcs' match this glob");
          }
          return names;
        });
      }),
      (...expanded: string[][]) => expanded.flat()
    );
  }

  /** Materialize a stage's command as the runnable it names, under
   * {@link runOverrides}. The command is looked up as a written reference, so it
   * may be a target or global (`gendoc`, `TSC`), an external requirement
   * (`@npm:typia:9.7.1`), a projection into either (`@npm:typescript:5.4.5:tsc`),
   * or a path rooted at the build file it was written in. */
  private materializeCommandRunnable({ command, site }: ICommandStageLookup): Computable<RunnableFileSet> {
    return this.context
      .lookupFileValue(command.name, this.stack, { relativeTo: command.ref, callerOverrides: this.runOverrides() })
      .then(sources => collectRunnable(this.context, this, sources, command.name.toString()))
      .labelled(site && new ReferenceLabel({ value: command.ref, ...site }));
  }

  /** Materialize a stage's `< source` as a single-file set, or undefined where
   * the stage takes no stdin. The source is looked up as a FILES value is, so it
   * may be a path rooted at the build file it was written in. */
  private materializeStdin({ stdin, site }: ICommandStageLookup): Computable<FileSet | undefined> {
    if (!stdin) {
      return Computable.resolve(undefined);
    }
    return this.context
      .lookupFileValue(stdin.name, this.stack, { relativeTo: stdin.ref })
      .then(sources => collectLists(this, [sources], undefined, [true]))
      .then(([resolved]) => this.context.applyProjections(resolved))
      .then(resolved => {
        const set = FileSet.unionAll(...resolved.filter((source): source is FileSet => source instanceof FileSet));
        const files = [...set];
        if (files.length !== 1) {
          throw new NameResolutionError(
            stdin.name,
            declPosn(stdin.ref),
            useSiteOf(this.stack),
            `stdin source must resolve to exactly one file (got ${files.length})`
          );
        }
        return new FileSet(new Map([[files[0][0], files[0][1]]]));
      })
      .labelled(site && new ReferenceLabel({ value: stdin.ref, ...site }));
  }

  /**
   * Look up a write coordinate, such as a `sync` member's
   * `@npm:@fabr-build/core:0.1.0`, as a publish reference. A write coordinate
   * names where content goes, and need not exist in the repository yet. The
   * repository's name is split off by the prefix match a read uses, and the
   * repository vends a reference for the rest
   * ({@link Repository.getRepositoryPublishRef}), which throws without fetching
   * anything where the address is malformed or the repository is not a publish
   * destination. `name` must already be substituted, as
   * {@link getWildcardProperties} gives a `sync`'s keys.
   */
  /** @return true if the target declared as `name` has a rule for `operation`, otherwise false. */
  public hasTargetRule(name: string, operation: string): boolean {
    const operations = this.getTargetOperations(name);
    return operations.includes(operation) || operations.includes("*");
  }

  /** @return the operations the target declared as `name` has rules for, as their guards write them (`*` for any). */
  public getTargetOperations(name: string): string[] {
    return this.context.getTargetOperations(name);
  }

  public lookupPublishRef(name: Name): Computable<RepositoryPublishRef> {
    const match = this.ownConfiguration.getPrefixTargetIfExists(name, this.stack);
    if (!match) {
      return Computable.reject(new FabrError(`'${name.toString()}' does not name a repository`));
    }
    return match.target.then(sources => publishRefIn(sources, match.rest, writtenSeparator(match.retainedPrefix), match.name, name));
  }

  public getRequiredProperty(name: string, overrides?: Constraints): Computable<Property> {
    return this.getProperty(name, overrides).then(prop => {
      if (!prop) {
        throw new FabrError("Missing required property " + name);
      }
      return prop;
    });
  }

  public getRequiredString(name: string, overrides?: Constraints): Computable<string> {
    return this.getRequiredProperty(name, overrides).then(prop => prop.toString());
  }

  /** Get a STRING property's value as a string; undefined where it is unwritten
   * and has no default. */
  public getString(name: string, overrides?: Constraints): Computable<string | undefined> {
    return this.getProperty(name, overrides).then(prop => prop?.toString());
  }

  /**
   * Memoize the result of pure resolution work (a joint version selection) in
   * the build cache, under `memo:<tag> <key>`. The tag is a stable
   * `name:version`, whose version is bumped when the computation's behaviour
   * changes. A memo is never reported as a task.
   */
  public memoize(tag: string, key: string, create: (targetDir: string) => Computable<FileSet>): Computable<FileSet> {
    return this.context.getCachedOrBuild(`memo:${tag} ${key}`, ctx => create(ctx.workDir).then(result => ({ result })));
  }

  /**
   * Materialize sources as {@link getFileProperty} returns them: targets among
   * them are built, references resolved and fetched, and pending projections
   * applied (descending into archives); content passes through. A
   * `repository_group` content route reads the source it serves this way, while
   * it is resolved. They are a collection of their own, strict unless
   * `options` says otherwise (a tool's packages, resolved permissively).
   */
  public materializeSources(sources: SourceRef[], options?: ResolutionOptions): Computable<(FileSource | Repository | FileSet)[]> {
    return collectLists(this, [sources], options, [true]).then(([delivered]) => this.context.applyProjections(delivered));
  }

  /**
   * The run's fixed surroundings — the build cache, log, source/absolute
   * FileSources (for config a repository consults, e.g. a `.npmrc` read through
   * the source FS so it participates in watch-mode invalidation), and per-plugin
   * state. Shared by every InternalBuildContext of the run.
   */
  public get execution(): ExecutionContext {
    return this.context.execution;
  }

  /**
   * Download what `cacheKey` identifies through the build cache (see
   * BuildCache.getOrFetch), making `request` only on a miss. A download, never
   * a cache hit, is reported as a task. `report` says what is
   * fetched: a noun for the resource, and whether it is a content or an index
   * read ({@link IFetchReport}). Nothing in it reaches the cache key or the
   * request. `options.immutable = false` marks a mutable pointer document (see
   * FetchOptions), which is cached under HTTP caching rules and revalidated.
   */
  public fetch(
    cacheKey: string,
    tag: string,
    request: () => Computable<IFetchRequest>,
    report: IFetchReport,
    options?: FetchOptions
  ): Computable<FileSet> {
    /* The cache opens the task around the transfer alone, never on a hit, and
     * reports the bytes received as its progress. */
    return this.context.execution.buildCache.getOrFetch(
      cacheKey,
      tag,
      request,
      url => run => this.runTask({ kind: "fetch", url, ...report }, run),
      { ...options, role: report.role }
    );
  }

  public getFlags(name: string, overrides?: Constraints): Computable<Flag[]> {
    return this.getFileProperty(name, overrides).then(sources => sources.filter(source => source instanceof Flag) as Flag[]);
  }

  /** Apply `projection` to `sources`, what this target built (see
   * {@link InternalBuildContext.projectSources}). */
  public projectSources(sources: SourceRef[], projection: IProjection, miss: Miss | undefined): SourceRef[] | Computable<SourceRef[]> {
    return this.context.projectSources(sources, projection, miss) as SourceRef[] | Computable<SourceRef[]>;
  }

  /**
   * Apply the projections still pending on `sources`, for a rule that read a
   * requirement contained and wants the files it selects after all.
   */
  public applyProjections(sources: ReadonlyArray<FileSet | FileSetRef>): Computable<FileSet[]> {
    return this.context.applyProjections(sources).then(applied => applied.filter((source): source is FileSet => source instanceof FileSet));
  }

  /**
   * Get the requirement each of `sources` declares, for writing a manifest: what
   * the written reference states, not the version resolution selected (see
   * declaredRequirement). The result is parallel to `sources`, undefined where a
   * source declares nothing.
   */
  public collectDeclaredRequirements(sources: ReadonlyArray<SourceRef | Dependency>): Computable<(Requirement | undefined)[]> {
    return Computable.forAll(sources.map(declaredRequirement), (...requirements) => requirements);
  }

  /**
   * Build an anonymous target of `type` from `inputs` and return its output,
   * which must be one FileSet. The sub-target's rule reads `inputs` through the
   * same accessors as any target's (see {@link InternalBuildContext.buildSubTarget}).
   */
  public subTarget(
    type: string,
    inputs: SubTargetInputs,
    options?: { label?: string; constraints?: Constraints }
  ): Computable<FileSet> {
    return this.context.buildSubTarget(this, type, inputs, options).then(result => {
      if (result.length === 1 && result[0] instanceof FileSet) {
        return result[0];
      }
      throw new FabrError(`Anonymous target type '${type}' did not produce a single file content`);
    });
  }

  /**
   * Describe the sub-target `subTarget` would build (see
   * {@link RuleImplementation.describe}), or undefined if its rule describes
   * nothing.
   */
  public describeSubTarget(
    type: string,
    inputs: SubTargetInputs,
    options?: { label?: string; constraints?: Constraints }
  ): Computable<FileSet | undefined> {
    return this.context.describeSubTarget(this, type, inputs, options);
  }

  /**
   * Make a repository of `type`, a repository type any plugin in use defines,
   * that this repository's namespace holds as `member.name`: how a namespace
   * (an AWS account's `@aws:ecr`) offers another plugin's repository without
   * importing it. The repository is made as a declaration of its type would
   * be, its properties `member.properties`, and is given `member.url` and
   * `member.credential`. Named `<this>:<member>` in messages. Rejects where no
   * plugin in use defines `type`.
   */
  public makeRepository(type: string, member: IRepositoryMember): Computable<Repository> {
    return this.context.makeRepository(this, type, member);
  }

  /** @return true if a plugin in use (or core) defines the repository type `type`, otherwise false: whether {@link makeRepository} can make one. */
  public hasRepositoryType(type: string): boolean {
    return this.context.hasRepositoryType(type);
  }

  /** Perform `run` as one tracked task on behalf of this target — see
   *  {@link ExecutionContext.runTask}. */
  public runTask<T>(task: TaskDescription, run: (report: ITaskReport) => Computable<T>): Computable<T> {
    return this.context.execution.runTask(task, run);
  }

  public getGlobalString(name: string, overrides?: Constraints): Computable<string> {
    return this.getGlobalProperty(name, overrides).then(prop => prop.toString());
  }

  public getGlobalProperty(name: string, overrides?: Constraints): Computable<Property> {
    return this.context.getProperty(name, this.stack, overrides);
  }

  /** Get the constraint overrides for resolving a target to run it (see
   *  {@link InternalBuildContext.runOverrides}). */
  public runOverrides(extra?: Constraints): Constraints {
    return this.context.runOverrides(extra);
  }

  /**
   * Build this same target under `overrides`: how an operation-specific rule
   * gets its own target's result under another operation (the `files` rule
   * asking for `[build]`). The hop carries this target's
   * `stack`, so this target is named as the requester.
   */
  public buildSelfWithOverrides(overrides: Constraints): Computable<SourceRef[]> {
    return this.ownConfiguration.resolveTarget(this.declaredName, this.stack, overrides).then(materializeTargets);
  }

  /**
   * Resolve this same target under `overrides`, building nothing, for a rule's
   * `requirements` to name (`js_package[run]` stating its own `[build]`). It is
   * read as packages ({@link PackageSources}).
   */
  public resolveSelfWithOverrides(overrides: Constraints): Computable<PackageSources> {
    return this.ownConfiguration.resolveTarget(this.declaredName, this.stack, overrides).then(sources => new PackageSources(sources));
  }

  /**
   * Materialize a global that names a runnable tool (`TSC_DRIVER`) as its host
   * runnable, under {@link runOverrides}: the global counterpart of
   * {@link getRunnableProperty}.
   */
  public getGlobalRunnable(name: string): Computable<RunnableFileSet> {
    /* A tool is collected on its own, apart from the rule's requirements, so
     * its versions are not resolved together with what it builds. */
    return this.context
      .resolveTarget(name, this.stack, this.runOverrides())
      .then(sources => collectRunnable(this.context, this, sources, name));
  }

  /**
   * Materialize a FILES property that names a runnable tool (`serve`'s `tool`)
   * as its host runnable, under {@link runOverrides}. The caller launches it
   * with `toCommandLine`.
   */
  public getRunnableProperty(name: string): Computable<RunnableFileSet> {
    return this.getFileProperty(name, this.runOverrides()).then(sources => collectRunnable(this.context, this, sources, name));
  }

  /**
   * Read a global (build-config) FILES property's unmaterialized sources — the global
   * counterpart of {@link getFileProperty}, with any repository references still
   * inert, for a rule's `requirements` to name, so that they resolve
   * jointly with the target's other requirements. Overrides ride as callerOverrides (caller
   * precedence over a requirement on the global's value).
   */
  /** Get the global MAP property `name`'s value. Rejects where nothing declares `name`. */
  public getGlobalMap(name: string, overrides?: Constraints): Computable<PropertyMap> {
    return this.context.lookupGlobalMap(name, this.stack, overrides);
  }

  public getGlobalFileProperty(name: string, overrides?: Constraints): Computable<SourceRef[]> {
    return this.context.resolveTarget(name, this.stack, overrides);
  }

  /** Get `runnable` launched through the runnable the global `interpreter`
   *  names, given `interpreterArgs` before the entry. */
  public launchedBy(runnable: RunnableFileSet, interpreter: string, interpreterArgs?: readonly RunnableArgument[]): Computable<RunnableFileSet> {
    return this.getGlobalRunnable(interpreter).then(launcher => runnable.launchedBy(launcher, this.execution.buildCache, interpreterArgs));
  }
}

/**
 * A declared target's context: its properties are looked up from its
 * `ITargetDecl`, and every task beneath it is attributed to it.
 */
export class DeclaredTargetContext extends TargetContext {
  public readonly target: ITargetDecl;
  /** The body as spliced, collated by name; made when first read. */
  private body?: Computable<ITargetBody>;

  constructor(target: ITargetDecl, targetDef: ITargetDefDecl, context: InternalBuildContext, stack?: IDependencyStack) {
    super(context, targetDef, stack);
    this.target = target;
  }

  /**
   * Get the body as spliced: each splice's entries looked up, then the body
   * collated by name in written order, a later item of a name replacing what
   * came before it (see {@link collateBody}), and the entries spliced checked
   * against the targetdef.
   */
  private getBody(): Computable<ITargetBody> {
    if (this.body === undefined) {
      const splices = this.target.properties.filter((item): item is ISpliceDecl => !isPropertyDecl(item));
      this.body =
        splices.length === 0
          ? Computable.resolve(collateBody(this.target.properties, []))
          : Computable.forAll(
              splices.map(splice => this.context.lookupSplice(splice, this.stack)),
              (...supplied: ISplicedEntry[][]) => this.checkedBody(collateBody(this.target.properties, supplied))
            );
    }
    return this.body;
  }

  /**
   * Check the entries `body` holds from splices against the targetdef, as a
   * written property is checked: one the targetdef does not declare (and no
   * `*` entry admits) is left out, one it declares must have its type's
   * shape; then every required property must have a declaration.
   */
  private checkedBody(body: ITargetBody): ITargetBody {
    const wildcard = this.targetDef.properties.get("*");
    const spliced = new Map<string, ISplicedEntry>();
    for (const [name, entry] of body.spliced) {
      const schema = this.targetDef.properties.get(name) ?? wildcard;
      if (schema === undefined) {
        continue;
      }
      const problems: string[] = [];
      validatePropertyShape(entry.decl, schema.type, { log: (diagnostic, params) => problems.push(diagnostic.message(params)) });
      if (problems.length > 0) {
        throw new FabrError(`'${name}', spliced into ${this.target.type} target '${this.name}': ${problems.join("; ")}`);
      }
      spliced.set(name, entry);
    }
    for (const [name, schema] of this.targetDef.properties) {
      if (name !== "*" && schema.required && !body.written.has(name) && !spliced.has(name)) {
        throw new FabrError(`Missing required property '${name}' in ${this.target.type} target '${this.name}'`);
      }
    }
    return { written: body.written, spliced };
  }

  /**
   * Get the declarations of `name` that apply here, with the configuration
   * their values are looked up in: those in this target's body that this
   * configuration admits, else what a splice in the body supplies for it, else
   * the schema's declared default (see
   * {@link InternalBuildContext.getAvailableDecls}). Empty where none applies,
   * as for a property never written. Each accessor says what it makes of more
   * than one. The configuration judged includes the caller's `overrides`.
   */
  private availableFor(name: string, overrides?: Constraints): Computable<{ decls: IPropertyDecl[]; context: InternalBuildContext }> {
    return this.getBody().then(body =>
      this.context
        .getContextWithOverrides(overrides)
        .getAvailableDecls({ kind: DeclKind.Property, decls: body.written.get(name) ?? [], defaults: [] }, this.stack, this.target)
        .then(applicable => {
          const spliced = body.spliced.get(name);
          if (applicable.length > 0 || spliced === undefined) {
            const declared = this.declaredDefault(name);
            return { decls: applicable.length > 0 || declared === undefined ? applicable : [declared], context: this.context };
          }
          return { decls: [spliced.decl], context: spliced.context };
        })
    );
  }

  public getPropertyNames(): Computable<string[]> {
    return this.getBody().then(body =>
      withDefaults([...body.written.keys(), ...body.spliced.keys()].filter(name => name !== "*" && this.targetDef.properties.has(name)), this.targetDef)
    );
  }

  public get name(): string {
    return declName(this.target);
  }

  protected get declaredName(): string {
    return declName(this.target);
  }

  /**
   * The target's name within its chain of scopes, which tells its build apart
   * from every other: its own (`app`), and for a target a rule's block
   * declares, the matched target's then its name in the block (`app/report`).
   */
  public get scopedName(): string {
    return this.name;
  }

  /* Every accessor looks up on the ambient configuration and passes the
   * caller's overrides as callerOverrides, so they outrank a `<k=v>` written on
   * a value (ambient < requirement < caller). Guards are judged under the
   * overrides (see availableFor). */
  public getProperty(name: string, overrides?: Constraints): Computable<Property | undefined> {
    return this.availableFor(name, overrides).then(({ decls, context }) => {
      const prop = soleDecl(decls);
      return prop ? context.lookupStringProperty(prop, this.target, this.stack, overrides) : undefined;
    });
  }

  public getFileProperty(name: string, overrides?: Constraints): Computable<SourceRef[]> {
    return this.availableFor(name, overrides).then(({ decls, context }) => {
      const prop = mergedDecls(decls);
      return prop ? context.lookupFileProperty(prop, this.target, this.stack, overrides) : [];
    });
  }

  public getRewriteRules(name: string, overrides?: Constraints): Computable<Name[]> {
    return this.availableFor(name, overrides).then(({ decls, context }) => {
      const prop = mergedDecls(decls);
      return prop ? context.lookupNameProperty(prop, this.target, this.stack, overrides) : [];
    });
  }

  public getProjection(name: string, overrides?: Constraints): Computable<Name | undefined> {
    return this.availableFor(name, overrides).then(({ decls, context }) => {
      const prop = soleDecl(decls);
      return prop ? context.lookupProjection(prop, this.target, this.stack, overrides) : undefined;
    });
  }

  public getMap(name: string, overrides?: Constraints): Computable<PropertyMap> {
    return this.availableFor(name, overrides).then(({ decls, context }) => {
      const prop = soleDecl(decls);
      return prop ? context.lookupMap(prop, this.target, this.stack, overrides) : new Map();
    });
  }

  public getDeclaredContext(): DeclaredTargetContext {
    return this;
  }

  /**
   * Read the property `name` for a rule's block reading it as `<param>.name`,
   * in the configuration `reader` the block reads it in. Which declarations
   * apply is judged, and their values substituted, in this target's
   * configuration with `alias` (the `<k=v>` written on the read) applied; what
   * the values name is looked up in `reader` with `alias` applied, each value
   * sited where it was written. The framework's own: a rule reads its target's
   * properties through the readers.
   */
  public aliasedFiles(name: string, reader: Constraints, alias: Constraints | undefined, stack?: IDependencyStack): Computable<SourceRef[]> {
    return this.aliasedDecls(name, alias, stack).then(({ decls, context }) => {
      const at = context.inConfiguration(reader.with(alias));
      return Computable.forAll(
        decls.map(decl => at.lookupFileProperty(decl, this.target, stack)),
        (...lists: SourceRef[][]) => lists.flat()
      );
    });
  }

  /**
   * Get the one declaration of `name` a rule's block reads as `<param>.name`
   * where it chases a map or command property, as {@link aliasedFiles} judges
   * it, with the configuration its values are looked up in. `prop` is
   * undefined where no declaration applies.
   */
  public aliasedDecl(
    name: string,
    reader: Constraints,
    alias: Constraints | undefined,
    stack?: IDependencyStack
  ): Computable<{ prop?: IPropertyDecl; context: InternalBuildContext }> {
    return this.aliasedDecls(name, alias, stack).then(({ decls, context }) => ({ prop: soleDecl(decls), context: context.inConfiguration(reader.with(alias)) }));
  }

  /** Resolve this target in the configuration of `constraints`, as a reference to it written in a rule's block does. */
  public resolveIn(constraints: Constraints, stack?: IDependencyStack): Computable<SourceRef[]> {
    return this.ownConfiguration.inConfiguration(constraints).resolveTarget(this.declaredName, stack);
  }

  /** Get the configuration of `constraints` this target's names are looked up in. */
  public configurationOf(constraints: Constraints): InternalBuildContext {
    return this.context.inConfiguration(constraints);
  }

  /** Resolve this target where it is built, and @return it resolved. */
  public resolvedSelf(): Computable<ResolvedTarget> {
    const own = this.ownConfiguration;
    return own.resolveTarget(this.declaredName, this.stack).then(() => own.resolvedTarget(this.declaredName));
  }

  /** Get the declarations of `name` that apply under `alias`, their values substituted there, with the configuration they are looked up in. */
  private aliasedDecls(name: string, alias: Constraints | undefined, stack?: IDependencyStack): Computable<{ decls: IPropertyDecl[]; context: InternalBuildContext }> {
    return this.availableFor(name, alias).then(({ decls, context }) => {
      const at = context.getContextWithOverrides(alias);
      return Computable.forAll(
        decls.map(decl =>
          Computable.forAll(
            decl.values.map(value =>
              isNameValue(value) ? at.substituteName(value, stack).then((substituted): IValue => ({ ...value, value: substituted })) : Computable.resolve(value)
            ),
            (...values: IValue[]): IPropertyDecl => ({ ...decl, values })
          )
        ),
        (...substituted: IPropertyDecl[]) => ({ decls: substituted, context })
      );
    });
  }

  public getWildcardProperties(overrides?: Constraints): Computable<{ key: Name; decl: IPropertyDecl }[]> {
    /* EVERY property the targetdef does not explicitly declare is a member —
     * a reference-shaped name and a bare identifier (`lodash = @npm;`) alike,
     * each read back as the member's substituted `key`. The schema's `*` entry
     * is the wildcard TYPE declaration, not a property named `*`, so a literal
     * `*` member (a group's catch-all route) is a member like any other. */
    const member = (key: string): boolean => key === "*" || !this.targetDef.properties.has(key);
    return this.getBody().then(body =>
      Computable.forAll(
        [
          this.context.lookupWildcardProperties([...body.written].filter(([key]) => member(key)).flatMap(([, decls]) => decls), this.stack, overrides),
          ...[...body.spliced]
            .filter(([key]) => member(key))
            .map(([, entry]) => entry.context.lookupWildcardProperties([entry.decl], this.stack, overrides)),
        ],
        (...lists: { key: Name; decl: IPropertyDecl }[][]) => lists.flat()
      )
    );
  }

  protected getCommandStages(name: string): Computable<ICommandStageLookup[]> {
    return this.availableFor(name).then(({ decls, context }) => {
      const prop = soleDecl(decls);
      return prop ? context.lookupCommand(prop, this.target, this.stack) : [];
    });
  }

  public stampProvenance(result: FileSet): FileSet {
    const step: ITargetOrigin = { kind: TARGET_PROVENANCE, decl: this.target, parent: result.origin };
    return result.withOrigin(step);
  }

  public failure(err: Error): DependencyFailedError {
    return new DependencyFailedError(this.target, err);
  }

  public taskDescription(): ITargetBuildTask {
    return {
      kind: "target-build",
      target: this.target,
      constraints: this.context.getConstraints(),
      requiredBy: requestingTargets(this.target, this.stack),
    };
  }
}

/**
 * An anonymous target's context. It has no declaration: its properties are
 * the inputs its creator supplied, already content where they are files. It
 * carries the declared owner it was built for and an optional action-verb
 * `label` ("Compiling"). Its failures are attributed to the owner with that
 * label, the owner's stamp covers its provenance, and its tasks are described
 * as the owner's, with the label where it has one. A sub-target without a
 * label is the owner's own work, and reports as such.
 */
export class AnonymousTargetContext extends TargetContext {
  private readonly inputs: SubTargetInputs;
  private readonly declared: DeclaredTargetContext;
  private readonly label: string | undefined;
  /** The context of the target whose rule made this one. */
  public readonly creator?: TargetContext;

  constructor(
    context: InternalBuildContext,
    targetDef: ITargetDefDecl,
    inputs: SubTargetInputs,
    declared: DeclaredTargetContext,
    label: string | undefined,
    stack?: IDependencyStack,
    creator?: TargetContext
  ) {
    super(context, targetDef, stack);
    this.inputs = inputs;
    this.declared = declared;
    this.label = label;
    this.creator = creator;
    this.given = new Set(
      Object.values(inputs)
        .flatMap((value): unknown[] => (Array.isArray(value) ? value : [value]))
        .filter((value): value is PackageFileSet => value instanceof PackageFileSet)
    );
  }

  /** The packages among the inputs: bound by the creating rule's collection
   * point, so a collection here takes them as they stand. */
  public readonly given: ReadonlySet<PackageFileSet>;

  public get name(): string {
    return this.declared.name;
  }

  public getPropertyNames(): Computable<string[]> {
    return Computable.resolve(withDefaults(Object.keys(this.inputs), this.targetDef));
  }

  /** Get no wildcard properties: an anonymous sub-target has no declaration body. */
  public getWildcardProperties(): Computable<{ key: Name; decl: IPropertyDecl }[]> {
    return Computable.resolve([]);
  }

  /* Every accessor takes the creator's input where present, else the type's
   * declared default. A default is looked up with no target declaration: it
   * was written in the targetdef. */

  /** Get a sub-target's command input: the {@link CommandValue} the caller
   * supplies, else the type's declared default. */
  protected getCommandStages(name: string): Computable<ICommandStageLookup[]> {
    const value = this.inputs[name];
    if (value === undefined) {
      const decl = this.declaredDefault(name);
      return decl ? this.context.lookupCommand(decl, undefined, this.stack) : Computable.resolve([]);
    }
    return Computable.resolve(value instanceof CommandValue ? [...value.stages] : []);
  }

  public getProperty(name: string, overrides?: Constraints): Computable<Property | undefined> {
    const value = this.inputs[name];
    if (value === undefined) {
      const decl = this.declaredDefault(name);
      return decl ? this.context.lookupStringProperty(decl, undefined, this.stack, overrides) : Computable.resolve(undefined);
    }
    return Computable.resolve(new Property((Array.isArray(value) ? value : [value]) as string[]));
  }

  public getFileProperty(name: string, overrides?: Constraints): Computable<SourceRef[]> {
    const value = this.inputs[name];
    if (value === undefined) {
      const decl = this.declaredDefault(name);
      return decl ? this.context.lookupFileProperty(decl, undefined, this.stack, overrides) : Computable.resolve([]);
    }
    return Computable.resolve((Array.isArray(value) ? value : [value]) as SourceRef[]);
  }

  /**
   * Get a sub-target's rewrite input: the substituted `Name`s its creator
   * supplies (each a `sel -> tmpl` rename or a bare constant), else the type's
   * declared default.
   */
  public getRewriteRules(name: string, overrides?: Constraints): Computable<Name[]> {
    const value = this.inputs[name];
    if (value === undefined) {
      const decl = this.declaredDefault(name);
      return decl ? this.context.lookupNameProperty(decl, undefined, this.stack, overrides) : Computable.resolve([]);
    }
    return Computable.resolve(value instanceof Name ? [value] : (value as Name[]));
  }

  /** Get a sub-target's projection input, if the caller supplied a Name in the bag
   * (a bare selector or a `-> tmpl` rename), else the type's declared default.
   * A bag entry that is not a Name declares none — and takes no default, having
   * been supplied. */
  public getProjection(name: string, overrides?: Constraints): Computable<Name | undefined> {
    const value = this.inputs[name];
    if (value === undefined) {
      const decl = this.declaredDefault(name);
      return decl ? this.context.lookupProjection(decl, undefined, this.stack, overrides) : Computable.resolve(undefined);
    }
    return Computable.resolve(value instanceof Name ? value : undefined);
  }

  /** Get a sub-target's map input: the resolved map the caller supplies — entry
   * origins and all, when it is one a declared target read — else the type's
   * declared default. */
  public getMap(name: string, overrides?: Constraints): Computable<PropertyMap> {
    const value = this.inputs[name];
    if (value === undefined) {
      const decl = this.declaredDefault(name);
      return decl ? this.context.lookupMap(decl, undefined, this.stack, overrides) : Computable.resolve(new Map());
    }
    return Computable.resolve(value instanceof Map ? value : new Map());
  }

  public getDeclaredContext(): DeclaredTargetContext {
    return this.declared;
  }

  public stampProvenance(result: FileSet): FileSet {
    /* No own provenance step: the declared owner stamps the composed result. */
    return result;
  }

  public failure(err: Error): DependencyFailedError {
    return new DependencyFailedError(this.declared.target, err, this.label, this.taskDescription().subtargetNames);
  }

  /**
   * Describe an action as the owner's, under this sub-target's own constraints,
   * with its action-verb `label` ("Compiling X"). Without a label it reads as
   * the owner's own work ("Testing X").
   */
  public taskDescription(): ITargetBuildTask {
    return {
      /* Its creator's, which names the target of a rule's block it is made for. */
      ...(this.creator ?? this.declared).taskDescription(),
      /* This evaluation's own constraints (operation included), which may
       * differ from the owner's (a test compile forced to `build`). */
      constraints: this.context.getConstraints(),
      label: this.label,
    };
  }
}

/**
 * The context of a target a rule's block declares (`rule js_package pkg<…> =
 * lint { generate lint { … } }`). It reads its properties from its
 * declaration, in a configuration of the block, where the block's own names
 * and the rule's parameter are looked up first. To the rest of the framework it
 * is a sub-target of the target the rule matched: named as that target is,
 * owned by its declared target, and labelled by the name the block gives it.
 */
export class ScopedTargetContext extends DeclaredTargetContext {
  constructor(
    target: ITargetDecl,
    targetDef: ITargetDefDecl,
    context: InternalBuildContext,
    stack: IDependencyStack | undefined,
    /** The application of the rule whose block declares the target: the rule, the target it matched, and what it keeps per target of the block. */
    public readonly scope: {
      readonly rule: RuleBlockDefinition;
      readonly matched: TargetContext;
      /** Get the state `rule` keeps for the block's target `name` in the configuration of `constraints`, however looked up there. */
      ruleState<T>(name: string, constraints: Constraints, rule: object, make: () => T): T;
      /** Resolve the block's target `name` where it is built in the configuration of `constraints`, and @return it resolved. */
      resolvedTarget(name: string, constraints: Constraints, stack?: IDependencyStack): Computable<ResolvedTarget>;
    }
  ) {
    super(target, targetDef, context, stack);
  }

  public ruleState<T>(rule: object, make: () => T): T {
    return this.scope.ruleState(this.declaredName, this.context.getConstraints(), rule, make);
  }

  public resolvedSelf(): Computable<ResolvedTarget> {
    return this.scope.resolvedTarget(this.declaredName, this.context.getConstraints(), this.stack);
  }

  /** The matched target's name: what the target's rule builds is that target's. */
  public get name(): string {
    return this.scope.matched.name;
  }

  /** The name the block declares the target under, which it is labelled by. */
  public get label(): string {
    return this.declaredName;
  }

  public getDeclaredContext(): DeclaredTargetContext {
    return this.scope.matched.getDeclaredContext();
  }

  public get scopedName(): string {
    const { matched } = this.scope;
    const owner = matched instanceof DeclaredTargetContext ? matched.scopedName : `${matched.name}/${matched.taskDescription().label ?? ""}`;
    return `${owner}/${this.label}`;
  }

  public stampProvenance(result: FileSet): FileSet {
    /* No own provenance step: the declared owner stamps the composed result. */
    return result;
  }

  public failure(err: Error): DependencyFailedError {
    return new DependencyFailedError(this.getDeclaredContext().target, err, undefined, this.taskDescription().subtargetNames);
  }

  public taskDescription(): ITargetBuildTask {
    /* Described as the target it is built for, with its own name: its verb is
     * its operation's, as any target's is. */
    const { kind, target, requiredBy, subtargetNames } = this.scope.matched.taskDescription();
    return { kind, target, requiredBy, constraints: this.context.getConstraints(), subtargetNames: [this.label, ...(subtargetNames ?? [])] };
  }
}

/**
 * List the rules written in `.fabr` that `context` is inside the application
 * of: the rule whose block declares it, the one whose block declares the
 * target that rule matched, and so on, through the targets rules' code made,
 * up to a declared target.
 */
export function enclosingRules(context: TargetContext): RuleBlockDefinition[] {
  const rules: RuleBlockDefinition[] = [];
  for (let at: TargetContext | undefined = context; at !== undefined; ) {
    if (at instanceof ScopedTargetContext) {
      rules.push(at.scope.rule);
      at = at.scope.matched;
    } else if (at instanceof AnonymousTargetContext) {
      at = at.creator;
    } else {
      at = undefined;
    }
  }
  return rules;
}

/** The context of a repository a namespace holds as a member (see {@link TargetContext.makeRepository}): an anonymous target's, named under the namespace. */
export class MemberTargetContext extends AnonymousTargetContext {
  constructor(
    context: InternalBuildContext,
    targetDef: ITargetDefDecl,
    inputs: SubTargetInputs,
    declared: DeclaredTargetContext,
    private readonly member: string,
    stack?: IDependencyStack,
    creator?: TargetContext
  ) {
    super(context, targetDef, inputs, declared, undefined, stack, creator);
  }

  public override get name(): string {
    return `${super.name}:${this.member}`;
  }
}

/**
 * Vend the publish ref `rest`, written after `separator`, names in the
 * repository among `sources`, written `written`; through the member of a
 * namespace among them its first part names, once made. `name` is the whole
 * coordinate, for messages.
 */
function publishRefIn(
  sources: SourceRef[],
  rest: Name,
  separator: ":" | "/",
  written: string,
  name: Name
): RepositoryPublishRef | Computable<RepositoryPublishRef> {
  const repository = sources.find((source): source is PartialRepositoryRef => source instanceof PartialRepositoryRef);
  if (repository !== undefined) {
    return repository.getRepositoryPublishRef(rest, separator, written);
  }
  const namespace = sources.find((source): source is NamespaceRef => source instanceof NamespaceRef);
  if (namespace === undefined) {
    throw new FabrError(`'${name.toString()}' does not name a repository`);
  }
  const literal = rest.getLiteralPrefix();
  const end = literal.search(/[:/]/);
  if (end <= 0) {
    throw new FabrError(`'${name.toString()}' names a namespace, not an address in a repository to publish to`);
  }
  const first = literal.substring(0, end);
  const next = literal[end] as ":" | "/";
  return namespace
    .get(first, separator)
    .then(member => publishRefIn([member], rest.substring(end + 1), next, `${namespace.name}${separator}${first}`, name));
}

/** @return `names`, with those of the properties `targetDef` gives a default added. */
function withDefaults(names: string[], targetDef: ITargetDefDecl): string[] {
  return [...new Set([...names, ...[...targetDef.properties].filter(([, schema]) => schema.default !== undefined).map(([name]) => name)])];
}

/** A target's body as spliced, by property name. */
interface ITargetBody {
  /** The declarations written after the last item supplying the name, guards and all. */
  readonly written: ReadonlyMap<string, IPropertyDecl[]>;
  /** The entry the last splice supplying the name supplied, where nothing is written after it. */
  readonly spliced: ReadonlyMap<string, ISplicedEntry>;
}

/**
 * Collate `items`, a target's body, by property name in written order, the
 * splices among it having supplied `supplied` (one list for each, in order): a
 * declaration is added to its name's, and a splice's entry replaces whatever
 * came before it of its name.
 */
function collateBody(items: IMapItemDecl[], supplied: ISplicedEntry[][]): ITargetBody {
  const written = new Map<string, IPropertyDecl[]>();
  const spliced = new Map<string, ISplicedEntry>();
  let next = 0;
  for (const item of items) {
    if (isPropertyDecl(item)) {
      const name = item.name.toBaseString();
      written.set(name, [...(written.get(name) ?? []), item]);
      continue;
    }
    for (const entry of supplied[next++]) {
      const name = entry.decl.name.toBaseString();
      written.delete(name);
      spliced.set(name, entry);
    }
  }
  return { written, spliced };
}
