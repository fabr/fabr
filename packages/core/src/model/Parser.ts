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
  IIncludeDecl,
  IPluginDecl,
  IPropertyDecl,
  IPropertySchema,
  ITargetDecl,
  ITargetDefDecl,
  IValue,
  PropertyType,
} from "./AST";
import { Diagnostic, ISourcePosition, Log, LogLevel } from "../support/Log";
import { Name, NameBuilder, NameConstraint } from "../core/Name";
import { EMPTY_FILESET, FileSource } from "../core/FileSet";

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

interface NameToken {
  type: TokenType.NAME;
  start: number;
  text: Name;
}

interface IdentToken {
  type: TokenType.IDENTIFIER | TokenType.SIMPLE_NAME;
  start: number;
  text: string;
}

interface NonNameToken {
  type: Exclude<TokenType, TokenType.NAME | TokenType.IDENTIFIER | TokenType.SIMPLE_NAME>;
  start: number;
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
  [TokenType.ERROR]: "ERROR",
};

function isWhitespace(ch: number): boolean {
  return ch === CHAR_NEWLINE || isWhiteSpaceChar(ch);
}

/** The `->` arrow must be whitespace-delimited: what may follow the `>`. */
function isArrowTerminator(ch: number | undefined): boolean {
  return ch === undefined || isWhitespace(ch);
}

function isFirstIdentChar(ch: number): boolean {
  return isAlphabetic(ch) || ch === CHAR_UNDERSCORE || ch === CHAR_AT;
}

