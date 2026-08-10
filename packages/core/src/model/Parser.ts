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

import { StringReader } from "../support/StringReader";
import { isWhiteSpace as isWhiteSpaceChar, isAlphabetic, isDigit } from "unicode-properties";
import {
  DeclKind,
  IBuildFile,
  IBuildFileContents,
  IDefaultableDecl,
  IIncludeDecl,
  IMapItemDecl,
  IPluginDecl,
  IPropertyDecl,
  ICommandStage,
  ICommandValue,
  INameValue,
  IPropertySchema,
  isMapValue,
  isNameValue,
  ITargetDecl,
  ITargetDefDecl,
  IValue,
  PropertyType,
} from "./AST";
import { Diagnostic, ISourcePosition, Log, LogLevel } from "../support/Log";
import { Name, NameBuilder, NameConstraint } from "../core/Name";
import { EMPTY_FILESET, FileSource } from "../core/FileSet";

/**
 * The three name tiers form a widening ladder, classified purely by the
 * characters a bare token contains — narrowest first:
 *
 * - `IDENTIFIER` — `@`/`_`/alphanumeric only. The tier for things the grammar
 *   NAMES atomically: keywords, property names, constraint keys, target *types*.
 * - `SIMPLE_NAME` — IDENTIFIER plus interior `/`, `-`, `.` (`@fabr-build/js`,
 *   `my-target`, `lib/utils`, `lodash.merge`). The tier for a *declared name* or
 *   a simple path — anything the grammar accepts as its own name — and the base
 *   of a reference that carries no `:`.
 * - `NAME` — anything wider: contains `:` (a reference/projection separator, so
 *   `@npm:pkg:1.2.3`) or a glob char (`* ? [`). This is the "reference-ish" tier;
 *   a declared name is deliberately NOT allowed to reach it (`foo:bar` as a target
 *   name would collide with projecting `bar` out of target `foo`).
 *
 * The tiers classify only the BARE token. A reference's `<constraint>` /
 * `-> rename` facets are their own tokens (`LANGLE`/`ARROW`) that
 * {@link Parser.parseReference} layers onto a base of any of these three tiers —
 * so "a full reference = base + facets" is a parse-level structure, not a
 * property of the base token's tier.
 */
enum TokenType {
  EOF = 0,
  IDENTIFIER,
  SIMPLE_NAME,
  NAME,
  EQUALS,
  LBRACE,
  RBRACE,
  LANGLE,
  RANGLE,
  COMMA,
  SEMI,
  ARROW,
  /* Command-pipeline operators (a `COMMAND` property value). `<` stdin and `>`
   * stdout reuse LANGLE/RANGLE (disambiguated from a `<k=v>` constraint by not
   * abutting); these are the forms that need their own token: the pipe, and the
   * fd-prefixed redirects `2>`/`1>`/`&>` (recognized by an abutting `2`/`1`/`&`). */
  PIPE,
  REDIR_STDOUT,
  REDIR_STDERR,
  REDIR_BOTH,
  ERROR = -1,
}

const CHAR_EQUALS = "=".codePointAt(0);
const CHAR_LBRACE = "{".codePointAt(0);
const CHAR_RBRACE = "}".codePointAt(0);
const CHAR_LANGLE = "<".codePointAt(0);
const CHAR_RANGLE = ">".codePointAt(0);
const CHAR_COMMA = ",".codePointAt(0);
const CHAR_SEMI = ";".codePointAt(0);
const CHAR_SLASH = "/".codePointAt(0);
const CHAR_BACKSLASH = "\\".codePointAt(0);
const CHAR_QUOTE = "'".codePointAt(0);
const CHAR_DQUOTE = '"'.codePointAt(0);
const CHAR_DOLLAR = "$".codePointAt(0);
const CHAR_NEWLINE = "\n".codePointAt(0);
const CHAR_UNDERSCORE = "_".codePointAt(0);
const CHAR_STAR = "*".codePointAt(0);
const CHAR_QUESTION = "?".codePointAt(0);
const CHAR_LSQUARE = "[".codePointAt(0);
const CHAR_RSQUARE = "]".codePointAt(0);
const CHAR_AT = "@".codePointAt(0);
const CHAR_HASH = "#".codePointAt(0);
const CHAR_DASH = "-".codePointAt(0);
const CHAR_DOT = ".".codePointAt(0);
const CHAR_COLON = ":".codePointAt(0);
const CHAR_PIPE = "|".codePointAt(0);
const CHAR_LPAREN = "(".codePointAt(0);
const CHAR_RPAREN = ")".codePointAt(0);
const CHAR_BANG = "!".codePointAt(0);
const CHAR_PLUS = "+".codePointAt(0);

interface TokenBase {
  start: number;
  /** The doc-comment block immediately preceding this token (the last contiguous
   * run of `#` comment lines before it, marker-stripped), or undefined if none.
   * Decl parsers read it off the token that begins a declaration to attach its
   * documentation. */
  docComment?: string;
}

interface NameToken extends TokenBase {
  type: TokenType.NAME;
  text: Name;
}

interface IdentToken extends TokenBase {
  type: TokenType.IDENTIFIER | TokenType.SIMPLE_NAME;
  text: string;
}

interface NonNameToken extends TokenBase {
  type: Exclude<TokenType, TokenType.NAME | TokenType.IDENTIFIER | TokenType.SIMPLE_NAME>;
}

type Token = NameToken | IdentToken | NonNameToken;

const TOKEN_NAME_MAP = {
  [TokenType.EOF]: "EOF",
  [TokenType.NAME]: "Name",
  [TokenType.IDENTIFIER]: "Identifier",
  [TokenType.SIMPLE_NAME]: "Name",
  [TokenType.EQUALS]: "'='",
  [TokenType.LBRACE]: "'{'",
  [TokenType.RBRACE]: "'}'",
  [TokenType.LANGLE]: "'<'",
  [TokenType.RANGLE]: "'>'",
  [TokenType.COMMA]: "','",
  [TokenType.SEMI]: "';'",
  [TokenType.ARROW]: "'->'",
  [TokenType.PIPE]: "'|'",
  [TokenType.REDIR_STDOUT]: "'1>'",
  [TokenType.REDIR_STDERR]: "'2>'",
  [TokenType.REDIR_BOTH]: "'&>'",
  [TokenType.ERROR]: "ERROR",
};

/** The redirect token for each fd-prefix word abutting `>` (`1>`/`2>`/`&>`). */
const REDIR_FD_TOKEN: Record<string, TokenType.REDIR_STDOUT | TokenType.REDIR_STDERR | TokenType.REDIR_BOTH> = {
  "1": TokenType.REDIR_STDOUT,
  "2": TokenType.REDIR_STDERR,
  "&": TokenType.REDIR_BOTH,
};

/** A pipeline operator recognised while parsing a property value. `Stdin`/`Stdout`
 * are the spaced `<`/`>`; `Stderr`/`Both` the `2>`/`&>` folds; `Pipe` the stage
 * separator. Parser-internal — the folded {@link ICommandValue} names its streams
 * directly, so this kind never escapes the parser. */
const enum CommandOpKind {
  Pipe,
  Stdin,
  Stdout,
  Stderr,
  Both,
}

/** A pipeline operator with its source offset (for positioned errors). */
type CommandOp = { op: CommandOpKind; at: number };

const OP_SYMBOL: Record<CommandOpKind, string> = {
  [CommandOpKind.Pipe]: "|",
  [CommandOpKind.Stdin]: "<",
  [CommandOpKind.Stdout]: ">",
  [CommandOpKind.Stderr]: "2>",
  [CommandOpKind.Both]: "&>",
};

/** The "missing target" message for a dangling redirect operator, naming it. */
function missingTarget(op: CommandOpKind): string {
  return `redirect '${OP_SYMBOL[op]}' must be followed by a target name`;
}

function isWhitespace(ch: number): boolean {
  // unicode-properties' isWhiteSpace covers space and the Unicode Zs category
  // but NOT the ASCII control whitespace (TAB, LF, VT, FF, CR = 0x09–0x0D), so
  // this is the full POSIX [[:space:]] set: tab-indented and CRLF files parse.
  return (ch >= 0x09 && ch <= 0x0d) || isWhiteSpaceChar(ch);
}

/** The `->` arrow must be whitespace-delimited: what may follow the `>`. */
function isArrowTerminator(ch: number | undefined): boolean {
  return ch === undefined || isWhitespace(ch);
}

/**
 * Extract the doc-comment block from the whitespace/comment `gap` that precedes
 * a token: the *last contiguous* run of `#` comment lines, reached across only
 * blank lines between it and the token. So a comment block directly above a
 * declaration — or one separated from it by blank lines — attaches, while an
 * earlier banner or note (itself blank-line-separated from the block) does not.
 * Each line is stripped of its leading whitespace, `#` marker and one following
 * space; blank marker lines at the block's edges are trimmed. Returns the prose
 * (lines joined with newlines) or undefined if the gap holds no comment block.
 * A trailing comment sharing a declaration's line (`x = y; # note`) is
 * indistinguishable from a standalone one here and would mis-attach; the lib
 * files place doc comments on their own lines, so this is not a concern.
 */
