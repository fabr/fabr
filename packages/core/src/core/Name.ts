/*
 * Copyright (c) 2022 Nathan Keynes <nkeynes@deadcoderemoval.net>
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

import * as path from "path";
import { GLOB_METACHAR, globCaptureRegex, globMatcher, globPrefixRegex, isGlob } from "../support/Glob";
import { PatternEdit, renderPatternEdit } from "../support/PatternEdit";
import type { CommandPipeline } from "../model/AST";
import { FabrError } from "./Errors";

/** The kind of a {@link NamePart}. */
export enum NamePartKind {
  /** Text taken as written. */
  Literal,
  /** A run of glob metacharacters. */
  Glob,
  /** A `${NAME}` variable substitution. */
  VarSubst,
  /**
   * A `$1`-style back-reference to a numbered wildcard, in a rename template.
   */
  Backref,
  /**
   * A backtick `` `cmd args` `` command substitution: the part's text is the
   * command's normalized stdout.
   */
  CommandSubst,
}

/** @return true if a part's text is supplied from outside the name, by a
 * variable to look up or a command to run, otherwise false. */
function isSubstituted(part: NamePart): boolean {
  return part.kind === NamePartKind.VarSubst || part.kind === NamePartKind.CommandSubst;
}

/** One part of a {@link Name}. */
export interface NamePart {
  kind: NamePartKind;
  /** The written form: a literal's text, a variable's name, a back-reference's
   * digits — and, for a command substitution, its source text */
  value: string;
  /**
   * A command substitution's parsed pipeline — attached by the parser and read
   * back by the model to resolve the part.
   */
  command?: CommandPipeline;
  /**
   * A variable substitution's `<k=v>` requirement (`${FOO<K=V>}`): the
   * configuration the variable is read under. Its values may substitute in
   * turn, which the resolver does before reading the variable.
   */
  constraints?: readonly NameConstraint[];
  /**
   * A variable substitution's edit of the value it reads (`${FOO%%-*}`,
   * `${FOO/a/b}`), applied to the value's text as a whole.
   */
  edit?: PatternEdit;
}

/** The separator between a name's path components: `/`, on every platform. */
export const NAME_COMPONENT_SEPARATOR = "/";
/** The separator between an alias and what is named within it: `:`. */
export const NAME_LEVEL_SEPARATOR = ":";

/** Either separator, for splitting into path components: on disk, a `:` is a
 * path separator too (see makeProjector). */
const SEPARATOR = /[/:]/;

/**
 * Normalize the literal head of a slash-form selector, up to the last `/`
 * before its first glob metacharacter: resolve `.` and `..`, and collapse runs
 * of `/`. The names matched against arrive normalized, so an unnormalized head
 * (`docs/../scripts/*.ts`) would match nothing. A `..` left at the front
 * (above the root) or after a glob stays as written, and matches nothing.
 */
function normalizeHead(pathForm: string): string {
  /* Stop before the first glob metacharacter: `normalize` would fold a `..`
   * through a `*` segment, changing what it names. */
  const meta = pathForm.search(GLOB_METACHAR);
  const cut = meta === -1 ? pathForm.length : pathForm.lastIndexOf(NAME_COMPONENT_SEPARATOR, meta) + 1;
  if (cut === 0) {
    return pathForm;
  }
  const head = path.posix.normalize(pathForm.substring(0, cut));
  return (head === "." || head === "./" ? "" : head) + pathForm.substring(cut);
}

/**
 * One constraint written in a `<KEY=value>` facet: a scalar configuration key
 * and its value, a Name (which may carry a `${subst}`). On a reference it is a
 * requirement; on a declaration's key, a guard.
 */
export type NameConstraint = readonly [key: string, value: Name];

/**
 * A written name: its parts (literal text, glob runs, substitutions and
 * back-references), and two facets kept apart from the parts, the `<k=v>`
 * constraints and the `-> tmpl` rename target. A name is immutable.
 */
export class Name {
  private parts: NamePart[];
  /**
   * The constraints written on the name (`ref<KEY=value, ...>`), in written
   * order, or empty: on a reference, the configuration it requires; on a
   * declaration's key, the configuration that guards it. `toString` renders
   * them as written.
   */
  private readonly constraints: readonly NameConstraint[];
  /**
   * The rename target written on the name (the `tmpl` of `sel -> tmpl`), or
   * undefined. Its parts are literal text, substitutions, `*`/`**` slots and
   * `$n` back-references, and the selector's captures fill them to rename
   * what it selects ({@link makeRenamer}). The parser gives it no rename
   * target or constraints of its own.
   */
  private readonly renameTo: Name | undefined;
  /**
   * True where the name's last character is a `?` or `!` written unquoted at
   * the end of a reference, the one place an override marker can be written.
   * The character stays in `parts`, so the name reads as written; whoever
   * looks the name up decides whether to read it as a marker
   * ({@link getMarker}).
   */
  private readonly marked: boolean;