/* An IDENTIFIER — keywords, property names, constraint keys, target *types* —
 * is `@`/`_`/alphanumeric only. A SIMPLE_NAME (a target or plugin name such as
 * `@fabr-build/js`, `my-target`, `lodash.merge`) additionally allows `/`, `-`, `.`.
 * Both start like an identifier; the extras are interior-only, so a leading
 * `.`/`-`/`/` (a relative include `./x`, a version `1.2.3`) stays a NAME. */
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
const DIAG_INVALID_INCLUDE = new Diagnostic<{ loc: ISourcePosition }>(
  LogLevel.Error,
  "Include names cannot currently contain glob patterns or variables"
);
const DIAG_ABSOLUTE_INCLUDE = new Diagnostic<{ loc: ISourcePosition }>(
  LogLevel.Error,
  "Include paths must be relative to the including file"
);
const DIAG_INVALID_PLUGIN = new Diagnostic<{ loc: ISourcePosition }>(
  LogLevel.Error,
  "Plugin names must be plain target names (no glob patterns or variables)"
);

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
    this.reader.consume(CHAR_QUOTE);
    const start = this.reader.currentOffset();
    const next = this.reader.skipUntil(ch => ch === CHAR_QUOTE);
    if (next === undefined) {
      this.unexpectedEndOfFile("'");
    }
    builder?.appendLiteralString(this.reader.substring(start));
    this.reader.next(); /* Consume the closing quote */
  }

  /* Double quotes can contain variables (which can contain double quotes).
   * Consumes everything up to and including the closing quote. */
  private readDoubleQuotedString(builder?: NameBuilder): void {
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
      this.unexpectedEndOfFile('"');
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
      this.reader.next(); /* initial ']' gets special handling */
    }
    /* TODO: allow variable substitutions and 'special classes' inside the char class */
    const last = this.reader.skipUntil(ch => ch === CHAR_RSQUARE);
    if (last === undefined) {
      this.unexpectedEndOfFile("]");
    }
    this.reader.next();
    builder?.appendGlobMetachars(this.reader.substring(start));
  }

  private readNameOrIdentifier(): Token {
    const start = this.reader.currentOffset();
    const nameBuilder = new NameBuilder();
    let maybeIdent = true;
    /* Expect current character is not whitespace or a special character.
     * Quoted strings, substitutions and character classes consume themselves
     * whole (the scan only advances past characters they leave in place). */
    let posn = this.reader.currentOffset();
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
          maybeIdent = false;
          nameBuilder.appendEscapedString(this.reader.substring(posn));
          nameBuilder.appendGlobMetachars("*");
          posn = this.reader.currentOffset() + 1;
          break;
        case CHAR_QUESTION:
          maybeIdent = false;
          nameBuilder.appendEscapedString(this.reader.substring(posn));
          nameBuilder.appendGlobMetachars("?");
          posn = this.reader.currentOffset() + 1;
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
    const ch = this.reader.skipUntil(ch => {
      if (inComment) {
        if (ch === CHAR_NEWLINE) {
          inComment = false;
        }
        return false;
      } else if (ch === CHAR_HASH) {
        inComment = true;
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
   */
  private parseIncludeDecl(): IIncludeDecl {
    const token = this.token;
    if (token.type === TokenType.IDENTIFIER || token.type === TokenType.SIMPLE_NAME || token.type === TokenType.NAME) {
      const simpleName = typeof token.text === "string" ? token.text : token.text.getSimpleName();
      if (!simpleName) {
        this.invalidIncludeName();
        /* Lexically, either platform's absolute form — a .fabr file must parse the
         * same everywhere, so this doesn't ride the host's path.isAbsolute. */
      } else if (simpleName.startsWith("/") || /^[A-Za-z]:[\\/]/.test(simpleName)) {
        this.absoluteIncludeName();
      } else {
        this.nextToken();
        this.consumeIfToken(TokenType.SEMI);
        return {
          kind: DeclKind.Include,
          source: this.source,
          offset: token.start,
          filename: simpleName,
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

  private parseValue(): IValue {
    const token = this.token;
    if (token.type === TokenType.NAME || token.type === TokenType.IDENTIFIER || token.type === TokenType.SIMPLE_NAME) {
      const offset = token.start;
      const value = this.parseReference();
      /* parseReference leaves the current token positioned after the
       * reference, so the end of its last consumed token is the value's end */
      return {
        kind: DeclKind.Value,
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
    let name = this.tokenToName(this.token as NameToken | IdentToken);
    this.nextToken();
    if (this.token.type === TokenType.LANGLE && this.tokenAbutsPrev) {
      const constraints = this.parseConstraints();
      /* A `<...>` splits what would be one reference token, so a projection tail
       * (`:build/*.js`) arrives as a separate, hugging token — rejoin it. */
      const tail = this.tokenAbutsPrev ? this.peekRefToken() : undefined;
      if (tail) {
        name = name.concat(this.tokenToName(tail));
        this.nextToken();
      }
      name = name.withConstraints(constraints);
    }
    /* `Reference (ARROW Template)?` — the rename half. The arrow is spaced, so it
     * binds regardless of any preceding `<...>`/`:proj`. */
    if (this.token.type === TokenType.ARROW) {
      name = name.withRenameTo(this.parseRenameTemplate());
    }
    return name;
  }

  /**
   * Template ::= IDENTIFIER | SIMPLE_NAME | NAME
   *
   * Assumes the current token is the ARROW; consumes it and the single template
   * token. A template is a name pattern, never a reference: an abutting `<...>`
   * (constraints), a chained `-> ` (second arrow), or a missing template are
   * errors here; the value-level content rules (no `:`, `*`/`**` slots only,
   * matching wildcard counts) are enforced later in Validate.
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

  private renameTemplateError(detail: string): never {
    this.log.log(DIAG_RENAME_TEMPLATE, { detail, loc: { ...this.source, offset: this.token.start } });
    throw new Error(PARSE_ERROR);
  }

  /**
   * Constraints ::= '<' Constraint ( ',' Constraint )* ','? '>'
   * Constraint  ::= IDENTIFIER '=' ( IDENTIFIER | SIMPLE_NAME | NAME )
   *
   * Consumes from the opening `<` through the closing `>`. An empty `<>`, a
   * non-identifier key, and a repeated key are all errors.
   */
  private parseConstraints(): NameConstraint[] {
    this.consumeToken(TokenType.LANGLE);
    const constraints: NameConstraint[] = [];
    const seen = new Set<string>();
    for (;;) {
      const key = this.token;
      if (key.type !== TokenType.IDENTIFIER) {
        this.unexpectedTokenError("a constraint key");
      }
      if (seen.has(key.text)) {
        this.duplicateConstraintError(key.text);
      }
      seen.add(key.text);
      this.nextToken();
      this.consumeToken(TokenType.EQUALS);
      const value = this.token;
      if (
        value.type !== TokenType.IDENTIFIER &&
        value.type !== TokenType.SIMPLE_NAME &&
        value.type !== TokenType.NAME
      ) {
        this.unexpectedTokenError("a constraint value");
      }
      constraints.push([key.text, this.tokenToName(value)]);
      this.nextToken();
      /* Continue on a comma (unless it was trailing, before the '>'); otherwise
       * the list is done and a '>' must follow. */
      if (!this.consumeIfToken(TokenType.COMMA) || this.token.type === TokenType.RANGLE) {
        break;
      }
    }
    this.consumeToken(TokenType.RANGLE);
    return constraints;
  }

  private duplicateConstraintError(key: string): never {
    this.log.log(DIAG_DUP_CONSTRAINT, { key, loc: { ...this.source, offset: this.token.start } });
    throw new Error(PARSE_ERROR);
  }

  /**
   * PropertyDecl ::= NAME '=' NAME ';'
   *                       ^
   * @param name
   * @param nameOffset
   */
  private parsePropertyDecl(name: string, nameOffset: number): IPropertyDecl {
    const values: IValue[] = [];
    this.consumeToken(TokenType.EQUALS);
    while (this.token.type !== TokenType.SEMI && this.token.type !== TokenType.RBRACE) {
      values.push(this.parseValue());
    }
    this.consumeIfToken(TokenType.SEMI);
    return {
      kind: DeclKind.Property,
      source: this.source,
      name,
      offset: nameOffset,
      values,
    };
  }

  private parsePropertyList(): IPropertyDecl[] {
    const list: IPropertyDecl[] = [];
    while (this.token.type !== TokenType.RBRACE) {
      const name = this.token;
      if (name.type === TokenType.IDENTIFIER) {
        this.nextToken();
        list.push(this.parsePropertyDecl(name.text, name.start));
      } else {
        this.unexpectedTokenError("Identifier or '}'");
      }
    }
    return list;
  }

  /**
   * TargetDecl ::= NAME NAME '{' PropertyList '}'
   *                     ^
   * @param name
   * @param nameOffset
   */
  private parseTargetDecl(type: string, typeOffset: number): ITargetDecl {
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
      };
    }
  }

  /**
   * TargetDefDecl ::= 'targetdef' NAME '{' PropertyTypeList '}'
   *                     ^
   * @param name
   * @param nameOffset
   */
  private parseTargetDefDecl(): ITargetDefDecl {
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
      };
    }
  }

  /**
   * PropertyTypeList ::= PropertyType*
   * PropertyType ::= NAME '=' PropertySchema ';'
   * PropertySchema ::=  ( 'STRING'|'FILES'|'REQUIRED' )*
   *
   */
  private parsePropertyTypeList(): Record<string, IPropertySchema> {
    const result: Record<string, IPropertySchema> = {};
    while (this.token.type !== TokenType.RBRACE) {
      const name = this.token;
      let required = false;
      let type: PropertyType | undefined;
      if (name.type === TokenType.IDENTIFIER) {
        this.nextToken();
        let next = this.consumeToken(TokenType.EQUALS);
        if (next.type !== TokenType.IDENTIFIER) {
          this.unexpectedTokenError("'STRING' or 'FILES' or 'REWRITE' or 'REQUIRED'");
        } else {
          while (next.type === TokenType.IDENTIFIER) {
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
              default:
                this.unexpectedTokenError("'STRING' or 'FILES' or 'REWRITE' or 'REQUIRED'");
            }
            next = this.nextToken();
          }
        }
        if (type === undefined) {
          this.unexpectedTokenError("'STRING' or 'FILES' or 'REWRITE'");
        } else {
          result[name.text] = { required, type };
        }
        if (next.type !== TokenType.RBRACE) {
          this.consumeToken(TokenType.SEMI);
        }
      } else {
        this.unexpectedTokenError("Identifier or '}'");
      }
    }
    return result;
  }

  /**
   * Report a parse error to the diagnostic log due to an unexpected token,
   * and throw (caught by recovery). Note that the current token is _NOT_
   * consumed.
   * @param expected
   */
  private unexpectedTokenError(expected: string): never {
    /* Report an error */
    this.log.log(DIAG_PARSE_ERROR, {
      loc: { ...this.source, offset: this.token.start },
      actual: TOKEN_NAME_MAP[this.token.type],
      expected,
    });
    throw new Error(PARSE_ERROR);
  }

  private unexpectedEndOfFile(expected: string): never {
    this.log.log(DIAG_UNEXPECTED_EOF, {
      loc: { ...this.source, offset: this.token.start },
      expected,
    });
    throw new Error(PARSE_ERROR);
  }

  private invalidIncludeName(): never {
    this.log.log(DIAG_INVALID_INCLUDE, { loc: { ...this.source, offset: this.token.start } });
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
   * Statement ::= PropertyDecl | TargetDecl | IncludeDecl | PluginDecl | TargetDefDecl | DefaultPropertyDecl
   *               ^
   * PropertyDecl ::= NAME '=' expr ';'
   * TargetDecl ::= NAME NAME '{' PropertyList '}'
   * IncludeDecl ::= 'include' NAME ';'
   * PluginDecl ::= 'plugin' NAME ';'
   * TargetDefDecl ::= 'targetdef' NAME '{' PropertyTypeList '}'
   * DefaultPropertyDecl ::= 'default' PropertyDecl
   */

  public parseStatement(): void {
    const token = this.token;
    if (token.type === TokenType.IDENTIFIER) {
      const next = this.nextToken();
      if (token.text === "include") {
        this.result.includes.push(this.parseIncludeDecl());
      } else if (token.text === "plugin") {
        this.result.plugins.push(this.parsePluginDecl());
      } else if (token.text === "default" && next.type === TokenType.IDENTIFIER) {
        this.nextToken();
        this.result.defaults.push(this.parsePropertyDecl(next.text, next.start));
      } else if (next.type === TokenType.EQUALS) {
        this.result.properties.push(this.parsePropertyDecl(token.text, token.start));
      } else if (next.type === TokenType.IDENTIFIER || next.type === TokenType.SIMPLE_NAME) {
        if (token.text === "targetdef") {
          this.result.targetdefs.push(this.parseTargetDefDecl());
        } else {
          this.result.targets.push(this.parseTargetDecl(token.text, token.start));
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
  const parser = new BuildParser({ fs: EMPTY_FILESET, file: "<command-line>", reader: new StringReader(contents) }, captureLog);
  try {
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
