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
import { DeclKind, IBuildFile, IBuildFileContents, IIncludeDecl, IPropertyDecl, IPropertySchema, ITargetDecl, ITargetDefDecl, IValue, PropertyType } from "./AST";
import { Diagnostic, ISourcePosition, Log, LogLevel } from "../support/Log";
import { Name, NameBuilder } from "./Name";
import { IFileSetProvider } from "../core/FileSet";

enum TokenType {
  EOF = 0,
  IDENTIFIER,
  NAME,
  EQUALS,
  LBRACE,
  RBRACE,
  LANGLE,
  RANGLE,
  COMMA,
  SEMI,
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

interface NameToken {
  type: TokenType.NAME;
  start: number;
  text: Name;
}

interface IdentToken {
  type: TokenType.IDENTIFIER;
  start: number;
  text: string;
}

interface NonNameToken {
  type: Exclude<TokenType, TokenType.NAME | TokenType.IDENTIFIER>;
  start: number;
}

type Token = NameToken | IdentToken | NonNameToken;

const TOKEN_NAME_MAP = {
  [TokenType.EOF]: "EOF",
  [TokenType.NAME]: "Name",
  [TokenType.IDENTIFIER]: "Identifier",
  [TokenType.EQUALS]: "'='",
  [TokenType.LBRACE]: "'{'",
  [TokenType.RBRACE]: "'}'",
  [TokenType.LANGLE]: "'<'",
  [TokenType.RANGLE]: "'>'",
  [TokenType.COMMA]: "','",
  [TokenType.SEMI]: "';'",
  [TokenType.ERROR]: "ERROR",
};

function isWhitespace(ch: number): boolean {
  return ch === CHAR_NEWLINE || isWhiteSpaceChar(ch);
}

function isFirstIdentChar(ch: number): boolean {
  return isAlphabetic(ch) || ch === CHAR_UNDERSCORE || ch === CHAR_AT;
}

function isIdentChar(ch: number): boolean {
  return isFirstIdentChar(ch) || isDigit(ch) || ch === CHAR_SLASH;
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

const DIAG_PARSE_ERROR = new Diagnostic<{ actual: string; expected: string; loc: ISourcePosition }>(
  LogLevel.Error,
  "Read {actual} but expected {expected}"
);
const DIAG_UNEXPECTED_EOF = new Diagnostic<{ expected: string; loc: ISourcePosition }>(
  LogLevel.Error,
  "Unexpected end of file, expected {expected}"
);
const DIAG_INVALID_INCLUDE = new Diagnostic<{ loc: ISourcePosition }>(
  LogLevel.Error,
  "Include names cannot currently contain glob patterns or variables"
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
    };
    this.nextToken();
  }