  constructor(parts: NamePart[], constraints: readonly NameConstraint[] = [], renameTo?: Name, marked = false) {
    if (parts.length === 0) {
      this.parts = [{ kind: NamePartKind.Literal, value: "" }];
    } else {
      this.parts = parts;
    }
    this.constraints = constraints;
    this.renameTo = renameTo;
    this.marked = marked;
  }

  /** @return a copy of this name recording that it ends in an override marker
   * written unquoted (see {@link getMarker}). */
  public withMarker(): Name {
    return new Name(this.parts, this.constraints, this.renameTo, true);
  }

  /** @return the override marker this name ends in, where one was written
   * unquoted at the end of a reference: `?` an alternate, `!` a force. */
  public getMarker(): "alternate" | "force" | undefined {
    if (!this.marked) {
      return undefined;
    }
    const written = this.renderParts(false);
    return written.endsWith("?") ? "alternate" : written.endsWith("!") ? "force" : undefined;
  }

  /** @return this name without the override marker it ends in (unchanged where
   * it has none). */
  public withoutMarker(): Name {
    if (this.getMarker() === undefined) {
      return this;
    }
    const parts = this.parts.slice(0, -1);
    const last = this.parts[this.parts.length - 1];
    const rest = last.value.slice(0, -1);
    return new Name(rest === "" ? parts : [...parts, { ...last, value: rest }], this.constraints, this.renameTo);
  }

  /** Make a name of one literal part, `str`. */
  static fromLiteral(str: string): Name {
    return new Name([{ kind: NamePartKind.Literal, value: str }]);
  }

  /**
   * @return a copy of this name carrying `constraints` in place of its own.
   */
  public withConstraints(constraints: readonly NameConstraint[]): Name {
    return new Name(this.parts, constraints, this.renameTo, this.marked);
  }

  /** @return the constraints written on this name — what a reference *requires*
   * of its referent's configuration, or what *guards* a declaration (empty if
   * none; position is what decides which). */
  public getConstraints(): readonly NameConstraint[] {
    return this.constraints;
  }

  /**
   * @return a copy of this name carrying `renameTo` in place of its own rename
   * target (`undefined` clears it).
   */
  public withRenameTo(renameTo: Name | undefined): Name {
    return new Name(this.parts, this.constraints, renameTo, this.marked);
  }

  /** @return the rename target written on this reference (undefined if none). */
  public getRenameTo(): Name | undefined {
    return this.renameTo;
  }

  /**
   * Get the glob parts of this name in written order, each a maximal run of
   * glob metacharacters (`*`, `**`, `?`, `[...]`). The parser checks a rename
   * with them: its selector and template may use only `*` and `**`, and a
   * template that replays positionally must have as many as its selector. A
   * wildcard-free template is exempt from both rules, and a `$n` template from
   * the count.
   */
  public getGlobUnits(): string[] {
    return this.parts.filter(part => part.kind === NamePartKind.Glob).map(part => part.value);
  }

  /**
   * Render this rename template as a `String.replace` replacement string: each
   * `*`/`**` becomes the next capture reference (`$1`, `$2`, …), a `$n`
   * back-reference stays `$n`, and literal text is copied with `$` escaped.
   * Pairs with the selector's {@link globCaptureRegex} (see
   * {@link makeRenamer}). Call it after substitution.
   */
  public toReplacement(): string {
    let slot = 0;
    return this.parts
      .map(part => {
        switch (part.kind) {
          case NamePartKind.Glob:
            /* A bare wildcard takes the next capture in order. */
            return `$${++slot}`;
          case NamePartKind.Backref:
            return `$${part.value}`;
          default:
            /* Double a literal `$` so `replace` reads it as text. Return `"$$"`
             * from a function: given as a string, `"$$"` is itself read as one
             * `$`. */
            return part.value.replaceAll("$", () => "$$");
        }
      })
      .join("");
  }