function extractDocComment(gap: string): string | undefined {
  const lines = gap.split("\n");
  let i = lines.length - 1;
  /* Skip trailing blank lines: the blank separator(s) and the token's own
   * leading indentation on its line. */
  while (i >= 0 && lines[i].trim() === "") {
    i--;
  }
  /* Collect the contiguous run of comment lines ending here (stopping at the
   * first blank/non-comment line above, which cuts off any earlier block). */
  const block: string[] = [];
  while (i >= 0 && lines[i].trim().startsWith("#")) {
    block.unshift(lines[i].replace(/^\s*#+ ?/, ""));
    i--;
  }
  /* Drop blank marker lines (`#`) framing the prose. */
  while (block.length > 0 && block[0].trim() === "") {
    block.shift();
  }
  while (block.length > 0 && block[block.length - 1].trim() === "") {
    block.pop();
  }
  return block.length > 0 ? block.join("\n") : undefined;
}

function isFirstIdentChar(ch: number): boolean {
  return isAlphabetic(ch) || ch === CHAR_UNDERSCORE || ch === CHAR_AT;
}

/* The interior char classes behind the {@link TokenType} name tiers. IDENTIFIER
 * and SIMPLE_NAME both start like an identifier; SIMPLE_NAME's extras (`/ - .`)
 * are interior-only, so a leading `.`/`-`/`/` (a relative include `./x`, a
 * version `1.2.3`) stays a NAME. `:` is NOT a SIMPLE_NAME char — it bumps a token
 * to the NAME tier (see the {@link TokenType} doc). */
function isIdentChar(ch: number): boolean {
  return isFirstIdentChar(ch) || isDigit(ch);
}

function isSimpleNameChar(ch: number): boolean {
  return isIdentChar(ch) || ch === CHAR_SLASH || ch === CHAR_DASH || ch === CHAR_DOT;
}

function* codepoints(text: string): Generator<number> {
  let index = 0;
  while (true) {
    const result = text.codePointAt(index);
    if (!result) {
      break;
    }
    index += result <= 0xffff ? 1 : 2;
    yield result;
  }
}

function isIdentifier(text?: string): text is string {
  if (!text) {
    return false;
  }
  const first = text.codePointAt(0);
  if (first === undefined || !isFirstIdentChar(first)) return false;
  for (const code of codepoints(text)) {
    if (!isIdentChar(code)) return false;
  }
  return true;
}

/** True iff `text` is a SIMPLE_NAME: starts like an identifier, body is
 * identifier chars plus `/`, `-`, `.` (a superset of {@link isIdentifier}). */
function isSimpleName(text: string): boolean {
  const first = text.codePointAt(0);
  if (first === undefined || !isFirstIdentChar(first)) return false;
  for (const code of codepoints(text)) {
    if (!isSimpleNameChar(code)) return false;
  }
  return true;
}

/**
 * How deep `{ ... }` blocks may nest — the block grammar being the parser's one
 * unbounded recursion (a map value is a block, whose entries are values). Far
 * above anything a real build file reaches: it only decides that a pathological
 * file gets a positioned diagnostic rather than a stack-overflow RangeError.
 */
const MAX_BLOCK_DEPTH = 100;

const DIAG_PARSE_ERROR = new Diagnostic<{ actual: string; expected: string; loc: ISourcePosition }>(
  LogLevel.Error,
  "Read {actual} but expected {expected}"
);
const DIAG_DUP_CONSTRAINT = new Diagnostic<{ key: string; loc: ISourcePosition }>(
  LogLevel.Error,
  "Duplicate constraint key '{key}'"
);
const DIAG_UNEXPECTED_EOF = new Diagnostic<{ expected: string; loc: ISourcePosition }>(
  LogLevel.Error,
  "Unexpected end of file, expected {expected}"
);
const DIAG_RENAME_TEMPLATE = new Diagnostic<{ detail: string; loc: ISourcePosition }>(
  LogLevel.Error,
  "Invalid rename template: {detail}"
);
const DIAG_INVALID_COMMAND = new Diagnostic<{ detail: string; loc: ISourcePosition }>(
  LogLevel.Error,
  "Invalid command: {detail}"
);
const DIAG_INVALID_INCLUDE = new Diagnostic<{ detail: string; loc: ISourcePosition }>(
  LogLevel.Error,
  "Invalid include name: {detail}"
);
const DIAG_ABSOLUTE_INCLUDE = new Diagnostic<{ loc: ISourcePosition }>(
  LogLevel.Error,
  "Include paths must be relative to the including file"
);
const DIAG_INVALID_PLUGIN = new Diagnostic<{ loc: ISourcePosition }>(
  LogLevel.Error,
  "Plugin names must be plain target names (no glob patterns or variables)"
);
const DIAG_DUP_SCHEMA_KEY = new Diagnostic<{ key: string; loc: ISourcePosition }>(
  LogLevel.Error,
  "Duplicate property '{key}' in targetdef"
);
const DIAG_REQUIRED_DEFAULT = new Diagnostic<{ key: string; loc: ISourcePosition }>(
  LogLevel.Error,
  "Property '{key}' cannot be both REQUIRED and have a default"
);
const DIAG_WILDCARD_DEFAULT = new Diagnostic<{ loc: ISourcePosition }>(
  LogLevel.Error,
  "The '*' wildcard cannot have a default (it types only keys that are written)"
);
const DIAG_DEFAULT_BEFORE_TYPE = new Diagnostic<{ key: string; loc: ISourcePosition }>(
  LogLevel.Error,
  "Property '{key}' declares 'default' before its type — write the type first ('{key} = FILES default …;')"
);
const DIAG_NESTING_TOO_DEEP = new Diagnostic<{ loc: ISourcePosition }>(
  LogLevel.Error,
  `Block nesting is too deep (limit ${MAX_BLOCK_DEPTH})`
);
const DIAG_UNTERMINATED_EXTGLOB = new Diagnostic<{ leader: string; loc: ISourcePosition }>(
  LogLevel.Error,
  "Unterminated extglob group '{leader}', expected ')' (quote it to match literally)"
);

/** Whether a name IS the bare `*` wildcard — one glob unit of `*` and no literal
 * text — as opposed to a quoted `'*'`, which is that literal character. */
function isWildcardKey(name: Name): boolean {
  const units = name.getGlobUnits();
  return units.length === 1 && units[0] === "*" && name.toString() === "*";
}

/**
 * Check that the number + kind of wildcards in a rename pattern match (ie we need
 * the same number on both sides, and glob only).
 *
 * @return error message on failure, otherwise undefined.
 */
function checkRenameWildcards(selector: Name, template: Name): string | undefined {
  const selectorUnits = selector.getGlobUnits();
  const templateUnits = template.getGlobUnits();
  const bad = [...selectorUnits, ...templateUnits].find(unit => unit !== "*" && unit !== "**");
  if (bad !== undefined) {
    return `rename wildcards must be '*' or '**' (found '${bad}')`;
  }
  if (selectorUnits.length !== templateUnits.length) {
    return `selector and template must have equal wildcard counts (${selectorUnits.length} vs ${templateUnits.length})`;
  }
  return undefined;
}

const PARSE_ERROR = "Parse Error";

/**
 * Parse a single build file at a time (without resolving anything).
 *
 * Note this combines lexer + parser.
 */
export class BuildParser {
  private reader: StringReader;
  private log: Log;
  private token: Token;
  /**
   * Whether the current token immediately abuts the previous one (no intervening
   * whitespace). Used to keep a constrained/projected reference atomic: a `<...>`
   * constraint delta or a `:projection` tail only binds to a ref if it hugs it.
   */
  private tokenAbutsPrev = false;
  /** End offset (exclusive) of the most recently consumed token */
  private prevTokenEnd = 0;
  /** Suppress the fd-redirect token fold (`1>`, `2>`) while lexing inside a `<k=v>`
   * constraint: there a `>` closes the constraint, so a numeric value like
   * `<X=1>` must lex as value `1` + `>`, not the redirect `1>`. */
  private suppressRedirect = false;
  /** Current `{ ... }` block nesting, bounded by {@link MAX_BLOCK_DEPTH}. */
  private blockDepth = 0;

  private source: IBuildFile;
  private result: IBuildFileContents;

  constructor(source: IBuildFile, log: Log) {
    this.reader = source.reader;
    this.log = log;
    this.token = { type: TokenType.ERROR, start: 0 };
    this.source = source;
    this.result = {
      namespaces: [],
      targets: [],
      targetdefs: [],
      properties: [],
      defaults: [],
      includes: [],
      plugins: [],
    };
    this.nextToken();
  }

  /* Single quotes consume everything until the next single quote (which is
   * consumed too). Note: currently this will allow new-lines inside the quote.
   * @param builder NameBuilder to receive the quoted content
   */
  private readSingleQuotedString(builder?: NameBuilder): void {
    const quoteStart = this.reader.currentOffset();
    this.reader.consume(CHAR_QUOTE);
    const start = this.reader.currentOffset();
    const next = this.reader.skipUntil(ch => ch === CHAR_QUOTE);
    if (next === undefined) {
      this.unexpectedEndOfFile("'", quoteStart);
    }
    builder?.appendLiteralString(this.reader.substring(start));
    this.reader.next(); /* Consume the closing quote */
  }

  /* Double quotes can contain variables (which can contain double quotes).
   * Consumes everything up to and including the closing quote. */
  private readDoubleQuotedString(builder?: NameBuilder): void {
    const quoteStart = this.reader.currentOffset();
    this.reader.consume(CHAR_DQUOTE);
    let posn = this.reader.currentOffset();
    const next = this.reader.scanUntil(ch => {
      switch (ch) {
        case CHAR_BACKSLASH:
          this.reader.next(); /* the backslash */
          this.reader.next(); /* the escaped character */
          break;
        case CHAR_DOLLAR:
          builder?.appendEscapedString(this.reader.substring(posn));
          this.readSubstVar(builder);
          posn = this.reader.currentOffset();
          break;
        case CHAR_DQUOTE:
          return true;
      }
      return false;
    });
    if (next === undefined) {
      this.unexpectedEndOfFile('"', quoteStart);
    }
    builder?.appendEscapedString(this.reader.substring(posn));
    this.reader.next(); /* Consume the closing quote */
  }

  /* Reads a variable substitution ('$NAME' or '${NAME}'), consuming the whole
   * construct: on return the reader is at the first character after it. */
  private readSubstVar(builder?: NameBuilder): void {
    const next = this.reader.consume(CHAR_DOLLAR);
    if (next !== CHAR_LBRACE) {
      const posn = this.reader.currentOffset();
      this.reader.skipUntil(ch => !isAlphabetic(ch) && !isDigit(ch) && ch !== CHAR_UNDERSCORE);
      const str = this.reader.substring(posn);
      if (str.length === 0) {
        /* Terminal '$' is just treated as a literal $ */
        builder?.appendLiteralString("$");
      } else {
        builder?.appendSubstVar(str);
      }
    } else {
      this.reader.consume(CHAR_LBRACE);
      const posn = this.reader.currentOffset();
      /* TODO: currently we don't try to parse out the contents of the substitution */
      const inner = this.reader.scanUntil(ch => {
        switch (ch) {
          case CHAR_BACKSLASH:
            this.reader.next(); /* the backslash */
            this.reader.next(); /* the escaped character */
            break;
          case CHAR_DOLLAR:
            this.readSubstVar();
            break;
          case CHAR_DQUOTE:
            this.readDoubleQuotedString();
            break;
          case CHAR_RBRACE:
            return true;
        }
        return false;
      });
      if (inner === undefined) {
        this.unexpectedEndOfFile("}");
      }
      builder?.appendSubstVar(this.reader.substring(posn));
      this.reader.next(); /* Consume the closing brace */
    }
  }

  private readCharClass(builder?: NameBuilder): void {
    const start = this.reader.currentOffset();
    const next = this.reader.consume(CHAR_LSQUARE);
    if (next === CHAR_RSQUARE) {
      this.reader.next(); /* a ']' right after '[' (or '[^') is a literal member */
    }
    /* Scan to the closing ']'. The contents are literal characters — there is no
     * variable substitution inside a class (a '$' here matches a literal '$').
     * The one structured element is a POSIX class ('[:alpha:]', '[.coll.]',
     * '[=e=]'): consume it whole so its inner ':]' / '.]' / '=]' isn't mistaken
     * for the class close. The whole span is handed to picomatch, which supports
     * these forms. */
    const last = this.reader.scanUntil(ch => {
      if (ch === CHAR_LSQUARE) {
        const len = this.posixClassLength();
        for (let i = 0; i < len; i++) {
          this.reader.next();
        }
        return false;
      }
      return ch === CHAR_RSQUARE;
    });
    if (last === undefined) {
      this.unexpectedEndOfFile("]");
    }
    this.reader.next();
    builder?.appendGlobMetachars(this.reader.substring(start));
  }

  /* Pure lookahead: if the reader is at the '[' of a well-formed POSIX class
   * element ('[:name:]', '[.coll.]', '[=equiv=]'), return its full length
   * including both brackets, else 0. A form is well-formed only if its own
   * closing '<kind>]' is reached before a bare ']' (the enclosing class close)
   * or end-of-input — so a stray '[' inside a class stays a literal member. */
  private posixClassLength(): number {
    const kind = this.reader.peekAt(1);
    if (kind !== CHAR_COLON && kind !== CHAR_DOT && kind !== CHAR_EQUALS) {
      return 0;
    }
    for (let d = 2; ; d++) {
      const ch = this.reader.peekAt(d);
      if (ch === undefined || ch === CHAR_RSQUARE) {
        return 0;
      }
      if (ch === kind && this.reader.peekAt(d + 1) === CHAR_RSQUARE) {
        return d + 2;
      }
    }
  }

  private readNameOrIdentifier(): Token {
    const start = this.reader.currentOffset();
    const nameBuilder = new NameBuilder();
    let maybeIdent = true;
    /* Open extglob groups (`!(`, `@(` …): their depth, and the offset of the
     * outermost one, for the unterminated diagnostic. Only inside a group are
     * `)` and `|` structural — at depth 0 both are ordinary name characters. */
    let extglobDepth = 0;
    let extglobStart = 0;
    /* Expect current character is not whitespace or a special character.
     * Quoted strings, substitutions and character classes consume themselves
     * whole (the scan only advances past characters they leave in place). */
    let posn = this.reader.currentOffset();
    /* Emit an extglob leader — the two characters `X(` as one glob run — and
     * enter the group. The interior is scanned normally, so wildcards, quoted
     * strings and `${...}` substitutions all work inside one, as in bash. */
    const openExtglob = (leader: number): void => {
      maybeIdent = false;
      nameBuilder.appendEscapedString(this.reader.substring(posn));
      if (extglobDepth++ === 0) {
        extglobStart = this.reader.currentOffset();
      }
      nameBuilder.appendGlobMetachars(String.fromCodePoint(leader) + "(");
      this.reader.next(); /* the leader */
      this.reader.next(); /* the '(' */
      posn = this.reader.currentOffset();
    };
    this.reader.scanUntil(ch => {
      if (isWhitespace(ch)) {
        return true;
      }
      switch (ch) {
        case CHAR_BACKSLASH:
          maybeIdent = false;
          this.reader.next(); /* the backslash */
          this.reader.next(); /* the escaped character */
          break;
        case CHAR_QUOTE:
          maybeIdent = false;
          nameBuilder.appendEscapedString(this.reader.substring(posn));
          this.readSingleQuotedString(nameBuilder);
          posn = this.reader.currentOffset();
          break;
        case CHAR_DQUOTE:
          maybeIdent = false;
          nameBuilder.appendEscapedString(this.reader.substring(posn));
          this.readDoubleQuotedString(nameBuilder);
          posn = this.reader.currentOffset();
          break;
        case CHAR_DOLLAR:
          maybeIdent = false;
          nameBuilder.appendEscapedString(this.reader.substring(posn));
          this.readSubstVar(nameBuilder);
          posn = this.reader.currentOffset();
          break;
        case CHAR_STAR:
        case CHAR_QUESTION:
          /* `*` and `?` are wildcards on their own, extglob leaders before a `(`
           * (`*(a|b)`, `?(a|b)`) — the `**(` case reads as `*` then `*(`, as in
           * bash. */
          if (this.reader.peekAt(1) === CHAR_LPAREN) {
            openExtglob(ch);
            break;
          }
          maybeIdent = false;
          nameBuilder.appendEscapedString(this.reader.substring(posn));
          nameBuilder.appendGlobMetachars(String.fromCodePoint(ch));
          posn = this.reader.currentOffset() + 1;
          break;
        case CHAR_BANG:
        case CHAR_PLUS:
        case CHAR_AT:
          /* Extglob leaders only when a `(` abuts. Everywhere else all three are
           * ordinary name characters (`@npm:pkg`, a `1.0.0+build` version) — a
           * bare `!` in particular is literal, as in bash, NOT the whole-pattern
           * negation picomatch would otherwise read it as (see escapeGlob). */
          if (this.reader.peekAt(1) === CHAR_LPAREN) {
            openExtglob(ch);
          }
          break;
        case CHAR_RPAREN:
        case CHAR_PIPE:
          /* Structural only inside an extglob group: `)` closes it and `|`
           * separates its alternatives. At depth 0 both are literal name
           * characters, so an unparenthesized `a|b` still names that file. */
          if (extglobDepth === 0) {
            break;
          }
          maybeIdent = false;
          nameBuilder.appendEscapedString(this.reader.substring(posn));
          nameBuilder.appendGlobMetachars(String.fromCodePoint(ch));
          posn = this.reader.currentOffset() + 1;
          if (ch === CHAR_RPAREN) {
            extglobDepth--;
          }
          break;
        case CHAR_LSQUARE:
          maybeIdent = false;
          nameBuilder.appendEscapedString(this.reader.substring(posn));
          this.readCharClass(nameBuilder);
          posn = this.reader.currentOffset();
          break;
        case CHAR_COMMA:
        case CHAR_EQUALS:
        case CHAR_LBRACE:
        case CHAR_RBRACE:
        case CHAR_SEMI:
        case CHAR_LANGLE:
        case CHAR_RANGLE:
        case CHAR_HASH:
          return true;
      }
      return false;
    });

    /* A group left open at the end of the name is a typo, not a literal: bash
     * would silently degrade `!(a` to plain text, but a build script says what
     * it means, and the `[...]` class — the parallel construct — already errors
     * unterminated. Quoting remains the way to name such a file. */
    if (extglobDepth > 0) {
      this.unterminatedExtglobError(extglobStart);
    }

    const rest = this.reader.substring(posn);
    if (maybeIdent) {
      /* Nothing was added to the nameBuilder (a pure literal), so classify the
       * whole string by its narrowest tier: a bare identifier, else a simple
       * name (adds `/`, `-`, `.`), else a NAME (anything with `:` etc.). */
      if (isIdentifier(rest)) {
        return { type: TokenType.IDENTIFIER, text: rest, start };
      } else if (isSimpleName(rest)) {
        return { type: TokenType.SIMPLE_NAME, text: rest, start };
      }
    }

    nameBuilder.appendEscapedString(rest);
    return { type: TokenType.NAME, text: nameBuilder.name(), start };
  }

  /**
   * Parse the whole source as a single name expression — glob metachars,
   * quotes and substitutions handled exactly as in a build file. Used for
   * command-line names (`fabr cat pkg:build/*.js`), so the CLI reuses the model's
   * reference semantics rather than re-implementing the `:` / glob split.
   */
  public parseName(): Name {
    /* The constructor already primed the first token */
    const token = this.token;
    if (token.type === TokenType.NAME || token.type === TokenType.IDENTIFIER || token.type === TokenType.SIMPLE_NAME) {
      /* Reuse the build-file reference grammar so a CLI name carries the same
       * `<k=v>` constraints and `:projection` semantics. */
      const name = this.parseReference();
      /* A CLI name is the whole input: trailing tokens (e.g. a space before a
       * `<...>` delta, which then doesn't abut and would be silently dropped)
       * are an error, not ignored. */
      if (this.token.type !== TokenType.EOF) {
        this.unexpectedTokenError("end of input");
      }
      return name;
    }
    /* Empty input or a leading operator: preserve the prior empty-name result. */
    return Name.fromLiteral("");
  }

  private nextToken(): Token {
    const start = this.reader.currentOffset();
    /* The reader sits just past the previous token, so this is its end —
     * kept for span extents (a value's endOffset) */
    this.prevTokenEnd = start;

    /* Skip over whitespace and comments */
    let inComment = false;
    let sawComment = false;
    const ch = this.reader.skipUntil(ch => {
      if (inComment) {
        if (ch === CHAR_NEWLINE) {
          inComment = false;
        }
        return false;
      } else if (ch === CHAR_HASH) {
        inComment = true;
        sawComment = true;
        return false;
      } else {
        return !isWhitespace(ch);
      }
    });

    /* `start` was captured at the end of the previous token (before any
     * whitespace here); the real token begins here, past the skipped gap. If the
     * two coincide, this token abuts the previous with no gap. Operators and EOF
     * must be positioned at `tokenStart`, not `start` — otherwise a diagnostic
     * anchored on them points at the start of the *preceding whitespace* rather
     * than the token (name tokens already recapture this in readNameOrIdentifier). */
    const tokenStart = this.reader.currentOffset();
    this.tokenAbutsPrev = tokenStart === start;

    switch (ch) {
      case undefined:
        this.token = { type: TokenType.EOF, start: tokenStart };
        break;
      case CHAR_EQUALS:
        this.reader.next();
        this.token = { type: TokenType.EQUALS, start: tokenStart };
        break;
      case CHAR_LBRACE:
        this.reader.next();
        this.token = { type: TokenType.LBRACE, start: tokenStart };
        break;
      case CHAR_RBRACE:
        this.reader.next();
        this.token = { type: TokenType.RBRACE, start: tokenStart };
        break;
      case CHAR_LANGLE:
        this.reader.next();
        this.token = { type: TokenType.LANGLE, start: tokenStart };
        break;
      case CHAR_RANGLE:
        this.reader.next();
        this.token = { type: TokenType.RANGLE, start: tokenStart };
        break;
      case CHAR_COMMA:
        this.reader.next();
        this.token = { type: TokenType.COMMA, start: tokenStart };
        break;
      case CHAR_SEMI:
        this.reader.next();
        this.token = { type: TokenType.SEMI, start: tokenStart };
        break;
      case CHAR_PIPE:
        this.reader.next();
        this.token = { type: TokenType.PIPE, start: tokenStart };
        break;
      case CHAR_DASH:
        /* A whitespace-delimited `->` is the rename ARROW (`sel -> tmpl`); a `-`
         * anywhere else stays a name char. The leading gap is guaranteed (this
         * runs at a token start), so we only require `>` to abut and a
         * whitespace/EOF terminator after it. `sel-> x` never reaches here — the
         * NAME read swallows `-` and stops at `>` (RANGLE), a parse error the
         * value parser flags with a spacing hint. */
        if (this.reader.peekAt(1) === CHAR_RANGLE && isArrowTerminator(this.reader.peekAt(2))) {
          this.reader.next(); /* the '-' */
          this.reader.next(); /* the '>' */
          this.token = { type: TokenType.ARROW, start: tokenStart };
          break;
        }
        this.token = this.readNameOrIdentifier();
        break;
      default:
        /* It's a NAME */
        this.token = this.readNameOrIdentifier();
    }
    /* Fold an fd-prefixed redirect: a bare `1`/`2`/`&` word immediately followed
     * (no space — the name read stopped at the `>`) by `>` is one redirect
     * operator (`2>`, `&>`), not a word then `>`. A spaced `2 >` stays a `2`
     * argument plus a `>` redirect, as in a shell. Only meaningful in a command
     * value; Validate rejects a redirect elsewhere. */
    const fd = this.redirectFdText();
    if (!this.suppressRedirect && fd !== undefined && this.reader.current() === CHAR_RANGLE) {
      this.reader.next(); /* the '>' */
      this.token = { type: REDIR_FD_TOKEN[fd], start: this.token.start };
    }
    /* Attach any doc-comment block from the gap just skipped to this token, so a
     * decl parser can read the documentation written above the declaration. */
    if (sawComment) {
      const docComment = extractDocComment(this.reader.substring(start, tokenStart));
      if (docComment !== undefined) {
        this.token.docComment = docComment;
      }
    }
    return this.token;
  }

  private consumeToken(type: TokenType): Token {
    if (this.token.type !== type) {
      this.unexpectedTokenError(TOKEN_NAME_MAP[type]);
    } else {
      return this.nextToken();
    }
  }

  private consumeIfToken(type: TokenType): boolean {
    if (this.token.type === type) {
      this.nextToken();
      return true;
    }
    return false;
  }

  /**
   * IncludeDecl ::= 'include' NAME ';'
   *
   * The name is a path relative to the including file, which may **glob**
   * (`include rules/*.fabr;`) — naming every file that matches, none being no
   * error. Variables are not: which files make up the model must be readable
   * from the build files themselves, never from a value that varies by config.
   */
  private parseIncludeDecl(): IIncludeDecl {
    const token = this.token;
    if (token.type === TokenType.IDENTIFIER || token.type === TokenType.SIMPLE_NAME || token.type === TokenType.NAME) {
      const name = typeof token.text === "string" ? Name.fromLiteral(token.text) : token.text;
      /* Lexically, either platform's absolute form — a .fabr file must parse the
       * same everywhere, so this doesn't ride the host's path.isAbsolute. Ahead of
       * the reference-syntax check below, so a Windows path is reported as the
       * absolute path it is rather than for its drive-letter colon. */
      const head = name.getLiteralPrefix();
      if (head.startsWith("/") || /^[A-Za-z]:[\\/]/.test(head)) {
        this.absoluteIncludeName();
      } else if (name.hasVarSubst()) {
        this.invalidIncludeName("variables are not permitted");
      } else if (name.hasLevelSeparator()) {
        /* A bare name token carries no `<...>`/`-> ` facet (only parseReference
         * layers those on), so `:` is the whole of reference syntax reachable here. */
        this.invalidIncludeName("an include names a path, not a reference");
      } else if (!name.hasGlob() && name.getSimpleName() === undefined) {
        /* The decl's own invariant: a name that does not glob is a single literal,
         * so the loader reads "plain path or pattern?" off `getSimpleName()` alone.
         * Only an escaped metacharacter can split a glob-free name into parts. */
        this.invalidIncludeName("not a path");
      } else {
        const offset = token.start;
        this.nextToken();
        /* The reader now sits just past the name, which is its extent — a glob
         * has no single literal whose length would give it. */
        const endOffset = this.prevTokenEnd;
        this.consumeIfToken(TokenType.SEMI);
        return {
          kind: DeclKind.Include,
          source: this.source,
          offset,
          endOffset,
          name,
        };
      }
    } else {
      this.unexpectedTokenError("Name");
    }
  }

  /**
   * PluginDecl ::= 'plugin' NAME ';'
   */
  private parsePluginDecl(): IPluginDecl {
    const token = this.token;
    if (token.type === TokenType.IDENTIFIER || token.type === TokenType.SIMPLE_NAME) {
      this.nextToken();
      this.consumeIfToken(TokenType.SEMI);
      return {
        kind: DeclKind.Plugin,
        source: this.source,
        offset: token.start,
        name: token.text,
      };
    } else if (token.type === TokenType.NAME) {
      this.invalidPluginName();
    } else {
      this.unexpectedTokenError("Name");
    }
  }

  /**
   * A command-pipeline operator at the current position — consumed and returned
   * as its {@link CommandOpKind} (with source offset), else undefined. `<`/`>`
   * reuse LANGLE/RANGLE (a spaced `<` is not a `<k=v>` constraint, which binds
   * only when abutting); `2>`/`&>` arrive as their own folded tokens. A `>`
   * preceded by `-` is the mis-spaced rename arrow, not a redirect — kept as the
   * existing spacing hint. An operator may appear in any value; it makes the
   * property a command, which Validate restricts to COMMAND properties.
   */
  private tryCommandOp(): CommandOp | undefined {
    let op: CommandOpKind;
    switch (this.token.type) {
      case TokenType.PIPE:
        op = CommandOpKind.Pipe;
        break;
      case TokenType.LANGLE:
        op = CommandOpKind.Stdin;
        break;
      case TokenType.RANGLE:
        if (this.reader.substring(this.token.start - 1, this.token.start) === "-") {
          this.renameTemplateError("the '->' arrow must be surrounded by spaces (`sel -> tmpl`)");
        }
        op = CommandOpKind.Stdout;
        break;
      case TokenType.REDIR_STDOUT:
        op = CommandOpKind.Stdout;
        break;
      case TokenType.REDIR_STDERR:
        op = CommandOpKind.Stderr;
        break;
      case TokenType.REDIR_BOTH:
        op = CommandOpKind.Both;
        break;
      default:
        return undefined;
    }
    const at = this.token.start;
    this.nextToken();
    return { op, at };
  }

  /** Whether the current token begins a command operator (peek, no consume) —
   * the arg loop uses it to stop before an operator without swallowing it (and
   * without the `-`-before-`>` rename hint {@link tryCommandOp} applies). */
  private atCommandOp(): boolean {
    switch (this.token.type) {
      case TokenType.PIPE:
      case TokenType.LANGLE:
      case TokenType.RANGLE:
      case TokenType.REDIR_STDOUT:
      case TokenType.REDIR_STDERR:
      case TokenType.REDIR_BOTH:
        return true;
      default:
        return false;
    }
  }

  private commandError(detail: string, offset: number): never {
    this.log.log(DIAG_INVALID_COMMAND, { detail, loc: { ...this.source, offset } });
    throw new Error(PARSE_ERROR);
  }

  /**
   * Command  ::= Stage ('|' Stage)*
   * Stage    ::= Word+ Redirect*
   * Redirect ::= ('<' | '>' | '2>' | '&>') Word
   *
   * Parse a command pipeline in one pass, building the stages directly. `stage0`
   * is the words {@link parsePropertyDecl} already collected before the first
   * operator (this stage's command + args); `firstOp` that operator (already
   * consumed). `|` starts the next stage, a redirect binds the following word.
   * Cross-stage rules are enforced where they occur — a non-final stage capturing
   * stdout is caught at the `|` that ends it, a non-first stage taking stdin at
   * the `<`. A `{ ... }` block is not a command word.
   */
  private parseCommand(stage0: IValue[], firstOp: CommandOp, firstTarget?: INameValue): ICommandStage[] {
    const stages: ICommandStage[] = [];
    let stage = this.firstStage(stage0, firstOp);
    let op: CommandOp | undefined = firstOp;
    /* `firstTarget` supplies the target of `firstOp` when the value loop already
     * read it (the left-factored spaced-`<` redirect path: the shared IDENTIFIER
     * prefix was consumed to discriminate constraint-vs-redirect). Only the first
     * op consumes it; later ops parse their own target. */
    while (op !== undefined) {
      if (op.op === CommandOpKind.Pipe) {
        if (stage.stdout !== undefined || stage.both !== undefined) {
          this.commandError("only the final stage of a pipeline can capture stdout ('>' / '&>')", op.at);
        }
        stages.push(stage);
        stage = { command: this.parseRequiredWord(op), args: [] };
      } else {
        this.assignRedirect(stage, op, firstTarget ?? this.parseRequiredWord(op));
        if (op.op === CommandOpKind.Stdin && stages.length > 0) {
          this.commandError("only the first stage of a pipeline can take stdin ('<')", op.at);
        }
      }
      firstTarget = undefined;
      /* Trailing words up to the next operator (or the property's end) are the
       * current stage's args — args may follow a redirect (`cmd a > out b`). */
      while (!this.atCommandOp() && this.token.type !== TokenType.SEMI && this.token.type !== TokenType.RBRACE) {
        stage.args.push(this.parseWord());
      }
      op = this.tryCommandOp();
    }
    stages.push(stage);
    return stages;
  }

  /** Stage 0, from the words already collected before the first operator: the
   * first is the command, the rest args. Empty (a leading operator) or a block
   * word is a positioned error. */
  private firstStage(words: IValue[], firstOp: CommandOp): ICommandStage {
    if (words.length === 0) {
      this.commandError(
        firstOp.op === CommandOpKind.Pipe ? "empty command (nothing beside '|')" : "a redirect must follow a command",
        firstOp.at
      );
    }
    const [command, ...args] = words;
    return { command: this.asWord(command), args: args.map(word => this.asWord(word)) };
  }

  /** Parse one command word (a name-value reference); the caller guarantees a
   * word is present. */
  private parseWord(): INameValue {
    return this.asWord(this.parseValue());
  }

  /** Parse a required word — a `|`'s next command or a redirect's target —
   * erroring, positioned at the operator, when none follows. */
  private parseRequiredWord(op: CommandOp): INameValue {
    if (this.atCommandOp() || this.token.type === TokenType.SEMI || this.token.type === TokenType.RBRACE) {
      this.commandError(op.op === CommandOpKind.Pipe ? "empty command (nothing beside '|')" : missingTarget(op.op), op.at);
    }
    return this.parseWord();
  }

  /** Narrow a parsed value to a command word — a `{ ... }` block is not one. */
  private asWord(value: IValue): INameValue {
    if (!isNameValue(value)) {
      this.commandError("a `{ ... }` block is not a command", value.offset);
    }
    return value;
  }

  /** Bind a redirect's target to its stream on `stage`, erroring if that stream
   * is already captured (`> a > b`) or captured by both a specific and a
   * combined redirect (`&>` with `>`/`2>`). */
  private assignRedirect(stage: ICommandStage, op: CommandOp, target: INameValue): void {
    switch (op.op) {
      case CommandOpKind.Stdin:
        if (stage.stdin !== undefined) {
          this.commandError("stdin is redirected more than once", op.at);
        }
        stage.stdin = target;
        break;
      case CommandOpKind.Stdout:
        if (stage.stdout !== undefined || stage.both !== undefined) {
          this.commandError("stdout is redirected more than once", op.at);
        }
        stage.stdout = target;
        break;
      case CommandOpKind.Stderr:
        if (stage.stderr !== undefined || stage.both !== undefined) {
          this.commandError("stderr is redirected more than once", op.at);
        }
        stage.stderr = target;
        break;
      case CommandOpKind.Both:
        if (stage.stdout !== undefined || stage.stderr !== undefined || stage.both !== undefined) {
          this.commandError("a stream is redirected more than once", op.at);
        }
        stage.both = target;
        break;
      default:
        break;
    }
  }

  private parseValue(): IValue {
    const token = this.token;
    if (token.type === TokenType.LBRACE) {
      /* A `{ key = value; ... }` block value (a map, or one element of a list of
       * maps). Schema-blind: Validate enforces where blocks may appear. */
      const offset = token.start;
      const entries = this.parseMapBlock();
      return {
        kind: DeclKind.MapValue,
        source: this.source,
        offset,
        endOffset: this.prevTokenEnd,
        entries,
      };
    }
    if (token.type === TokenType.NAME || token.type === TokenType.IDENTIFIER || token.type === TokenType.SIMPLE_NAME) {
      const offset = token.start;
      const value = this.parseReference();
      /* parseReference leaves the current token positioned after the
       * reference, so the end of its last consumed token is the value's end */
      return {
        kind: DeclKind.NameValue,
        source: this.source,
        offset,
        endOffset: this.prevTokenEnd,
        value,
      };
    } else if (token.type === TokenType.RANGLE) {
      /* A bare `>` in value position is almost always a mis-spaced rename arrow
       * (`sel-> x`, where the NAME read swallowed the `-` and stopped at `>`). */
      this.renameTemplateError("the '->' arrow must be surrounded by spaces (`sel -> tmpl`)");
    } else {
      this.unexpectedTokenError("Name, ';', or '}'");
    }
  }

  /** @return the Name for a ref token (a bare identifier is a literal name). */
  private tokenToName(token: NameToken | IdentToken): Name {
    return typeof token.text === "string" ? Name.fromLiteral(token.text) : token.text;
  }

  /** @return the current token's literal text if it is a bare `1`/`2`/`&` — the
   * fd prefixes a `>` may fold with into a redirect operator — else undefined. */
  private redirectFdText(): string | undefined {
    const token = this.token;
    let text: string | undefined;
    if (token.type === TokenType.IDENTIFIER || token.type === TokenType.SIMPLE_NAME) {
      text = token.text;
    } else if (token.type === TokenType.NAME) {
      text = token.text.toString();
    }
    return text !== undefined && text in REDIR_FD_TOKEN ? text : undefined;
  }

  /** @return the current token if it is a reference token (NAME/identifier), else undefined. */
  private peekRefToken(): NameToken | IdentToken | undefined {
    const token = this.token;
    return token.type === TokenType.NAME || token.type === TokenType.IDENTIFIER || token.type === TokenType.SIMPLE_NAME
      ? token
      : undefined;
  }

  /**
   * Reference ::= Ref Constraints?  (an abutting ':projection' tail rejoined)
   *
   * Assumes the current token is the base ref (NAME/IDENTIFIER/SIMPLE_NAME);
   * consumes it, any *hugging* `<k=v, ...>` constraint delta, and — since a `<...>`
   * splits what would otherwise be one reference token — any hugging `:projection`
   * tail, reassembling them into one Name. Leaves the current token positioned
   * after the reference. A `<...>`/`:tail` separated by whitespace does not bind.
   */
  private parseReference(): Name {
    const name = this.tokenToName(this.token as NameToken | IdentToken);
    this.nextToken();
    return this.parseRefSuffix(name);
  }

  /**
   * The optional suffix after a reference's base token: an abutting `<k=v>`
   * constraint delta and/or a `-> template` rename. Factored out so the
   * left-factored spaced-`<` path (a detached constraint on a preceding value,
   * or a redirect target reference) reuses the exact same tail handling.
   */
  private parseRefSuffix(name: Name): Name {
    if (this.token.type === TokenType.LANGLE && this.tokenAbutsPrev) {
      this.nextToken(); /* consume '<' */
      return this.applyConstraintsAndRename(name, this.parseConstraintList());
    }
    /* `Reference (ARROW Template)?` — the rename half. The arrow is spaced, so it
     * binds regardless of any preceding `<...>`/`:proj`. */
    if (this.token.type === TokenType.ARROW) {
      name = this.withRename(name);
    }
    return name;
  }

  /**
   * Attach a `-> template` rename to `name`, having checked the template can be
   * replayed against it ({@link checkRenameWildcards}) and is a pattern rather than a
   * reference (no `:`). Assumes the current token is the ARROW.
   *
   * Here rather than in Validate because these rules read only the written name,
   * so this is the one place every rename passes through — including a CLI
   * reference (`fabr cat 'x:*.a -> *.b.*'`), which has no schema and no Validate
   * pass, and used to reach `find` and emit a literal `$2` into a result name.
   */
  private withRename(name: Name): Name {
    const arrow = this.token.start;
    const template = this.parseRenameTemplate();
    if (template.hasLevelSeparator()) {
      this.renameTemplateError("a rename template cannot contain ':'", arrow);
    }
    const invalid = checkRenameWildcards(name, template);
    if (invalid) {
      this.renameTemplateError(invalid, arrow);
    }
    return name.withRenameTo(template);
  }

  /** Attach a parsed constraint list to `name` (rejoining any hugging projection
   * tail — a `<...>` splits what would be one reference token, so a tail like
   * `:build/*.js` arrives as a separate, abutting token), then apply a trailing
   * `-> rename`. Shared by the abutting `ref<k=v>` and detached `ref <k=v>` paths. */
  private applyConstraintsAndRename(name: Name, constraints: NameConstraint[]): Name {
    const tail = this.tokenAbutsPrev ? this.peekRefToken() : undefined;
    /* A `<...>` splits a reference before its projection, so a `:`/`/`-led tail
     * (`pkg<k=v>:build/*.js`, `pkg<k=v>/lib/x`) rejoins. Arbitrary abutting text
     * (`foo<k=v>bar`) is NOT a projection — leave it unconsumed so it errors or
     * parses separately, rather than silently gluing into `foobar<k=v>`. */
    if (tail) {
      const tailLiteral = this.tokenToName(tail).getLiteralPrefix();
      if (tailLiteral.startsWith(":") || tailLiteral.startsWith("/")) {
        name = name.concat(this.tokenToName(tail));
        this.nextToken();
      }
    }
    name = name.withConstraints(constraints);
    if (this.token.type === TokenType.ARROW) {
      name = this.withRename(name);
    }
    return name;
  }

  /**
   * Template ::= IDENTIFIER | SIMPLE_NAME | NAME
   *
   * Assumes the current token is the ARROW; consumes it and the single template
   * token. A template is a name pattern, never a reference: an abutting `<...>`
   * (constraints), a chained `-> ` (second arrow), or a missing template are
   * errors here. Its content rules are {@link withRename}'s, bar the ones that
   * need the property's schema type (those stay in Validate).
   */
  private parseRenameTemplate(): Name {
    this.consumeToken(TokenType.ARROW);
    const token = this.peekRefToken();
    if (!token) {
      this.unexpectedTokenError("a rename template");
    }
    const template = this.tokenToName(token);
    this.nextToken();
    if (this.token.type === TokenType.LANGLE && this.tokenAbutsPrev) {
      this.renameTemplateError("a rename template cannot carry constraints");
    }
    if (this.token.type === TokenType.ARROW) {
      this.renameTemplateError("rename templates cannot be chained");
    }
    return template;
  }

  /** `at` defaults to the current token — the offending one for the structural
   * errors; a content error is reported at the `-> ` the rename hangs off, the
   * template itself having already been consumed. */
  private renameTemplateError(detail: string, at: number = this.token.start): never {
    this.log.log(DIAG_RENAME_TEMPLATE, { detail, loc: { ...this.source, offset: at } });
    throw new Error(PARSE_ERROR);
  }

  /** Reported at the outermost unclosed extglob leader (`at` is its offset), so
   * the underline points at the `!(` rather than at the end of the name. */
  private unterminatedExtglobError(at: number): never {
    this.log.log(DIAG_UNTERMINATED_EXTGLOB, {
      leader: this.reader.substring(at, at + 2),
      loc: { ...this.source, offset: at },
    });
    throw new Error(PARSE_ERROR);
  }

  /**
   * Constraints ::= '<' Constraint ( ',' Constraint )* ','? '>'
   * Constraint  ::= IDENTIFIER '=' ( IDENTIFIER | SIMPLE_NAME | NAME )
   *
   * Parse a `<k=v, …>` constraint body — the opening `<` already consumed —
   * through the closing `>`. An empty `<>`, a non-identifier key, and a repeated
   * key are all errors. When `firstKey` is given, its key identifier is *also*
   * already consumed and the current token is its `=` (the left-factored
   * spaced-`<` path, where the value loop reads the shared `<`+IDENTIFIER prefix
   * before the `=` discriminator decides constraint vs redirect); otherwise the
   * first key is read here (the ordinary abutting `ref<k=v>` path).
   */
  private parseConstraintList(firstKey?: { text: string; start: number }): NameConstraint[] {
    const constraints: NameConstraint[] = [];
    const seen = new Set<string>();
    /* Inside the `<...>`, a `>` closes the constraint — never a redirect (see
     * suppressRedirect). Restored in `finally` so an error, or the tail after the
     * `>`, lexes redirects normally again. */
    this.suppressRedirect = true;
    try {
      let pending = firstKey;
      for (;;) {
        let keyText: string;
        let keyStart: number;
        if (pending) {
          keyText = pending.text;
          keyStart = pending.start;
          pending = undefined;
        } else {
          const key = this.token;
          if (key.type !== TokenType.IDENTIFIER) {
            this.unexpectedTokenError("a constraint key");
          }
          keyText = key.text;
          keyStart = key.start;
          this.nextToken();
        }
        if (seen.has(keyText)) {
          this.duplicateConstraintError(keyText, keyStart);
        }
        seen.add(keyText);
        this.consumeToken(TokenType.EQUALS);
        const value = this.token;
        if (
          value.type !== TokenType.IDENTIFIER &&
          value.type !== TokenType.SIMPLE_NAME &&
          value.type !== TokenType.NAME
        ) {
          this.unexpectedTokenError("a constraint value");
        }
        constraints.push([keyText, this.tokenToName(value)]);
        this.nextToken();
        /* Continue on a comma (unless it was trailing, before the '>'); otherwise
         * the list is done and a '>' must follow. */
        if (!this.consumeIfToken(TokenType.COMMA) || this.token.type === TokenType.RANGLE) {
          break;
        }
      }
    } finally {
      this.suppressRedirect = false;
    }
    this.consumeToken(TokenType.RANGLE);
    return constraints;
  }

  private duplicateConstraintError(key: string, offset: number): never {
    this.log.log(DIAG_DUP_CONSTRAINT, { key, loc: { ...this.source, offset } });
    throw new Error(PARSE_ERROR);
  }

  /**
   * PropertyDecl ::= NAME '=' NAME ';'
   *                       ^
   * @param name
   * @param nameOffset
   */
  private parsePropertyDecl(name: string, nameOffset: number, keyRef?: Name, docComment?: string): IPropertyDecl {
    this.consumeToken(TokenType.EQUALS);
    const base = { kind: DeclKind.Property as const, source: this.source, name, offset: nameOffset, keyRef, docComment };
    return this.parsePropertyValues(base);
  }

  /**
   * The right-hand side of a property: its value list up to (and including) the
   * terminating ';'. Shared by an ordinary `name = values;` declaration and a
   * targetdef's `default values;` clause, so the two admit exactly the same value
   * grammar. Assumes the current token starts the first value.
   */
  private parsePropertyValues(base: Omit<IPropertyDecl, "values">): IPropertyDecl {
    const values: IValue[] = [];
    /* The value loop admits `{...}` blocks as values (parseValue), so a value
     * list may hold names, blocks, or (per Validate, only homogeneously) several
     * blocks — `maintainers = { ... } { ... };`. A block value swallows its own
     * closing brace, so the loop's RBRACE test only ever sees the *enclosing*
     * body's terminator. Like a target body, a block needs no trailing ';': a
     * closed block ends the property unless another block follows (an array of
     * maps) — homogeneity makes this unambiguous, since any other token can only
     * start the next entry/statement. On the first pipeline operator (`|`, `<`,
     * `>`, …) the whole RHS is a command: hand the words gathered so far to
     * parseCommand as stage 0. A bare `cmd args` with no operator stays a value
     * list (getCommand folds the single stage). */
    while (this.token.type !== TokenType.SEMI && this.token.type !== TokenType.RBRACE) {
      /* A spaced `<` after a reference is ambiguous between a detached `<k=v>`
       * constraint on that reference and a stdin redirect. Left-factor it: the
       * two productions share a leading IDENTIFIER (a constraint key, or a
       * bare-identifier redirect target), so consume `<` and that identifier,
       * then the current token discriminates — `=` ⟹ constraint, else ⟹ redirect.
       * Only relevant when a constrainable reference precedes it. */
      if (this.token.type === TokenType.LANGLE && values.length > 0 && isNameValue(values[values.length - 1])) {
        const langleAt = this.token.start;
        const afterLangle = this.nextToken(); /* consume '<' */
        if (afterLangle.type === TokenType.IDENTIFIER) {
          const keyToken = { text: afterLangle.text, start: afterLangle.start };
          const afterKey = this.nextToken(); /* consume the shared identifier prefix */
          if (afterKey.type === TokenType.EQUALS) {
            /* A detached constraint: attach to the preceding reference, exactly
             * as an abutting `ref<k=v>` would (constraints + `-> rename` tail). */
            const last = values[values.length - 1] as INameValue;
            const refined = this.applyConstraintsAndRename(last.value, this.parseConstraintList(keyToken));
            values[values.length - 1] = { ...last, value: refined, endOffset: this.prevTokenEnd };
            continue;
          }
          /* Not a constraint: a stdin redirect whose target starts with this
           * identifier (which may carry its own abutting `<k=v>`/`->` suffix). */
          const target: INameValue = {
            kind: DeclKind.NameValue,
            source: this.source,
            offset: keyToken.start,
            value: this.parseRefSuffix(Name.fromLiteral(keyToken.text)),
            endOffset: this.prevTokenEnd,
          };
          return this.finishCommandProperty(base, values, this.parseCommand(values, { op: CommandOpKind.Stdin, at: langleAt }, target));
        }
        /* A spaced `<` before a non-identifier: an ordinary stdin redirect whose
         * target the command path parses (a SIMPLE_NAME/NAME/reference). */
        return this.finishCommandProperty(base, values, this.parseCommand(values, { op: CommandOpKind.Stdin, at: langleAt }));
      }
      const op = this.tryCommandOp();
      if (op !== undefined) {
        return this.finishCommandProperty(base, values, this.parseCommand(values, op));
      }
      const value = this.parseValue();
      values.push(value);
      if (isMapValue(value) && this.token.type !== TokenType.LBRACE) {
        break;
      }
    }
    this.consumeIfToken(TokenType.SEMI);
    return { ...base, values };
  }

  /** Wrap a parsed pipeline as the property's single command value. `values` are
   * the words gathered before the first operator (stage 0); its first element,
   * or `prevTokenEnd`, positions the value. */
  private finishCommandProperty(base: Omit<IPropertyDecl, "values">, values: IValue[], pipeline: ICommandStage[]): IPropertyDecl {
    this.consumeIfToken(TokenType.SEMI);
    const command: ICommandValue = {
      kind: DeclKind.CommandValue,
      source: this.source,
      offset: values.length > 0 ? values[0].offset : this.prevTokenEnd,
      endOffset: this.prevTokenEnd,
      pipeline,
    };
    return { ...base, values: [command] };
  }

  /**
   * MapBlock  ::= '{' MapItem* '}'
   * MapItem   ::= MapKey '=' Value* ';' | MapSplice
   * MapSplice ::= Ref ';'
   * MapKey    ::= IDENTIFIER | SIMPLE_NAME | NAME
   *
   * A MAP property's value: a block of `key = value;` sub-properties and
   * `NAME;` splices. Unlike a `sync` member coordinate, a map key is a *literal
   * foreign name* (dotted keys like `process.env.NODE_ENV` are common), never
   * resolved as a reference — so its canonical string is taken verbatim as the
   * entry name. A name NOT followed by `=` is instead a *splice*: a reference
   * to another block-valued property whose entries merge in at this position
   * (the in-block form of the top-level bare-reference chase). Entry values are
   * ordinary values, including nested blocks. Assumes the current token is the
   * opening `{`.
   */
  private parseMapBlock(): IMapItemDecl[] {
    if (this.blockDepth >= MAX_BLOCK_DEPTH) {
      this.log.log(DIAG_NESTING_TOO_DEEP, { loc: { ...this.source, offset: this.token.start } });
      throw new Error(PARSE_ERROR);
    }
    this.blockDepth++;
    try {
      return this.parseMapBlockBody();
    } finally {
      this.blockDepth--;
    }
  }

  /** {@link parseMapBlock}'s body, split out so the depth accounting is a single
   * enter/leave around it (including the recovery throw). */
  private parseMapBlockBody(): IMapItemDecl[] {
    this.consumeToken(TokenType.LBRACE);
    const entries: IMapItemDecl[] = [];
    while (this.token.type !== TokenType.RBRACE && this.token.type !== TokenType.EOF) {
      try {
        const keyToken = this.peekRefToken();
        if (!keyToken) {
          this.unexpectedTokenError("a map key, a map reference, or '}'");
        }
        const offset = keyToken.start;
        const name = this.tokenToName(keyToken);
        const next = this.nextToken();
        if (next.type === TokenType.EQUALS) {
          entries.push(this.parsePropertyDecl(name.toString(), offset));
        } else if (next.type === TokenType.SEMI || next.type === TokenType.RBRACE) {
          /* A splice: the reference's Name is kept intact (it may carry `${...}`
           * substitutions), resolved at read time. */
          entries.push({
            kind: DeclKind.MapSplice,
            source: this.source,
            offset,
            endOffset: this.prevTokenEnd,
            ref: name,
          });
          this.consumeIfToken(TokenType.SEMI);
        } else {
          this.unexpectedTokenError("'=' or ';'");
        }
      } catch (error) {
        if (!(error instanceof Error) || error.message !== PARSE_ERROR) {
          throw error;
        }
        /* Recover within the block (as parsePropertyList does for a target body),
         * so a bad entry doesn't collapse the whole block and leak the enclosing
         * body's `}`. */
        this.recoverInBody();
      }
    }
    this.consumeToken(TokenType.RBRACE);
    return entries;
  }

  private parsePropertyList(): IPropertyDecl[] {
    const list: IPropertyDecl[] = [];
    while (this.token.type !== TokenType.RBRACE && this.token.type !== TokenType.EOF) {
      try {
        const token = this.token;
        if (token.type === TokenType.IDENTIFIER) {
          this.nextToken();
          list.push(this.parsePropertyDecl(token.text, token.start));
        } else if (token.type === TokenType.NAME || token.type === TokenType.SIMPLE_NAME) {
          /* A reference in key position — a `sync` member coordinate (`@npm:pkg:ver =
           * srcs`), or a bare-name/path key (`@fabr-build/core`, `lib/x` — a SIMPLE_NAME).
           * A plain property name is an IDENTIFIER (handled above); any wider key is a
           * reference. Parse the full reference as the key; its canonical string is the
           * property name, and the Name is carried on `keyRef` for the rule to read. */
          const start = token.start;
          const keyRef = this.parseReference();
          const keyEnd = this.prevTokenEnd;
          const decl = this.parsePropertyDecl(keyRef.toString(), start, keyRef);
          /* Span the coordinate (not the whole `key = value`), so a per-member
           * error underlines the offending reference. */
          decl.endOffset = keyEnd;
          list.push(decl);
        } else {
          this.unexpectedTokenError("Identifier, reference, or '}'");
        }
      } catch (error) {
        if (!(error instanceof Error) || error.message !== PARSE_ERROR) {
          throw error;
        }
        /* Recover *within* this body: skip to the next `;` (resume with the next
         * property, keeping this target and the properties that parsed) or the
         * body's own `}` (end the body). Without this, the error would propagate
         * to the top-level recovery, which resyncs INTO the body — leaking the
         * remaining body properties to the top level and misreporting the `}`. */
        this.recoverInBody();
      }
    }
    return list;
  }

  /** Skip tokens after a body property error until the next statement boundary
   * within the current `{...}` body: a `;` at body depth (consumed — resume the
   * next property) or the body's own closing `}` (left in place — the caller
   * consumes it). Nested `{}` (a map-block value) are balanced so their `}` is
   * not mistaken for the body close. */
  private recoverInBody(): void {
    let depth = 0;
    while (this.token.type !== TokenType.EOF) {
      switch (this.token.type) {
        case TokenType.LBRACE:
          depth++;
          break;
        case TokenType.RBRACE:
          if (depth === 0) {
            return; /* the body's own close — leave it for parseTargetDecl */
          }
          depth--;
          break;
        case TokenType.SEMI:
          if (depth === 0) {
            this.nextToken(); /* consume the `;`, resume at the next property */
            return;
          }
          break;
      }
      this.nextToken();
    }
  }

  /**
   * TargetDecl ::= NAME NAME '{' PropertyList '}'
   *                     ^
   * @param name
   * @param nameOffset
   */
  private parseTargetDecl(type: string, typeOffset: number, docComment?: string): ITargetDecl {
    if (this.token.type !== TokenType.IDENTIFIER && this.token.type !== TokenType.SIMPLE_NAME) {
      this.unexpectedTokenError("Path");
    } else {
      const nameToken = this.token;
      this.nextToken();
      const nameEnd = this.prevTokenEnd;
      this.consumeToken(TokenType.LBRACE);
      const properties = this.parsePropertyList();
      this.consumeToken(TokenType.RBRACE);
      return {
        kind: DeclKind.Target,
        source: this.source,
        type,
        typeOffset,
        name: nameToken.text,
        offset: nameToken.start,
        endOffset: nameEnd,
        properties,
        docComment,
      };
    }
  }

  /**
   * DefaultDecl ::= 'default' ( PropertyDecl | TargetDecl )
   *                            ^
   *
   * `default` prefixes either form of named declaration, so the word here is a
   * property name or a target type and must be an identifier — a `/`-bearing
   * SIMPLE_NAME (or anything else) is a positioned error, NOT a target of type
   * `default`. Which form follows is decided by the token after it, exactly as
   * for an undefaulted declaration.
   */
  private parseDefaultDecl(docComment: string | undefined): IDefaultableDecl {
    const name = this.token;
    if (name.type !== TokenType.IDENTIFIER) {
      this.unexpectedTokenError("a property name or target type after 'default'");
    }
    const next = this.nextToken();
    if (next.type === TokenType.EQUALS) {
      return this.parsePropertyDecl(name.text, name.start, undefined, docComment);
    } else if (next.type === TokenType.IDENTIFIER || next.type === TokenType.SIMPLE_NAME) {
      /* Only properties and targets have a default slot: a targetdef is not
       * defaultable, so `default targetdef x { … }` is an error reported at the
       * keyword, rather than a target whose type is `targetdef`. */
      if (name.text === "targetdef") {
        this.unexpectedTokenError("a property name or target type after 'default'", name.start);
      }
      return this.parseTargetDecl(name.text, name.start, docComment);
    } else {
      this.unexpectedTokenError("'=' or a target name");
    }
  }

  /**
   * TargetDefDecl ::= 'targetdef' NAME '{' PropertyTypeList '}'
   *                     ^
   * @param name
   * @param nameOffset
   */
  private parseTargetDefDecl(docComment: string | undefined): ITargetDefDecl {
    if (this.token.type !== TokenType.IDENTIFIER) {
      this.unexpectedTokenError("Identifier");
    } else {
      const nameToken = this.token;
      this.nextToken();
      const nameEnd = this.prevTokenEnd;
      this.consumeToken(TokenType.LBRACE);
      const properties = this.parsePropertyTypeList();
      this.consumeToken(TokenType.RBRACE);
      return {
        kind: DeclKind.TargetDef,
        source: this.source,
        name: nameToken.text,
        offset: nameToken.start,
        endOffset: nameEnd,
        properties,
        docComment,
      };
    }
  }

  /**
   * PropertyTypeList ::= PropertyType*
   * PropertyType ::= NAME '=' PropertySchema DefaultClause? ';'
   * PropertySchema ::=  ( 'STRING'|'FILES'|'REQUIRED' )*
   * DefaultClause ::= 'default' Value*
   *
   */
  private parsePropertyTypeList(): Map<string, IPropertySchema> {
    /* A Map, as the keys are user-controlled property names. */
    const result = new Map<string, IPropertySchema>();
    while (this.token.type !== TokenType.RBRACE) {
      const token = this.token;
      const docComment = token.docComment;
      let required = false;
      let type: PropertyType | undefined;
      let defaultDecl: IPropertyDecl | undefined;
      /* The key is a property name (`srcs`), or `*` — the wildcard, typing any
       * further keys a target of this type may carry (a `sync`'s reference-keyed
       * members). `*` lexes as a glob NAME, so match it by its part *structure*:
       * the wildcard is the one whose sole part is the `*` glob. Comparing
       * rendered text instead would also admit a quoted `'*'`, which is the
       * literal character and not the wildcard. */
      let key: string;
      if (token.type === TokenType.IDENTIFIER) {
        key = token.text;
      } else if (token.type === TokenType.NAME && isWildcardKey(this.tokenToName(token))) {
        key = "*";
      } else {
        this.unexpectedTokenError("Identifier, '*', or '}'");
      }
      this.nextToken();
      let next = this.consumeToken(TokenType.EQUALS);
      if (next.type !== TokenType.IDENTIFIER) {
        this.unexpectedTokenError("'STRING' or 'FILES' or 'REWRITE' or 'MAP' or 'REQUIRED'");
      } else {
        while (next.type === TokenType.IDENTIFIER) {
          /* `default` ends the keyword run and hands the rest of the line to the
           * ordinary value parser (which consumes the terminating ';'), so a
           * default admits every value form a written property does. The decl it
           * builds is positioned at the schema key, that being what a resolution
           * error against the default should underline. */
          if (next.text === "default") {
            this.nextToken();
            defaultDecl = this.parsePropertyValues({
              kind: DeclKind.Property,
              source: this.source,
              name: key,
              offset: token.start,
            });
            break;
          }
          switch (next.text) {
            case "REQUIRED":
              required = true;
              break;
            case "STRING":
              type = PropertyType.String;
              break;
            case "FILES":
              type = PropertyType.FileSet;
              break;
            case "REWRITE":
              type = PropertyType.Rewrite;
              break;
            case "MAP":
              type = PropertyType.Map;
              break;
            case "COMMAND":
              type = PropertyType.Command;
              break;
            default:
              this.unexpectedTokenError("'STRING' or 'FILES' or 'REWRITE' or 'MAP' or 'COMMAND' or 'REQUIRED'");
          }
          next = this.nextToken();
        }
      }
      if (type === undefined) {
        if (defaultDecl) {
          /* `default` ended the keyword run before any type keyword. The clause
           * itself parsed clean (values and ';' consumed), so this is an
           * ordinary logged error at the key, not a thrown recovery — the
           * generic unexpected-token report would point at whatever follows
           * the clause, nowhere near the mistake. */
          this.log.log(DIAG_DEFAULT_BEFORE_TYPE, { key, loc: { ...this.source, offset: token.start } });
        } else {
          this.unexpectedTokenError("'STRING' or 'FILES' or 'REWRITE' or 'MAP'");
        }
      } else if (required && defaultDecl) {
        /* A default supplies the property whenever it is unwritten, so nothing is
         * left for REQUIRED to demand — the pair says both "must be written" and
         * "need not be". */
        this.log.log(DIAG_REQUIRED_DEFAULT, { key, loc: { ...this.source, offset: token.start } });
      } else if (key === "*" && defaultDecl) {
        /* The wildcard types keys the schema never named; a default applies to a
         * named property that went unwritten, and there is no such thing here —
         * an unwritten wildcard member simply does not exist. Rejected rather
         * than accepted-and-ignored. */
        this.log.log(DIAG_WILDCARD_DEFAULT, { loc: { ...this.source, offset: token.start } });
      } else if (result.has(key)) {
        /* The first declaration stands; the load fails on the error anyway, so
         * the surviving entry only shapes further diagnostics. */
        this.log.log(DIAG_DUP_SCHEMA_KEY, { key, loc: { ...this.source, offset: token.start } });
      } else {
        result.set(key, { required, type, default: defaultDecl, docComment });
      }
      /* A default clause has already consumed its own terminating ';'. */
      if (!defaultDecl && next.type !== TokenType.RBRACE) {
        this.consumeToken(TokenType.SEMI);
      }
    }
    return result;
  }

  /**
   * Report a parse error to the diagnostic log due to an unexpected token,
   * and throw (caught by recovery). Note that the current token is _NOT_
   * consumed.
   * @param expected
   * @param at offset to report at, defaulting to the current token — an earlier
   * one where the token that is wrong is only known to be so from a later one
   * (`default targetdef`, whose lookahead has already advanced past it).
   */
  private unexpectedTokenError(expected: string, at: number = this.token.start): never {
    /* Report an error */
    this.log.log(DIAG_PARSE_ERROR, {
      loc: { ...this.source, offset: at },
      actual: TOKEN_NAME_MAP[this.token.type],
      expected,
    });
    throw new Error(PARSE_ERROR);
  }

  private unexpectedEndOfFile(expected: string, offset: number = this.token.start): never {
    this.log.log(DIAG_UNEXPECTED_EOF, {
      loc: { ...this.source, offset },
      expected,
    });
    throw new Error(PARSE_ERROR);
  }

  private invalidIncludeName(detail: string): never {
    this.log.log(DIAG_INVALID_INCLUDE, { detail, loc: { ...this.source, offset: this.token.start } });
    throw new Error(PARSE_ERROR);
  }

  private absoluteIncludeName(): never {
    this.log.log(DIAG_ABSOLUTE_INCLUDE, { loc: { ...this.source, offset: this.token.start } });
    throw new Error(PARSE_ERROR);
  }

  private invalidPluginName(): never {
    this.log.log(DIAG_INVALID_PLUGIN, { loc: { ...this.source, offset: this.token.start } });
    throw new Error(PARSE_ERROR);
  }

  /**
   * Parse a statement.
   *
   * Statement ::= PropertyDecl | TargetDecl | IncludeDecl | PluginDecl | TargetDefDecl | DefaultDecl
   *               ^
   * PropertyDecl ::= NAME '=' expr ';'
   * TargetDecl ::= NAME NAME '{' PropertyList '}'
   * IncludeDecl ::= 'include' NAME ';'
   * PluginDecl ::= 'plugin' NAME ';'
   * TargetDefDecl ::= 'targetdef' NAME '{' PropertyTypeList '}'
   * DefaultDecl ::= 'default' ( PropertyDecl | TargetDecl )
   */

  public parseStatement(): void {
    const token = this.token;
    if (token.type === TokenType.IDENTIFIER) {
      /* The doc comment rides on the statement's leading token — a keyword, a
       * property name, or a target type — so capture it before advancing. */
      const doc = token.docComment;
      const next = this.nextToken();
      if (token.text === "include") {
        this.result.includes.push(this.parseIncludeDecl());
      } else if (token.text === "plugin") {
        this.result.plugins.push(this.parsePluginDecl());
      } else if (token.text === "default") {
        this.result.defaults.push(this.parseDefaultDecl(doc));
      } else if (next.type === TokenType.EQUALS) {
        this.result.properties.push(this.parsePropertyDecl(token.text, token.start, undefined, doc));
      } else if (next.type === TokenType.IDENTIFIER || next.type === TokenType.SIMPLE_NAME) {
        if (token.text === "targetdef") {
          this.result.targetdefs.push(this.parseTargetDefDecl(doc));
        } else {
          this.result.targets.push(this.parseTargetDecl(token.text, token.start, doc));
        }
      } else {
        this.unexpectedTokenError("Identifier or '='");
      }
    } else {
      this.unexpectedTokenError("Statement");
    }
  }

  /**
   * Very basic error recovery - skip tokens until we find a ';' or '}' followed by
   * an IDENTIFIER, so that parsing can resume on the next statement (every statement
   * begins with an identifier: a type name, a property name, or a keyword).
   */
  private recoverFromError(): void {
    let last = this.token.type;
    while (last !== TokenType.EOF) {
      const next = this.nextToken();
      if ((last === TokenType.SEMI || last === TokenType.RBRACE) && next.type === TokenType.IDENTIFIER) {
        break;
      }
      last = next.type;
    }
  }

  public parse(): IBuildFileContents {
    while (this.token.type !== TokenType.EOF) {
      try {
        this.parseStatement();
      } catch (error) {
        if (!(error instanceof Error) || error.message !== PARSE_ERROR) {
          throw error;
        } else {
          this.recoverFromError();
        }
      }
    }
    return this.result;
  }
}

export function parseBuildFile(source: IBuildFile, log: Log): IBuildFileContents {
  return new BuildParser(source, log).parse();
}

export function parseBuildString(fs: FileSource, file: string, contents: string, log: Log): IBuildFileContents {
  return new BuildParser({ fs, file, reader: new StringReader(contents) }, log).parse();
}

/** Parse a single name expression (e.g. a command-line target/file reference).
 * Parse diagnostics are *captured*, not logged — the model never writes to a
 * sink — and a malformed name throws with the diagnostic as its message, which
 * the driver renders to stderr (never polluting `cat`/`ls`'s stdout). */
export function parseName(contents: string): Name {
  const messages: string[] = [];
  const captureLog: Log = { log: (diagnostic, params) => messages.push(diagnostic.message(params)) };
  try {
    /* The constructor primes the first token, so it lexes — and a name is very
     * nearly all one token, which is where the lexical errors (an unterminated
     * quote, character class or extglob group) are raised. It must be inside the
     * try, or those escape as a bare PARSE_ERROR with the diagnostic discarded. */
    const parser = new BuildParser(
      { fs: EMPTY_FILESET, file: "<command-line>", reader: new StringReader(contents) },
      captureLog
    );
    const name = parser.parseName();
    if (messages.length === 0) {
      return name;
    }
  } catch (err) {
    if (!(err instanceof Error) || err.message !== PARSE_ERROR) {
      throw err;
    }
  }
  throw new Error(`Invalid name '${contents}': ${messages.join("; ")}`);
}
