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
import { globCaptureRegex, globMatcher, globPrefixRegex } from "../support/Glob";
import type { CommandPipeline } from "../model/AST";

export enum NamePartKind {
  Literal,
  Glob,
  VarSubst,
  /**
   * A `$1`-style back-reference to a numbered wildcard.
   */
  Backref,
  /**
   * A backtick `cmd args` `` command substitution: 
   */
  CommandSubst,
}

/** Whether a part's text is supplied from *outside* the name — a variable to
 * look up or a command to run. The two differ only in how that text is obtained,
 * which is the resolver's business and not the name's, so everything here treats
 * them alike. */
function isSubstituted(part: NamePart): boolean {
  return part.kind === NamePartKind.VarSubst || part.kind === NamePartKind.CommandSubst;
}

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
}

/**
 * name/path components are separated by slash (yes even on windows)
 */
export const NAME_COMPONENT_SEPARATOR = "/";
export const NAME_LEVEL_SEPARATOR = ":";

/** The glob metacharacters — the boundary past which lexical path
 * normalization must not reach (`normalize` would fold a `..` *through* a `*`
 * segment, silently changing what it names). */
const GLOB_METACHAR = /[*?[]/;

/** Either separator, for splitting into path components: `/` and the `:` alias
 * boundary are both path separators on disk (see makeProjector). */
const SEPARATOR = /[/:]/;

/**
 * Normalize the literal head of a slash-form selector (resolve `.`/`..`,
 * collapse separator runs) without touching anything at or after the first
 * glob metachar. Matching happens in canonical path space — walked and
 * FileSet names arrive normalized — so a selector's static head must be
 * canonical too, or a written climb (`docs/../scripts/*.ts`) matches nothing.
 * A `..` that survives at the front (climbing past the namespace root) or
 * sits after a glob is left as written: it can never match a canonical input,
 * which is the honest outcome for a query naming outside its namespace.
 */
function normalizeHead(pathForm: string): string {
  const meta = pathForm.search(GLOB_METACHAR);
  const cut = meta === -1 ? pathForm.length : pathForm.lastIndexOf(NAME_COMPONENT_SEPARATOR, meta) + 1;
  if (cut === 0) {
    return pathForm;
  }
  const head = path.posix.normalize(pathForm.substring(0, cut));
  return (head === "." || head === "./" ? "" : head) + pathForm.substring(cut);
}

/**
 * A string expression, potentially consisting of literal, wildcard, and variable substitution parts
 */
/**
 * A single constraint written in a `<KEY=value>` facet: the key is a scalar
 * config identifier, the value a Name (so it may itself carry a `${subst}`).
 * Kept in written order (see Name.constraints). What it *means* is decided by
 * position — a **requirement** on a reference, a **guard** on a declaration's
 * key — so this carries only what was written.
 */
export type NameConstraint = readonly [key: string, value: Name];

export class Name {
  private parts: NamePart[];
  /**
   * The configuration this reference requires (`ref<KEY=value, ...>`), or — on
   * a declaration's key — the configuration that guards it,
   * in written order, or empty. Kept apart from `parts` (which hold only the
   * resolvable base+projection literal): a FILES consumer applies these as a
   * config override when resolving the reference, while `toString` re-renders
   * them so a value used as a plain string round-trips to its original text.
   * Ordered (not a map) precisely so that round-trip is faithful.
   */
  private readonly constraints: readonly NameConstraint[];
  /**
   * The rename target written on this reference (the `tmpl` of `sel -> tmpl`), or
   * undefined. Like {@link constraints} it rides *alongside* `parts` (which hold
   * only the resolvable selector): a FILES consumer replays this pattern over the
   * selector's captures to rename the selected files ({@link replay}), while
   * `toString` re-renders it so a value used as a plain string round-trips. Its
   * own `parts` are the target's literal text and `*`/`**` replay slots; it never
   * itself carries a rename target or constraints (parser-enforced).
   */
  private readonly renameTo: Name | undefined;

  constructor(parts: NamePart[], constraints: readonly NameConstraint[] = [], renameTo?: Name) {
    if (parts.length === 0) {
      this.parts = [{ kind: NamePartKind.Literal, value: "" }];
    } else {
      this.parts = parts;
    }
    this.constraints = constraints;
    this.renameTo = renameTo;
  }

  /**
   * Construct and return a new name from a simple literal string.
   */
  static fromLiteral(str: string): Name {
    return new Name([{ kind: NamePartKind.Literal, value: str }]);
  }

  /**
   * @return a copy of this name carrying the given constraints (replacing
   * any it already had). The parts are unchanged — constraints ride alongside.
   */
  public withConstraints(constraints: readonly NameConstraint[]): Name {
    return new Name(this.parts, constraints, this.renameTo);
  }

  /** @return the constraints written on this name — what a reference *requires*
   * of its referent's configuration, or what *guards* a declaration (empty if
   * none; position is what decides which). */
  public getConstraints(): readonly NameConstraint[] {
    return this.constraints;
  }

  /**
   * @return a copy of this name carrying the given rename target (replacing any
   * it already had; `undefined` clears it). The parts (the selector) are
   * unchanged. Accepting `undefined` lets a caller re-attach an optional target
   * onto a selector unconditionally.
   */
  public withRenameTo(renameTo: Name | undefined): Name {
    return new Name(this.parts, this.constraints, renameTo);
  }

  /** @return the rename target written on this reference (undefined if none). */
  public getRenameTo(): Name | undefined {
    return this.renameTo;
  }

  /**
   * The glob wildcard units of this name in written order — one entry per
   * `*`/`**`/`?`/`[...]` run (a maximal run of glob metacharacters). Read by the
   * parser to enforce the rename rules: a rename glob's units must all be `*` or
   * `**` (so picomatch captures line up positionally with the template's slots),
   * and the selector's and template's unit counts must match — both waived for a
   * wildcard-free template, which replays nothing. A plain (non-rename) selector
   * is unrestricted, so this is only consulted on rename surfaces.
   */
  public getGlobUnits(): string[] {
    return this.parts.filter(part => part.kind === NamePartKind.Glob).map(part => part.value);
  }

  /**
   * This rename target as a `String.replace` **replacement string**: each `*`/`**`
   * slot becomes its positional capture reference (`$1`, `$2`, …), literal text
   * verbatim (with `$` escaped so it isn't read as a group reference). Paired with
   * the selector's {@link globCaptureRegex} by {@link makeRenamer}. Assumes
   * substitution has run and (via Validate) that the slot count matches the
   * selector's wildcard count.
   */
  public toReplacement(): string {
    let slot = 0;
    return this.parts
      .map(part => {
        switch (part.kind) {
          case NamePartKind.Glob:
            /* A bare wildcard takes the next capture in order — the positional
             * form, which is `$1…$n` written out. */
            return `$${++slot}`;
          case NamePartKind.Backref:
            return `$${part.value}`;
          default:
            /* A literal `$` must be doubled so `replace` reads it as text, not a
             * group ref. The function replacer inserts its result verbatim — a
             * plain string `"$$"` would instead be read as an escape for a
             * single `$` (a no-op). */
            return part.value.replaceAll("$", () => "$$");
        }
      })
      .join("");
  }

  /**
   * This name read as a **rename template**: any `$1`-style substitution becomes
   * a capture back-reference ({@link NamePartKind.Backref}) instead of a
   * variable read.
   *
   * The reinterpretation happens here, at the one place a template is parsed,
   * rather than in the lexer — so `$1` keeps its ordinary meaning (a property
   * named `1`, which cannot be declared, hence an unknown-property error)
   * everywhere else, and no other reading of a name has to know captures exist.
   */
  public asRenameTemplate(): Name {
    if (!this.parts.some(part => part.kind === NamePartKind.VarSubst && /^[0-9]+$/.test(part.value))) {
      return this;
    }
    const parts = this.parts.map(part =>
      part.kind === NamePartKind.VarSubst && /^[0-9]+$/.test(part.value)
        ? { kind: NamePartKind.Backref, value: part.value }
        : part
    );
    return new Name(parts, this.constraints, this.renameTo);
  }

  /** The wildcard indices this template back-references (`$1` → 1), in written
   * order; empty for a template that replays positionally or not at all. */
  public getBackrefIndices(): number[] {
    return this.parts.filter(part => part.kind === NamePartKind.Backref).map(part => Number(part.value));
  }

  /**
   * Compile a renamer using this name as the *selector* and `renameTo` as the
   * template: a function mapping a path to its renamed form, or undefined for a
   * non-match (so a caller can drop unselected files). A rename is just a
   * capturing-regex replace — the selector's `*`/`**` groups substitute into the
   * template's positional `$1`/`$2`. The selector matches on this name's own glob
   * (its `parts`, not its facets), so it works whether the selector is a whole
   * REWRITE value or the post-`:` projection remainder. Assumes substitution has
   * run, and that the wildcard counts agree — which the parser guarantees for
   * every name it attaches the facet to. A **wildcard-free** template needs no
   * agreement (it fills no slot): every selected file maps to that one name, so
   * whether the rename is legal is the caller's collision rule, not this one's —
   * {@link FileSet.rename} conflicts unless the selection is a single file.
   */
  public makeRenamer(renameTo: Name): (path: string) => string | undefined {
    /* Match on the path (every `:`→`/`, head-normalized — see makeProjector) so
     * a colon-form selector matches the slash paths on disk / in a package; the
     * rename target owns result names, so the alias segments are matched but
     * never carried into them. (A no-op for a colon-free selector — every
     * REWRITE / single-`:` ref; it bites only a multi-`:` reference like
     * `d:sub:*.x -> *.y`.) */
    const selector = this.renderParts(true);
    const re = globCaptureRegex(normalizeHead(selector.replaceAll(NAME_LEVEL_SEPARATOR, NAME_COMPONENT_SEPARATOR)));
    const replacement = renameTo.toReplacement();
    /* The literal alias path itself is excluded, mirroring makeProjector's
     * plain arm: `x:** -> tmpl` renames the files *under* x, never x — a
     * globstar admits its own base, which would otherwise emit the base file
     * under the template's collapsed (empty-capture) name. Unescaped, like the
     * projector's: it is compared against real paths. */
    const aliasPath = this.aliasAsPath(false);
    const excluded = aliasPath !== undefined && !GLOB_METACHAR.test(aliasPath) ? aliasPath : undefined;
    /* An unmatched globstar group substitutes as "" (native to `replace`), which
     * can leave a doubled or edge slash (a root-level recursive prefix); fabr
     * names are relative paths, so collapse runs of `/` and trim the ends — this
     * makes a recursive rename structure-preserving at every depth, root too. */
    return (input: string) => {
      if (!re.test(input) || (excluded !== undefined && path.posix.relative(excluded, input) === "")) {
        return undefined;
      }
      return input.replace(re, replacement).replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
    };
  }

  /**
   * Compile this name into a **projection**: a function mapping an input path to
   * its result name, or undefined for a non-match (drop it). This is the whole
   * of what a projection *means*, owned by the name so a `find` is just applying
   * it to a dataset. With a `sel -> tmpl` facet it is the rename ({@link
   * makeRenamer}). Otherwise it selects by glob and rewrites the match under
   * `prefix` (the degenerate rename — "prefix-strip is just a rename"). Either
   * way it honors the written-name rule: the alias separator `:` is a path
   * separator on disk / within a package (`src:**` matches `src/…`) and is the
   * **naming root** — a result is named by its path relative to the alias (all
   * of it, up to the last `:`); a slash-form name (no `:`) retains its full
   * path. Matching happens in canonical path space: inputs (walked or FileSet
   * names) arrive normalized, so the selector's literal head is normalized
   * before compiling ({@link normalizeHead}). Assumes substitution has run.
   */
  public makeProjector(prefix = ""): (input: string) => string | undefined {
    if (this.renameTo) {
      return this.makeRenamer(this.renameTo);
    }
    const selector = this.toGlobString();
    const matcher = globMatcher(normalizeHead(selector.replaceAll(NAME_LEVEL_SEPARATOR, NAME_COMPONENT_SEPARATOR)));
    /* The alias PATH is compared against real input paths (`relative`), so it
     * must be the unescaped rendering — the escaped selector exists only for
     * the matcher, and a literal alias containing `(`/`)`/`!`/`|` renders
     * escaped there. Only the glob-alias arm, which compiles a pattern, wants
     * the escaped form. */
    const aliasPath = this.aliasAsPath(false);
    if (aliasPath === undefined) {
      return input => (matcher(input) ? prefix + input : undefined);
    }
    if (!GLOB_METACHAR.test(aliasPath)) {
      /* Literal alias: name each result relative to the alias dir (relative()
       * normalizes its operands itself). A remainder that climbs out of the
       * alias (`lib:../tools/*.js`) names as its climbed path (`../tools/y.js`),
       * which FileSet name canonicalization then flattens to its tail — the
       * familiar prefix-strip is the non-climbing degenerate case of this rule.
       * The alias path ITSELF is excluded (its relative name would be the empty
       * string): a globstar remainder matches its own base (`a/**` admits `a`),
       * but `x:**` means the files *under* x, never x — which is what keeps a
       * projection into an archive from also emitting the archive file. */
      return input => {
        if (!matcher(input)) {
          return undefined;
        }
        const rel = path.posix.relative(aliasPath, input);
        return rel === "" ? undefined : prefix + rel;
      };
    }
    /* Glob alias (`pkg*:lib/*`): no concrete dir to name relative to, so strip
     * the matched alias textually. A remainder climbing under a glob alias has
     * no coherent naming and never matches (its `..` survives in the pattern). */
    const strip = globPrefixRegex(this.aliasAsPath(true)! + NAME_COMPONENT_SEPARATOR);
    return input => (matcher(input) ? prefix + input.replace(strip, "") : undefined);
  }

  /**
   * The alias portion (everything before the last `:`) as a slash path, or
   * undefined for a slash-form name. `escape` selects the rendering: escaped
   * feeds a pattern compiler ({@link globPrefixRegex}); unescaped is the path
   * itself, for comparison against real input paths — the two disagree
   * whenever a literal component contains glob punctuation.
   */
  private aliasAsPath(escape: boolean): string | undefined {
    const rendered = this.renderParts(escape);
    const alias = rendered.lastIndexOf(NAME_LEVEL_SEPARATOR);
    return alias === -1 ? undefined : rendered.substring(0, alias).replaceAll(NAME_LEVEL_SEPARATOR, NAME_COMPONENT_SEPARATOR);
  }

  /**
   * @return a copy naming everything at or below this path: appends a `**`
   * globstar, inserting a `/` unless the name already ends at a separator (`/` or
   * the `:` alias boundary). For a bare directory reference — `src` → `src/**`,
   * `src:` → `src:**` — so the same {@link makeProjector} rules then apply.
   */
  public appendGlobstar(): Name {
    /* The SELECTOR's last character decides — the facets must not reach this.
     * `enumerate` appends the globstar while the name still carries its `-> tmpl`
     * (it re-attaches an expanded target afterwards), so reading a facet-bearing
     * rendering would test the template's tail: `stuff -> out/` would see the
     * template's `/` and append `**` with no separator. */
    const written = this.renderParts(false);
    const last = written.charAt(written.length - 1);
    const sep = last === NAME_COMPONENT_SEPARATOR || last === NAME_LEVEL_SEPARATOR ? "" : NAME_COMPONENT_SEPARATOR;
    const tail: NamePart[] = sep ? [{ kind: NamePartKind.Literal, value: sep }, { kind: NamePartKind.Glob, value: "**" }] : [{ kind: NamePartKind.Glob, value: "**" }];
    return this.concat(new Name(tail));
  }

  /**
   * The selector's path components: this name split at every separator (`/`
   * and the `:` alias boundary alike — a `:` is a path separator on disk),
   * each component a Name of its own parts (globs and unsubstituted `${var}`s
   * preserved). Pure tokenization — no facets ride the components, and a
   * consumer joins/interprets them on its own terms (archive descent folds
   * them back into boundary probes; see Expand's descentPrefixes).
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
   * The cumulative slash-joined prefixes of {@link components}: `prefixes[i]`
   * is components 0…i rejoined with `/` — the reference's leading path at each
   * depth, ready to match against in-namespace names (the boundary probes of
   * archive descent; a fetch repository's member selection). Facet-free, like
   * the components ({@link concat} carries none).
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
   * @return this name with `other` appended, merging adjacent same-kind parts at
   * the seam (so a literal base and a literal projection tail collapse to one
   * literal prefix, keeping prefix-matching intact). Used to reassemble a
   * reference split by an intervening `<...>` (`pkg` + `:build/*.js`). Constraints
   * are taken from neither operand — the caller attaches them.
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
    return new Name(merged);
  }

  public hasConstraints(): boolean {
    return this.constraints.length > 0;
  }

  public isSimpleName(): boolean {
    return this.parts.length === 1 && this.parts[0].kind === NamePartKind.Literal;
  }

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

  /** Whether any literal part contains the `:` level separator — used by Validate
   * to reject it in a rename template (and in a REWRITE selector), where the
   * pattern is matched/replayed against package-relative names, not references. */
  public hasLevelSeparator(): boolean {
    return this.parts.some(part => part.kind === NamePartKind.Literal && part.value.includes(NAME_LEVEL_SEPARATOR));
  }

  public hasVarSubst(): boolean {
    return this.parts.some(part => part.kind === NamePartKind.VarSubst);
  }

  /**
   * Every part of this name whose text comes from outside it — variables and
   * command substitutions alike — including those inside its constraint values
   * and rename target. The caller resolves each however that kind requires (a
   * property lookup, a command run) and hands the results back to
   * {@link substitute}, which is what lets one pass settle both.
   */
  public getSubstitutions(): NamePart[] {
    const own = this.parts.filter(isSubstituted);
    /* Constraint values may themselves substitute (`<K=${X}>`), which must be
     * resolved before the constraints are applied. */
    const withConstraints = this.constraints.reduce<NamePart[]>((parts, [, value]) => parts.concat(value.getSubstitutions()), own);
    /* The rename target may substitute too (`-> *.${BUILD_NO}.js`). */
    return this.renameTo ? withConstraints.concat(this.renameTo.getSubstitutions()) : withConstraints;
  }

  /**
   * Replace every substituted part with its resolved text, collapsing it to a
   * Literal — so nothing downstream of substitution knows a variable or a
   * command was ever there.
   *
   * Keyed by **part identity**, not by written form: {@link getSubstitutions}
   * hands back the very objects this walks (through constraint values and the
   * rename target too), so there is no key space to collide in — a variable
   * named `X` and a command written `X` are simply different parts.
   */
  public substitute(resolved: ReadonlyMap<NamePart, string>): Name {
    /* Note: internally we collapse strings down so that afterwards we can treat it as if
     * the subst vars were never there.
     */
    const parts = this.parts.reduce<NamePart[]>((rest, part) => {
      const newPart = isSubstituted(part) ? { kind: NamePartKind.Literal, value: resolved.get(part)! } : part;
      if (rest.length > 0 && rest[rest.length - 1].kind === newPart.kind) {
        rest[rest.length - 1] = { kind: newPart.kind, value: rest[rest.length - 1].value + newPart.value };
      } else {
        rest.push(newPart);
      }
      return rest;
    }, []);

    /* Constraint values are substituted too (they share the name's resolution),
     * so `<K=${X}>` resolves before the constraints are applied / rendered. */
    const constraints = this.constraints.map<NameConstraint>(([key, value]) => [key, value.substitute(resolved)]);
    /* The rename target substitutes as well (`-> *.${BUILD_NO}.js`), collapsed to
     * literal parts here so replay never sees a VarSubst. */
    const renameTo = this.renameTo?.substitute(resolved);
    return new Name(parts, constraints, renameTo);
  }

  /**
   * If the name starts with a literal component return that component, otherwise return
   * the empty string.
   */
  public getLiteralPrefix(): string {
    return this.parts[0].kind === NamePartKind.Literal ? this.parts[0].value : "";
  }

  /**
   * The whole name as verbatim text, when it is a literal followed by nothing
   * but one final glob part — undefined for any other shape (a real pattern
   * like `src/*.ts?` has interior glob parts and stays one). This is how a
   * repository's version slot reads a written `pkg:1.4.2?` or `pkg:1.14.*`:
   * lexically those tails are globs, but a version cannot meaningfully glob,
   * so the repository folds the text back into the version — the `?` override
   * marker, or a `*` x-range — instead of losing it to the literal-prefix
   * split. (A glob anywhere else stays a real pattern; only the position past
   * the last `:` of a requirement has no pattern meaning to preserve.)
   */
  public getLiteralWithGlobTail(): string | undefined {
    if (this.parts.length !== 2) {
      return undefined;
    }
    const [head, tail] = this.parts;
    return head.kind === NamePartKind.Literal && tail.kind === NamePartKind.Glob ? head.value + tail.value : undefined;
  }

  /**
   * @return a new name with the initial literal prefix matching the given value removed,
   * including any trailing '/' character.
   *  e.g. given the Name ("mylib/lib/*") and value "mylib", will yield the Name "lib/*"
   * If the prefix does not match, returns an unmodified copy of the name
   * @param prefix
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
   * @return the tail of this name from `start` (a suffix of its literal head),
   * carrying the rename target but NOT the constraints. The sole use is
   * splitting a reference into target + projection (getPrefixMatch, a
   * repository's getRepositoryRef): the tail IS the projection, so a `-> tmpl`
   * rename (final naming) rides onto it, while the constraints stay behind
   * on the target it constrains (and is consumed at target resolution).
   */
  public substring(start: number): Name {
    const [head, ...parts] = this.parts;
    if (head.kind === NamePartKind.Literal && (head.value.length >= start || parts.length === 0)) {
      const rest = head.value.substring(start);
      if (rest === "") {
        return new Name(parts, [], this.renameTo);
      } else {
        return new Name([{ kind: NamePartKind.Literal, value: rest }, ...parts], [], this.renameTo);
      }
    }
    return new Name([head, ...parts], [], this.renameTo);
  }

  /**
   * @return a new name with the given initial literal prefix added to the name.
   * A pure structural re-rooting of the path (used by {@link relativeTo}): the
   * constraint and `-> tmpl` rename facets ride along unchanged, so a
   * file-relative reference keeps them (`./x.fabr -> PROJECT.fabr` re-rooted
   * against its including file still renames). A leading `./` on the head is
   * dropped at the seam so the joined path is `dir/x`, not `dir/./x` — the
   * latter's interior `/./` is not glob-normalized (picomatch strips only a
   * *leading* `./`), which would make a re-rooted glob match nothing.
   */
  public withPrefix(prefix: string): Name {
    if (this.parts[0].kind === NamePartKind.Literal) {
      const [head, ...rest] = this.parts;
      const value = prefix + head.value.replace(/^\.\//, "");
      return new Name([{ kind: NamePartKind.Literal, value }, ...rest], this.constraints, this.renameTo);
    } else {
      return new Name([{ kind: NamePartKind.Literal, value: prefix }, ...this.parts], this.constraints, this.renameTo);
    }
  }

  /**
   * @return a new name re-rooted at the dirname of `filename`, joined as a `:`
   * alias: the dir *locates* the files (an alias is a path separator on disk)
   * but is stripped from result names by `find`'s own projection — the
   * colon-form rule, which the written-name rule then falls out of with no
   * post-find renaming. A slash-form written name keeps its full written path
   * (only the dir strips); a colon-form name strips its own alias too (the
   * strip runs to the LAST `:`); a `../` climb in the written path flattens
   * to its tail under FileSet name canonicalization.
   * e.g. given the Name "mylib/lib/*" and filename "src/lib/BUILD.fabr",
   * returns the Name "src/lib:mylib/lib/*", whose results are named
   * "mylib/lib/…".
   *
   * If the filename does not have a dirname (e.g. "foo", a root-level build
   * file), the original name is returned unmodified — the degenerate no-prefix
   * case, uniform with the above.
   *
   * Note: Does not attempt to interpret "." or ".."
   * @param filename
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
   * @return this name re-expressed in the namespace of a source rooted at
   * `root`: an absolute literal head under `root` sheds the root prefix — a
   * source's names are root-relative (see FSFileSource: `find` results are
   * named `relative(root, ·)`, and `get` applies this same normalization to
   * its path argument). Anything else returns unchanged: a relative name
   * already is in the namespace, and an absolute head *outside* `root` cannot
   * name anything in this source — left as written, it matches nothing. The
   * facets ride along untouched.
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
    return new Name([rebased, ...this.parts.slice(1)], this.constraints, this.renameTo);
  }

  /**
   * As getLiteralPrefix, but excludes the final path component if it contains a
   * non-literal part — keeping the separator (':' or '/') that terminates the
   * retained prefix, so the caller can tell a projection from a path boundary.
   * If the name does not have a literal path prefix, returns the empty string.
   *
   * e.g. "src/bar/foo*.ts" => "src/bar/", "pkg:*.js" => "pkg:"
   * (a fully-literal name has no trailing separator: "src/bar" => "src/bar")
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
   * Render just the resolvable selector (`parts`). `escape` controls what happens
   * to a *literal* part: escaped (the glob string a matcher compiles — see
   * {@link toGlobString}) or verbatim (the text the name denotes — see
   * {@link toString}). Glob parts render verbatim either way. Excludes the
   * `<...>` / `-> ` facets, which the two public renderings append.
   */
  private renderParts(escape: boolean): string {
    return this.parts.reduce((result, part) => {
      switch (part.kind) {
        case NamePartKind.Literal:
          return result + (escape ? escapeGlob(part.value) : part.value);
        case NamePartKind.Glob:
          return result + part.value;
        case NamePartKind.VarSubst:
          return result + "${" + part.value + "}";
        case NamePartKind.Backref:
          return result + "$" + part.value;
        case NamePartKind.CommandSubst:
          return result + "`" + part.value + "`";
      }
    }, "");
  }

  /** Append the `<k=v>` / `-> tmpl` facets to an already-rendered selector, each
   * facet rendered in the same mode as the selector it hangs off. */
  private withFacets(selector: string, render: (name: Name) => string): string {
    let result = selector;
    if (this.constraints.length > 0) {
      /* Re-render the constraints so a value used as a plain string reproduces its
       * original text (`foo<a=b, c=d>`). */
      const written = this.constraints.map(([key, value]) => `${key}=${render(value)}`).join(", ");
      result = `${result}<${written}>`;
    }
    if (this.renameTo !== undefined) {
      /* Canonical spaced arrow, mirroring the constraint round-trip (a STRING
       * consumer sees `sel -> tmpl`; byte-exact input is recovered by quoting). */
      result = `${result} -> ${render(this.renameTo)}`;
    }
    return result;
  }

  /**
   * @return this name **as written**: literal parts verbatim, glob metacharacters
   * live, facets appended. This is the name's *text* — what it denotes as a
   * value (a STRING property, a command argument, a constraint value, a
   * destination coordinate) and what to show a user in a diagnostic.
   *
   * It is deliberately the default rendering, because implicit conversion
   * (`${name}`, string coercion) reaches for it: the failure mode of forgetting
   * to ask for the other one is visible text where a pattern was wanted, rather
   * than escape characters silently entering a payload — which is the bug this
   * split fixes. Anything compiling a matcher wants {@link toGlobString}.
   *
   * Note this does NOT round-trip through the parser: a literal that contains
   * metacharacters (a quoted `'!(a)'`) renders as the syntax it isn't. Identity —
   * a cache key — must therefore use {@link toGlobString}.
   */
  public toString(): string {
    return this.withFacets(this.renderParts(false), name => name.toString());
  }

  /**
   * @return the name **itself**, as written, with its facets left off: the
   * `<k=v>` constraints and any `-> tmpl` rename say what to do *about* this
   * name (which configuration it applies in, what to call what it selects) and
   * are not part of what it names.
   *
   * This is what to key an index by, and what to compare against a name written
   * somewhere else — so a property declared once per platform is looked up under
   * the one name, while {@link toString} (facets included) is what tells its
   * declarations apart. Renders as {@link toString} does, not as {@link
   * toGlobString}: both sides of such a comparison are as-written text.
   */
  public toBaseString(): string {
    return this.renderParts(false);
  }

  /**
   * @return a string suitable for use with a globbing implementation: literal
   * metacharacters escaped so they match themselves, glob parts live. Also the
   * name's canonical (lossless, re-parseable) form, hence its identity — so a
   * manifest/cache key renders with this and never with {@link toString}.
   */
  public toGlobString(): string {
    return this.withFacets(this.renderParts(true), name => name.toGlobString());
  }
}

/** A literal `/`, for rejoining components into slash-form prefixes
 * ({@link Name.componentPrefixes}). Lives below the class: its initializer
 * constructs a Name at module load. */
const SLASH = Name.fromLiteral(NAME_COMPONENT_SEPARATOR);

/** A resolved REWRITE property: a path to its renamed form, or undefined if no
 * value in the property matched (rule policy decides what that means). */
export type RewriteFn = (name: string) => string | undefined;

/**
 * Compose a {@link RewriteFn} from a REWRITE property's (already substituted)
 * values, first-match-wins in written order: a `sel -> tmpl` value renames
 * selected paths (replaying captures into the rename target), a bare value is a
 * constant every path maps to (multi-entry misuse surfaces later as a rename
 * collision). Pure name logic — the only "resolution" a REWRITE needs is the
 * variable substitution the caller runs before handing the Names here.
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
   * Add the characters from an unquoted string - glob metachars are live and
   * backslash sequences are interpreted as for double-quoted strings
   * (which - note is intentionally different from shell escaping)
   * Recognized metachars are '*', '?', '[]', and the extglob groups
   * '?()', '*()', '+()', '@()' and '!()' — whose leader, '|' separators and
   * closing ')' are each their own glob run, the interior scanned as ordinary
   * name text so wildcards and substitutions work inside a group.
   * @param str
   */
  public appendGlobMetachars(str: string): this {
    this.append(NamePartKind.Glob, str);
    return this;
  }

  /**
   * Add a substitution variable by name.
   */
  public appendSubstVar(str: string): this {
    this.append(NamePartKind.VarSubst, str);
    return this;
  }

  /**
   * Add a command substitution: `text` as written (without the backticks) plus
   * the parsed command, which core carries but never inspects.
   */
  public appendCommandSubst(text: string, command: CommandPipeline): this {
    this.parts.push({ kind: NamePartKind.CommandSubst, value: text, command });
    /* Never a merge candidate, in either direction: two adjacent substitutions
     * are two commands, and concatenating their source texts would make them one
     * (unrunnable) command — so clear `last` rather than pointing it here. */
    this.last = undefined;
    return this;
  }

  public reset(): void {
    this.parts = [];
    this.last = undefined;
  }

  public name(): Name {
    const result = new Name(this.parts);
    this.reset();
    return result;
  }
}

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
 * part matches itself — quoted text, and a `${VAR}` value (which substitutes to
 * a literal, never a glob).
 *
 * The extglob punctuation is escaped even though `(`/`)`/`|` are inert to
 * picomatch outside a group: a quoted `'!(a)'` must name that file, and escaping
 * the `!` alone leaves `(a)` a group. `!` matters on its own account — leading,
 * picomatch reads it as whole-pattern negation, where bash (and fabr) treat a
 * bare `!` as an ordinary character. The extglob *leaders* need no escape here:
 * `?`/`*` are covered as wildcards, and `+`/`@` are only ever special before a
 * `(` that this escapes.
 */
function escapeGlob(str: string): string {
  return str.replaceAll(/([\][\\*?()!|])/g, "\\$1");
}