  /**
   * Read this name as a rename template: each substitution of a number (`$1`)
   * becomes a back-reference to that wildcard ({@link NamePartKind.Backref})
   * instead of a variable read. Elsewhere, `$1` reads a property named `1`.
   */
  public asRenameTemplate(): Name {
    if (!this.parts.some(part => part.kind === NamePartKind.VarSubst && /^[0-9]+$/.test(part.value))) {
      return this;
    }
    const parts = this.parts.map(part =>
      part.kind === NamePartKind.VarSubst && /^[0-9]+$/.test(part.value) ? { kind: NamePartKind.Backref, value: part.value } : part
    );
    return new Name(parts, this.constraints, this.renameTo);
  }

  /** Get the wildcard indices this template back-references (`$1` → 1), in written
   * order; empty for a template that replays positionally or not at all. */
  public getBackrefIndices(): number[] {
    return this.parts.filter(part => part.kind === NamePartKind.Backref).map(part => Number(part.value));
  }

  /**
   * Compile this name as a selector, renamed by `renameTo`, into a rule a
   * consumer can run with only `RegExp` and `String.replace`: a regular
   * expression source and its `$n` replacement ({@link makeRenamer} applies
   * it). `excludes`, where present, is an input the pattern matches that must
   * not be renamed: the selector's own alias path, which a trailing `**`
   * matches. A consumer that cannot honour `excludes` must refuse the rule.
   */
  public toRenameRule(renameTo: Name): { pattern: string; replacement: string; excludes?: string } {
    const selector = this.renderParts(true);
    /* Unescaped, like the projector's: it is compared against real paths. */
    const aliasPath = this.aliasAsPath(false);
    return {
      pattern: globCaptureRegex(normalizeHead(selector.replaceAll(NAME_LEVEL_SEPARATOR, NAME_COMPONENT_SEPARATOR))).source,
      replacement: renameTo.toReplacement(),
      ...(aliasPath !== undefined && !isGlob(aliasPath) ? { excludes: aliasPath } : {}),
    };
  }

  /**
   * Make a renamer with this name as the selector and `renameTo` as the
   * template: a function from a path to its renamed form, or undefined where
   * the selector does not select it. The selector's `*`/`**` captures fill the
   * template's slots, in order or as its `$n` say. The selector is this name's
   * parts, matched as a path (every `:` read as `/`, the literal head
   * normalized; see {@link makeProjector}); its alias path itself is not
   * selected. A template with no wildcard renames every match to one name,
   * which {@link FileSet.rename} reports as a conflict where two different
   * files are selected. Call it after substitution.
   */
  public makeRenamer(renameTo: Name): (path: string) => string | undefined {
    /* Every `:` is read as `/`, so a colon-form selector matches slash paths;
     * the alias segments are matched, and only the template names the result
     * (`d:sub:*.x -> *.y`). */
    const { pattern, replacement, excludes } = this.toRenameRule(renameTo);
    const re = new RegExp(pattern);
    /* `x:** -> tmpl` renames the files under x, never x: a globstar matches its
     * own base, which would otherwise come out under the template with an
     * empty capture. */
    /* An unmatched globstar group substitutes as "", which can leave a doubled
     * or edge slash; collapse runs of `/` and trim the ends, so a recursive
     * rename keeps the tree's shape at every depth, the root included. */
    return (input: string) => {
      if (!re.test(input) || (excludes !== undefined && path.posix.relative(excludes, input) === "")) {
        return undefined;
      }
      return input
        .replace(re, replacement)
        .replace(/\/{2,}/g, "/")
        .replace(/^\/+|\/+$/g, "");
    };
  }

  /**
   * Make the projection this name denotes: a function from an input path to
   * its result name, or undefined where the input is not selected. With a
   * rename target it is the rename ({@link makeRenamer}). Otherwise it selects
   * by glob, every `:` read as a path separator, and names each match
   * `prefix` followed by:
   * - for a name with a `:`, its path relative to the alias, everything before
   *   the last `:` (`src:**` selects `src/a.ts` as `a.ts`); the alias path
   *   itself is not selected;
   * - for a name without one, its whole path.
   *
   * Inputs arrive normalized, so the selector's literal head is normalized
   * before it is compiled ({@link normalizeHead}). Call it after substitution.
   */
  public makeProjector(prefix = ""): (input: string) => string | undefined {
    if (this.renameTo) {
      return this.makeRenamer(this.renameTo);
    }
    const selector = this.toGlobString();
    const matcher = globMatcher(normalizeHead(selector.replaceAll(NAME_LEVEL_SEPARATOR, NAME_COMPONENT_SEPARATOR)));
    /* Compare the alias path with input paths unescaped: a literal alias
     * containing `(`/`)`/`!`/`|` renders escaped for the matcher. Only the
     * glob-alias arm, which compiles a pattern, wants the escaped form. */
    const aliasPath = this.aliasAsPath(false);
    if (aliasPath === undefined) {
      return input => (matcher(input) ? prefix + input : undefined);
    }
    if (!isGlob(aliasPath)) {
      /* Literal alias: name each result relative to the alias directory. A
       * remainder climbing out of the alias (`lib:../tools/*.js`) is named by
       * its climbed path (`../tools/y.js`), which FileSet name canonicalization
       * flattens to its tail. Leave out the alias path itself (relative name
       * ""): a globstar remainder matches its own base (`a/**` matches `a`),
       * but `x:**` means the files under x, so a projection into an archive
       * does not also select the archive. */
      return input => {
        if (!matcher(input)) {
          return undefined;
        }
        const rel = path.posix.relative(aliasPath, input);
        return rel === "" ? undefined : prefix + rel;
      };
    }
    /* Glob alias (`pkg*:lib/*`): there is no directory to name relative to, so
     * strip the matched alias as text. A remainder climbing out of a glob alias
     * never matches (its `..` stays in the pattern). */
    const strip = globPrefixRegex(this.aliasAsPath(true)! + NAME_COMPONENT_SEPARATOR);
    return input => (matcher(input) ? prefix + input.replace(strip, "") : undefined);
  }

