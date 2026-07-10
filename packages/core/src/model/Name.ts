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

export enum NamePartKind {
  Literal,
  Glob,
  VarSubst,
}

export interface NamePart {
  kind: NamePartKind;
  value: string;
}

/**
 * name/path components are separated by slash (yes even on windows)
 */
export const NAME_COMPONENT_SEPARATOR = "/";
export const NAME_LEVEL_SEPARATOR = ":";

/**
 * A string expression, potentially consisting of literal, wildcard, and variable substitution parts
 */
/**
 * A single constraint written on a reference (`<KEY=value>`): the key is a
 * scalar config identifier, the value a Name (so it may itself carry a `${subst}`).
 * Kept in written order (see Name.constraints).
 */
export type NameConstraint = readonly [key: string, value: Name];

export class Name {
  private parts: NamePart[];
  /**
   * The constraint delta written on this reference (`ref<KEY=value, ...>`),
   * in written order, or empty. Kept apart from `parts` (which hold only the
   * resolvable base+projection literal): a FILES consumer applies these as a
   * config override when resolving the reference, while `toString` re-renders
   * them so a value used as a plain string round-trips to its original text.
   * Ordered (not a map) precisely so that round-trip is faithful.
   */
  private readonly constraints: readonly NameConstraint[];

  constructor(parts: NamePart[], constraints: readonly NameConstraint[] = []) {
    if (parts.length === 0) {
      this.parts = [{ kind: NamePartKind.Literal, value: "" }];
    } else {
      this.parts = parts;
    }
    this.constraints = constraints;
  }

  /**
   * Construct and return a new name from a simple literal string.
   */
  static fromLiteral(str: string): Name {
    return new Name([{ kind: NamePartKind.Literal, value: str }]);
  }

  /**
   * @return a copy of this name carrying the given constraint delta (replacing
   * any it already had). The parts are unchanged — constraints ride alongside.
   */
  public withConstraints(constraints: readonly NameConstraint[]): Name {
    return new Name(this.parts, constraints);
  }

  /** @return the constraint delta written on this reference (empty if none). */
  public getConstraints(): readonly NameConstraint[] {
    return this.constraints;
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

  public hasVarSubst(): boolean {
    return this.parts.some(part => part.kind === NamePartKind.VarSubst);
  }

  public getVariables(): string[] {
    const own = this.parts.filter(part => part.kind === NamePartKind.VarSubst).map(part => part.value);
    /* Constraint values may themselves reference variables (`<K=${X}>`), which
     * must be resolved before the delta is applied. */
    return this.constraints.reduce<string[]>((vars, [, value]) => vars.concat(value.getVariables()), own);
  }

  /**
   * Replace all substitution variable names with the given values.
   * @param substitutionMap
   * @returns
   */
  public substitute(varNames: string[], values: string[]): Name {
    const substitutionMap = varNames.reduce<Record<string, string>>((result, key, index) => {
      result[key] = values[index];
      return result;
    }, {});

    /* Note: internally we collapse strings down so that afterwards we can treat it as if
     * the subst vars were never there.
     */
    const parts = this.parts.reduce<NamePart[]>((rest, part) => {
      const newPart = part.kind === NamePartKind.VarSubst ? { kind: NamePartKind.Literal, value: substitutionMap[part.value] } : part;
      if (rest.length > 0 && rest[rest.length - 1].kind === newPart.kind) {
        rest[rest.length - 1] = { kind: newPart.kind, value: rest[rest.length - 1].value + newPart.value };
      } else {
        rest.push(newPart);
      }
      return rest;
    }, []);

    /* Constraint values are substituted too (they share the variable space), so
     * `<K=${X}>` resolves before the delta is applied / rendered. */
    const constraints = this.constraints.map<NameConstraint>(([key, value]) => [key, value.substitute(varNames, values)]);
    return new Name(parts, constraints);
  }

  /**
   * If the name starts with a literal component return that component, otherwise return
   * the empty string.
   */
  public getLiteralPrefix(): string {
    return this.parts[0].kind === NamePartKind.Literal ? this.parts[0].value : "";
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

  public substring(start: number): Name {
    const [head, ...parts] = this.parts;
    if (head.kind === NamePartKind.Literal && (head.value.length >= start || parts.length === 0)) {
      const rest = head.value.substring(start);
      if (rest === "") {
        return new Name(parts);
      } else {
        return new Name([{ kind: NamePartKind.Literal, value: rest }, ...parts]);
      }
    }
    return new Name([head, ...parts]);
  }

  /**
   * @return a new name with the given initial literal prefix added to the name.
   */
  public withPrefix(prefix: string): Name {
    if (this.parts[0].kind === NamePartKind.Literal) {
      const [head, ...rest] = this.parts;
      return new Name([{ kind: NamePartKind.Literal, value: prefix + head.value }, ...rest]);
    } else {
      return new Name([{ kind: NamePartKind.Literal, value: prefix }, ...this.parts]);
    }
  }

  /**
   * @return a new name with the dirname of filename prepended to the receiver.
   * e.g. given the Name "mylib/lib/*" and filename "src/lib/BUILD.fabr", returns
   * the Name "src/lib/mylib/lib/*".
   *
   * If the filename does not have a dirname (e.g. "foo"), the original name is returned
   * unmodified.
   *
   * Note: Does not attempt to interpret "." or ".."
   * @param filename
   */
  public relativeTo(filename: string): Name {
    const idx = filename.lastIndexOf(NAME_COMPONENT_SEPARATOR);
    if (idx === -1 || idx === 0) {
      return this;
    } else {
      return this.withPrefix(filename.substring(0, idx + 1));
    }
  }

  /**
   * As getLiteralPrefix, but excludes the final path component if it contains a non-literal part.
   * If the name does not have a literal path prefix, returns the empty string.
   *
   * e.g. "src/bar/foo*.ts" => "src/bar"
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
      return idx === -1 ? "" : prefix.substring(0, idx);
    }
  }

  /**
   * @return a string suitable for use with a globbing implementation (ie with literal metacharacters escaped).
   */
  public toString(): string {
    const base = this.parts.reduce((result, part) => {
      switch (part.kind) {
        case NamePartKind.Literal:
          return result + escapeGlob(part.value);
        case NamePartKind.Glob:
          return result + part.value;
        case NamePartKind.VarSubst:
          return result + "${" + part.value + "}";
      }
    }, "");
    if (this.constraints.length === 0) {
      return base;
    }
    /* Re-render the delta so a value used as a plain string reproduces its
     * original text (`foo<a=b, c=d>`). */
    const delta = this.constraints.map(([key, value]) => `${key}=${value.toString()}`).join(", ");
    return `${base}<${delta}>`;
  }
}

export class NameBuilder {
  private parts: NamePart[] = [];
  private last: NamePart | undefined = undefined;

  private append(kind: NamePartKind, value: string): this {
    if (value === "") {
      return this;
    } else if ((kind !== NamePartKind.VarSubst, this.last?.kind === kind)) {
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
   * Currently recognized metachars are '*', '?', and '[]'
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

function escapeGlob(str: string): string {
  return str.replaceAll(/([\][\\*?])/g, "\\$1");
}