  /* Single quotes consume everything until the next single quote.
   * Note: currently this will allow new-lines inside the quote.
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
    this.reader.next(); /* Consume the quote */
  }

  /* Double quotes can contain variables (which can contain double quotes */
  private readDoubleQuotedString(builder?: NameBuilder): void {
    this.reader.consume(CHAR_DQUOTE);
    let posn = this.reader.currentOffset();
    const next = this.reader.skipUntil(ch => {
      switch (ch) {
        case CHAR_BACKSLASH:
          this.reader.next();
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
    this.reader.next();
  }

  private readSubstVar(builder?: NameBuilder): void {
    const next = this.reader.consume(CHAR_DOLLAR);
    if (next !== CHAR_LBRACE) {
      const posn = this.reader.currentOffset();
      this.reader.skipUntil(ch => !isAlphabetic(ch) && !isDigit(ch)) !== undefined;
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
      const next = this.reader.skipUntil(ch => {
        switch (ch) {
          case CHAR_BACKSLASH:
            this.reader.next();
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
      if (next === undefined) {
        this.unexpectedEndOfFile("}");
      }
      builder?.appendSubstVar(this.reader.substring(posn));
      this.reader.consume(CHAR_RBRACE);
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
    /* Expect current character is not whitespace or a special character */
    let posn = this.reader.currentOffset();
    this.reader.skipUntil(ch => {
      if (isWhitespace(ch)) {
        return true;
      }
      switch (ch) {
        case CHAR_BACKSLASH:
          maybeIdent = false;
          this.reader.next();
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
      /* Note: if we get here, nothing has been added to the nameBuilder so we can
       * just interrogate the whole string
       */
      if (isIdentifier(rest)) {
        return { type: TokenType.IDENTIFIER, text: rest, start };
      }
    }

    nameBuilder.appendEscapedString(rest);
    return { type: TokenType.NAME, text: nameBuilder.name(), start };
  }

  private nextToken(): Token {
    const start = this.reader.currentOffset();

    /* Skip over whitespace and comments */
    let inComment = false;
    const ch = this.reader.skipUntil(ch => {
      if( inComment ) {
        if( ch === CHAR_NEWLINE ) {
          inComment = false;
        }
        return false;
      } else if( ch === CHAR_HASH ) {
        inComment = true;
        return false;
      } else {
        return !isWhitespace(ch);
      }
     });

    switch (ch) {
      case undefined:
        this.token = { type: TokenType.EOF, start };
        break;
      case CHAR_EQUALS:
        this.reader.next();
        this.token = { type: TokenType.EQUALS, start };
        break;
      case CHAR_LBRACE:
        this.reader.next();
        this.token = { type: TokenType.LBRACE, start };
        break;
      case CHAR_RBRACE:
        this.reader.next();
        this.token = { type: TokenType.RBRACE, start };
        break;
      case CHAR_LANGLE:
        this.reader.next();
        this.token = { type: TokenType.LANGLE, start };
        break;
      case CHAR_RANGLE:
        this.reader.next();
        this.token = { type: TokenType.RANGLE, start };
        break;
      case CHAR_COMMA:
        this.reader.next();
        this.token = { type: TokenType.COMMA, start };
        break;
      case CHAR_SEMI:
        this.reader.next();
        this.token = { type: TokenType.SEMI, start };
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
    if (token.type === TokenType.IDENTIFIER || token.type === TokenType.NAME) {
      const simpleName = typeof token.text === "string" ? token.text : token.text.getSimpleName();
      if (!simpleName) {
        this.invalidIncludeName();
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

  private parseValue(): IValue {
    const token = this.token;
    if (token.type === TokenType.NAME || token.type === TokenType.IDENTIFIER) {
      this.nextToken();
      return {
        kind: DeclKind.Value,
        source: this.source,
        offset: token.start,
        value: typeof token.text === "string" ? Name.fromLiteral(token.text) : token.text,
      };
    } else {
      this.unexpectedTokenError("Name");
    }
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
      values
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
    if (this.token.type !== TokenType.IDENTIFIER) {
      this.unexpectedTokenError("Identifier");
    } else {
      const nameToken = this.token;
      this.nextToken();
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
      this.consumeToken(TokenType.LBRACE);
      const properties = this.parsePropertyTypeList();
      this.consumeToken(TokenType.RBRACE);
      return {
        kind: DeclKind.TargetDef,
        source: this.source,
        name: nameToken.text,
        offset: nameToken.start,
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
  private parsePropertyTypeList() : Record<string, IPropertySchema> {
    const result: Record<string, IPropertySchema> = {};
    while (this.token.type !== TokenType.RBRACE) {
      const name = this.token;
      let required = false;
      let type : PropertyType|undefined;
      if (name.type === TokenType.IDENTIFIER) {
        this.nextToken();
        let next = this.consumeToken(TokenType.EQUALS);
        if( next.type !== TokenType.IDENTIFIER ) {
          this.unexpectedTokenError("'STRING' or 'FILES' or 'REQUIRED'");
        } else {
          while(next.type === TokenType.IDENTIFIER){
            switch(next.text) {
              case "REQUIRED":
                required = true;
                break;
              case "STRING":
                type = PropertyType.String;
                break;
              case "FILES":
                type = PropertyType.FileSet;
                break;
              default:
                this.unexpectedTokenError("'STRING' or 'FILES' or 'REQUIRED'");
            }
            next = this.nextToken();
          }
        }
        if( type === undefined ) {
          this.unexpectedTokenError("'STRING' or 'Files'");
        } else {
          result[name.text] = {required, type};
        }
        if( next.type !== TokenType.RBRACE ) {
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

  /**
   * Parse a statement.
   *
   * Statement ::= PropertyDecl | TargetDecl | IncludeDecl | TargetDefDecl | DefaultPropertyDecl
   *               ^
   * PropertyDecl ::= NAME '=' expr ';'
   * TargetDecl ::= NAME NAME '{' PropertyList '}'
   * IncludeDecl ::= 'include' NAME ';'
   * TargetDefDecl ::= 'targetdef' NAME '{' PropertyTypeList '}'
   * DefaultPropertyDecl ::= 'default' PropertyDecl
   */

  public parseStatement(): void {
    const token = this.token;
    if (token.type === TokenType.IDENTIFIER) {
      const next = this.nextToken();
      if (token.text === "include") {
        this.result.includes.push(this.parseIncludeDecl());
      } else if(token.text === "default" && next.type === TokenType.IDENTIFIER) {
        this.nextToken();
        this.result.defaults.push(this.parsePropertyDecl(next.text, next.start));
      } else if (next.type === TokenType.EQUALS) {
        this.result.properties.push(this.parsePropertyDecl(token.text, token.start));
      } else if (next.type === TokenType.IDENTIFIER) {
        if( token.text === "targetdef" ) {
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
   * Very basic error recovery - skip tokens until we find a ';' or '}' followed by a NAME,
   * so that parsing can resume on the NAME.
   */
  private recoverFromError(): void {
    let last = this.token.type;
    while (last !== TokenType.EOF) {
      const next = this.nextToken();
      if ((last === TokenType.SEMI || last === TokenType.RBRACE) && next.type === TokenType.NAME) {
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

export function parseBuildString(fs: IFileSetProvider, file: string, contents: string, log: Log): IBuildFileContents {
  return new BuildParser({ fs, file, reader: new StringReader(contents) }, log).parse();
}