  /**
   * Get the alias (everything before the last `:`) as a slash path, or
   * undefined for a name with no `:`. With `escape`, its literal parts are
   * escaped, for a pattern compiler ({@link globPrefixRegex}); without, it is
   * the path itself, for comparing with input paths.
   */
  private aliasAsPath(escape: boolean): string | undefined {
    const rendered = this.renderParts(escape);
    const alias = rendered.lastIndexOf(NAME_LEVEL_SEPARATOR);
    return alias === -1 ? undefined : rendered.substring(0, alias).replaceAll(NAME_LEVEL_SEPARATOR, NAME_COMPONENT_SEPARATOR);
  }

  /**
   * @return a copy naming everything at or below this path: a `**` appended,
   * after a `/` unless the name already ends in `/` or `:` (`src` gives
   * `src/**`, `src:` gives `src:**`). For a bare directory reference, so the
   * {@link makeProjector} rules then apply. The copy carries no constraints or
   * rename target.
   */
  public appendGlobstar(): Name {
    /* Test the parts' last character, not a rendering with facets: `enumerate`
     * calls this while the name still carries its `-> tmpl`, and
     * `stuff -> out/` ends in the template's `/`. */
    const written = this.renderParts(false);
    const last = written.charAt(written.length - 1);
    const sep = last === NAME_COMPONENT_SEPARATOR || last === NAME_LEVEL_SEPARATOR ? "" : NAME_COMPONENT_SEPARATOR;
    const tail: NamePart[] = sep
      ? [
          { kind: NamePartKind.Literal, value: sep },
          { kind: NamePartKind.Glob, value: "**" },
        ]
      : [{ kind: NamePartKind.Glob, value: "**" }];
    return this.concat(new Name(tail));
  }

  /**
   * Split the name's parts into path components, at every `/` and `:`, each
   * component a Name of its own parts (globs and unsubstituted `${var}`s
   * kept). The components carry no facets.
   */
  public components(): Name[] {
    const result: Name[] = [];
    let current: NamePart[] = [];
    for (const part of this.parts) {
      if (part.kind !== NamePartKind.Literal) {
        current.push({ ...part });
        continue;
      }
      /* Each separator inside a literal ends the component in progress; the
       * pieces between them are the literal text of their components. */
      part.value.split(SEPARATOR).forEach((text, index) => {
        if (index > 0) {
          result.push(new Name(current));
          current = [];
        }
        if (text !== "") {
          current.push({ kind: NamePartKind.Literal, value: text });
        }
      });
    }
    result.push(new Name(current));
    return result;
  }

  /**
   * Get the leading paths of this name at each depth: `prefixes[i]` is
   * {@link components} 0…i joined with `/`, without facets. Archive descent
   * matches them to find an archive the name enters; a fetch repository, to
   * select its members.
   */
  public componentPrefixes(): Name[] {
    const prefixes: Name[] = [];
    for (const component of this.components()) {
      const prior = prefixes.at(-1);
      prefixes.push(prior ? prior.concat(SLASH).concat(component) : component);
    }
    return prefixes;
  }

  /**
   * @return this name with `other` appended, adjacent parts of one kind merged
   * (bar variable substitutions), so a literal base and a literal tail make one
   * literal head. Used to rejoin a reference split by a `<...>` (`pkg` +
   * `:build/*.js`). The result carries no constraints or rename target (the
   * caller attaches them), and `other`'s override marker, since it ends the
   * name.
   */
  public concat(other: Name): Name {
    const merged: NamePart[] = [];
    for (const part of [...this.parts, ...other.parts]) {
      const last = merged[merged.length - 1];
      if (last && last.kind === part.kind && part.kind !== NamePartKind.VarSubst) {
        last.value += part.value;
      } else {
        merged.push({ ...part });
      }
    }
    return new Name(merged, [], undefined, other.marked);
  }

  public hasConstraints(): boolean {
    return this.constraints.length > 0;
  }

  /** @return true if the name is one literal part, otherwise false. */
  public isSimpleName(): boolean {
    return this.parts.length === 1 && this.parts[0].kind === NamePartKind.Literal;
  }

  /** @return true if the name is the empty literal, otherwise false. */
  public isEmpty(): boolean {
    return this.parts.length === 1 && this.parts[0].value === "";
  }

  /**
   * @return the literal string if this consists _only_ of literal parts, otherwise undefined.
   */
  public getSimpleName(): string | undefined {
    return this.isSimpleName() ? this.parts[0].value : undefined;
  }

  public hasGlob(): boolean {
    return this.parts.some(part => part.kind === NamePartKind.Glob);
  }

  /** @return true if any literal part contains a `:`, otherwise false. The
   * parser refuses one in a rename template, and Validate in a REWRITE
   * selector, both matched against file names rather than references. */
  public hasLevelSeparator(): boolean {
    return this.parts.some(part => part.kind === NamePartKind.Literal && part.value.includes(NAME_LEVEL_SEPARATOR));
  }

  public hasVarSubst(): boolean {
    return this.parts.some(part => part.kind === NamePartKind.VarSubst);
  }

  /**
   * Get every part of this name whose text comes from outside it, variables and
   * command substitutions alike, including those in its constraint values and
   * rename target. The caller resolves each (a property lookup, a command run)
   * and hands the results to {@link substitute}, keyed by part.
   */
  public getSubstitutions(): NamePart[] {
    const own = this.parts.filter(isSubstituted);
    /* Constraint values may substitute too (`<K=${X}>`). */
    const withConstraints = this.constraints.reduce<NamePart[]>((parts, [, value]) => parts.concat(value.getSubstitutions()), own);
    /* The rename target may substitute too (`-> *.${BUILD_NO}.js`). */
    return this.renameTo ? withConstraints.concat(this.renameTo.getSubstitutions()) : withConstraints;
  }

  /**
   * Replace every substituted part, in the parts, the constraint values and
   * the rename target, with its resolved text as a literal. `resolved` is
   * keyed by the part objects {@link getSubstitutions} returned, so a variable
   * `X` and a command written `X` are different keys.
   */
  public substitute(resolved: ReadonlyMap<NamePart, string>): Name {
    /* Merge adjacent literals only: two adjacent back-references (`$1$2`)
     * merged would read as `$12`. */
    const parts = this.parts.reduce<NamePart[]>((rest, part) => {
      const newPart = isSubstituted(part) ? { kind: NamePartKind.Literal, value: resolved.get(part)! } : part;
      if (rest.length > 0 && newPart.kind === NamePartKind.Literal && rest[rest.length - 1].kind === NamePartKind.Literal) {
        rest[rest.length - 1] = { kind: NamePartKind.Literal, value: rest[rest.length - 1].value + newPart.value };
      } else {
        rest.push(newPart);
      }
      return rest;
    }, []);

    const constraints = this.constraints.map<NameConstraint>(([key, value]) => [key, value.substitute(resolved)]);
    const renameTo = this.renameTo?.substitute(resolved);
    return new Name(parts, constraints, renameTo, this.marked);
  }

  /**
   * @return the name's first part where it is a literal, otherwise the empty
   * string.
   */
  public getLiteralPrefix(): string {
    return this.parts[0].kind === NamePartKind.Literal ? this.parts[0].value : "";
  }

  /**
   * @return a new name with `prefix` removed from the start of its first
   * literal part, with a `/` that follows it: the Name "mylib/lib/*" and
   * "mylib" give "lib/*". `prefix` is matched as text, not as whole
   * components. Where the first part does not start with `prefix`, the parts
   * are unchanged. Either way, the result carries no constraints, rename
   * target or marker.
   */
  public withoutPrefix(prefix: string): Name {
    const [head, ...parts] = this.parts;
    if (head.kind === NamePartKind.Literal && head.value.startsWith(prefix)) {
      const length = head.value[prefix.length] === NAME_COMPONENT_SEPARATOR ? prefix.length + 1 : prefix.length;
      const value = head.value.substring(length);
      return new Name(value === "" ? [...parts] : [{ kind: NamePartKind.Literal, value }, ...parts]);
    }
    return new Name([head, ...parts]);
  }

  /**
   * @return the tail of this name from `start`, an offset into its written text
   * ({@link toBaseString}), with the rename target and override marker but not
   * the constraints. Used to split a reference into what it names and the
   * projection after it: the rename belongs to the projection, and the
   * constraints to what they constrain. Throws where `start` falls inside a
   * part that is not a literal (a `:` or `/` boundary is always in one).
   */
  public substring(start: number): Name {
    const parts: NamePart[] = [];
    let offset = 0;
    for (const part of this.parts) {
      const end = offset + Name.renderPart(part, false).length;
      if (end <= start) {
        offset = end;
        continue;
      }
      if (parts.length === 0 && start > offset) {
        if (part.kind !== NamePartKind.Literal) {
          throw new FabrError(`internal: '${this.toString()}' cannot be split inside a pattern (at offset ${start})`);
        }
        parts.push({ kind: NamePartKind.Literal, value: part.value.substring(start - offset) });
      } else {
        parts.push(part);
      }
      offset = end;
    }
    return new Name(parts, [], this.renameTo, this.marked);
  }

  /**
   * @return a new name with the literal `prefix` put before it, its facets and
   * marker kept (`./x.fabr -> PROJECT.fabr` re-rooted still renames). A
   * leading `./` is dropped at the join, giving `dir/x` rather than
   * `dir/./x`: picomatch strips only a leading `./`, so a glob with an
   * interior `/./` would match nothing.
   */
  public withPrefix(prefix: string): Name {
    if (this.parts[0].kind === NamePartKind.Literal) {
      const [head, ...rest] = this.parts;
      const value = prefix + head.value.replace(/^\.\//, "");
      return new Name([{ kind: NamePartKind.Literal, value }, ...rest], this.constraints, this.renameTo, this.marked);
    } else {
      return new Name([{ kind: NamePartKind.Literal, value: prefix }, ...this.parts], this.constraints, this.renameTo, this.marked);
    }
  }

  /**
   * @return this name re-rooted at the directory of `filename`, joined as an
   * alias (`dir:name`): the directory locates the files and, like any alias,
   * is left out of result names. So a slash-form name keeps its whole written
   * path, a colon-form name loses its own alias too (names run from the last
   * `:`), and a `../` climb flattens to its tail under FileSet name
   * canonicalization. The Name "mylib/lib/*" and "src/lib/BUILD.fabr" give
   * "src/lib:mylib/lib/*", whose results are named "mylib/lib/…".
   *
   * Where `filename` has no directory, or is directly under `/`, the name is
   * returned as it is. Does not interpret "." or "..".
   */
  public relativeTo(filename: string): Name {
    const idx = filename.lastIndexOf(NAME_COMPONENT_SEPARATOR);
    if (idx === -1 || idx === 0) {
      return this;
    } else {
      return this.withPrefix(filename.substring(0, idx) + NAME_LEVEL_SEPARATOR);
    }
  }

  /**
   * @return this name in the namespace of a source rooted at `root`, whose
   * names are relative to it (as FSFileSource's are): an absolute literal head
   * under `root` loses the root prefix. Any other name is returned as it is: a
   * relative name is already in the namespace, and an absolute one outside
   * `root` matches nothing. The facets and marker are kept.
   */
  public rebase(root: string): Name {
    const head = this.parts[0];
    if (head.kind !== NamePartKind.Literal || !head.value.startsWith(NAME_COMPONENT_SEPARATOR)) {
      return this;
    }
    const prefix = root.endsWith(NAME_COMPONENT_SEPARATOR) ? root : root + NAME_COMPONENT_SEPARATOR;
    if (!head.value.startsWith(prefix)) {
      return this;
    }
    const rebased: NamePart = { kind: NamePartKind.Literal, value: head.value.substring(prefix.length) };
    return new Name([rebased, ...this.parts.slice(1)], this.constraints, this.renameTo, this.marked);
  }

  /**
   * @return as getLiteralPrefix, but without the last path component where a
   * non-literal part follows, keeping the `:` or `/` that ends what is kept,
   * so a caller can tell a projection from a path boundary; the empty string
   * where no separator precedes the first non-literal part. "src/bar/foo*.ts"
   * gives "src/bar/", "pkg:*.js" gives "pkg:", and an all-literal name gives
   * itself ("src/bar").
   */
  public getLiteralPathPrefix(): string {
    if (this.parts[0].kind !== NamePartKind.Literal) {
      return "";
    }
    const prefix = this.parts[0].value;
    if (this.parts.length === 1) {
      return prefix;
    } else {
      const pidx = prefix.lastIndexOf(NAME_COMPONENT_SEPARATOR);
      const cidx = prefix.lastIndexOf(NAME_LEVEL_SEPARATOR);
      const idx = pidx > cidx ? pidx : cidx;
      /* Retain the separator itself (substring end is idx + 1). */
      return idx === -1 ? "" : prefix.substring(0, idx + 1);
    }
  }

  /**
   * Render the name's parts, without its facets. With `escape`, literal parts
   * are escaped, as for a matcher ({@link toGlobString}); without, they are
   * verbatim ({@link toString}). Glob parts render verbatim either way.
   */
  private renderParts(escape: boolean): string {
    return this.parts.map(part => Name.renderPart(part, escape)).join("");
  }

  /** Render one part as written, a literal's glob characters escaped if
   * `escape`. */
  private static renderPart(part: NamePart, escape: boolean): string {
    switch (part.kind) {
      case NamePartKind.Literal:
        return escape ? escapeGlob(part.value) : part.value;
      case NamePartKind.Glob:
        return part.value;
      case NamePartKind.VarSubst: {
        const constraints =
          part.constraints === undefined
            ? ""
            : "<" + part.constraints.map(([key, value]) => `${key}=${value.toString()}`).join(", ") + ">";
        return "${" + part.value + constraints + (part.edit === undefined ? "" : renderPatternEdit(part.edit)) + "}";
      }
      case NamePartKind.Backref:
        return "$" + part.value;
      case NamePartKind.CommandSubst:
        return "`" + part.value + "`";
    }
  }

  /** Append the `<k=v>` / `-> tmpl` facets to an already-rendered selector, each
   * facet rendered in the same mode as the selector it hangs off. */
  private withFacets(selector: string, render: (name: Name) => string): string {
    let result = selector;
    if (this.constraints.length > 0) {
      const written = this.constraints.map(([key, value]) => `${key}=${render(value)}`).join(", ");
      result = `${result}<${written}>`;
    }
    if (this.renameTo !== undefined) {
      /* Always render the arrow spaced: `sel -> tmpl`. */
      result = `${result} -> ${render(this.renameTo)}`;
    }
    return result;
  }

  /**
   * @return this name as written: literal parts verbatim, glob metacharacters
   * as they are, facets appended. This is the name's text: what it means as a
   * value (a STRING property, a command argument, a constraint value, a
   * destination coordinate), and what a diagnostic shows. It does not parse
   * back to the same name: a literal containing metacharacters (a quoted
   * `'!(a)'`) renders as the syntax it is not. Use {@link toGlobString} for a
   * matcher and for identity (a cache key).
   */
  public toString(): string {
    return this.withFacets(this.renderParts(false), name => name.toString());
  }

  /**
   * @return the name as written without its facets, which say what to do about
   * the name (the configuration it applies in, what to call what it selects)
   * rather than what it names. Key an index by it, and compare it with a name
   * written elsewhere: a property declared once per platform is looked up
   * under the one name, while {@link toString}, facets included, tells its
   * declarations apart. Renders as {@link toString} does.
   */
  public toBaseString(): string {
    return this.renderParts(false);
  }

  /**
   * @return the name for a glob matcher: literal metacharacters escaped so they
   * match themselves, glob parts as they are, facets appended. It is also the
   * name's canonical form, which parses back to the same name, so a manifest or
   * cache key renders with this, never with {@link toString}.
   */
  public toGlobString(): string {
    return this.withFacets(this.renderParts(true), name => name.toGlobString());
  }
}

/** A literal `/`, for joining components ({@link Name.componentPrefixes}).
 * Declared after the class, whose constructor its initializer calls. */
const SLASH = Name.fromLiteral(NAME_COMPONENT_SEPARATOR);

/** A looked-up REWRITE property: a path to its renamed form, or undefined
 * where no value in the property matched (what that means is the rule's). */
export type RewriteFn = (name: string) => string | undefined;

/**
 * Make a {@link RewriteFn} from a REWRITE property's values, already
 * substituted, the first in written order that matches a path giving its
 * name: a `sel -> tmpl` value renames the paths it selects, and a bare value
 * is a constant every path maps to (two files given one name conflict where
 * the result is renamed).
 */
export function makeRewrite(names: Name[]): RewriteFn {
  const rules = names.map(name => {
    const renameTo = name.getRenameTo();
    if (renameTo) {
      return name.makeRenamer(renameTo);
    }
    const constant = name.toString();
    return () => constant;
  });
  return (path: string) => {
    for (const rule of rules) {
      const out = rule(path);
      if (out !== undefined) {
        return out;
      }
    }
    return undefined;
  };
}

/** A builder of a Name part by part, as the parser reads it: adjacent parts
 * of one kind are merged, bar substitutions. */
export class NameBuilder {
  private parts: NamePart[] = [];
  private last: NamePart | undefined = undefined;

  private append(kind: NamePartKind, value: string): this {
    if (value === "") {
      return this;
    } else if (kind !== NamePartKind.VarSubst && this.last?.kind === kind) {
      this.last.value += value;
    } else {
      const part = { kind, value };
      this.parts.push(part);
      this.last = part;
    }
    return this;
  }

  /**
   * Add characters to be interpreted literally (ie not as glob metacharacters),
   * such as from a single-quoted string.
   * @param str
   */
  public appendLiteralString(str: string): this {
    this.append(NamePartKind.Literal, str);
    return this;
  }

  /**
   * Add characters from a double-quoted string; backslash sequences are unescaped,
   * and the result is treated as a literal string.
   * Note: does not extract substitution variables from the string.
   * @param str The contents of the DQ string (excluding the containing quotes)
   */
  public appendEscapedString(str: string): this {
    this.append(NamePartKind.Literal, unescapeDoubleQuotedString(str));
    return this;
  }

  /**
   * Add glob metacharacters, live in the pattern: `*`, `?`, `[...]`, or a piece
   * of an extglob group (`?(`, `*(`, `+(`, `@(` or `!(`, a `|` separator, the
   * closing `)`). The parser adds a group's interior as ordinary name text, so
   * wildcards and substitutions work inside a group.
   * @param str
   */
  public appendGlobMetachars(str: string): this {
    this.append(NamePartKind.Glob, str);
    return this;
  }

  /**
   * Add a substitution variable by name, with the `<k=v>` requirement it is
   * read under and the edit of its value, where they were written.
   */
  public appendSubstVar(str: string, constraints?: readonly NameConstraint[], edit?: PatternEdit): this {
    this.append(NamePartKind.VarSubst, str);
    if (constraints !== undefined) {
      this.last!.constraints = constraints;
    }
    if (edit !== undefined) {
      this.last!.edit = edit;
    }
    return this;
  }

  /**
   * Add a command substitution: `text` as written (without the backticks) plus
   * the parsed command, which core carries but never inspects.
   */
  public appendCommandSubst(text: string, command: CommandPipeline): this {
    this.parts.push({ kind: NamePartKind.CommandSubst, value: text, command });
    /* Merge nothing into a command substitution, nor it into a neighbour: two
     * adjacent ones are two commands. Clear `last` rather than point it here. */
    this.last = undefined;
    return this;
  }

  public reset(): void {
    this.parts = [];
    this.last = undefined;
  }

  /** @return the name built so far, and start a new one. */
  public name(): Name {
    const result = new Name(this.parts);
    this.reset();
    return result;
  }
}

/** Unescape a double-quoted string's backslash sequences: `\0`-led octal,
 * `\xHH`, `\a` to `\v`, and any other character as itself. */
function unescapeDoubleQuotedString(str: string): string {
  return str.replaceAll(/\\(0[0-7]*|x[0-9a-fA-F][0-9a-fA-F]|.)/g, (_, p1: string) => {
    if (p1[0] === "0") {
      return String.fromCharCode(parseInt(p1, 8));
    } else if (p1[0] === "x") {
      return String.fromCharCode(parseInt(p1.substring(1), 16));
    } else {
      switch (p1) {
        case "a":
          return "\x07";
        case "b":
          return "\x08";
        case "e":
          return "\x1b";
        case "f":
          return "\f";
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        case "v":
          return "\v";
        default:
          return p1;
      }
    }
  });
}

/**
 * Escape every character a matcher would otherwise read as syntax, so a literal
 * part (quoted text, a `${VAR}` value) matches itself.
 *
 * `(`, `)` and `|` are escaped too, though picomatch reads them only in a
 * group: a quoted `'!(a)'` must name that file, and escaping only the `!`
 * would leave `(a)` a group. A leading `!` is negation to picomatch and an
 * ordinary character to fabr. `+` and `@` need no escape: they lead a group
 * only before a `(`, which is escaped.
 */
function escapeGlob(str: string): string {
  return str.replaceAll(/([\][\\*?()!|])/g, "\\$1");
}
