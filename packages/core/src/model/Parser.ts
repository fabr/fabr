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
import { isReplacing, PatternEdit, PatternOperator } from "../support/PatternEdit";
import { isWhiteSpace as isWhiteSpaceChar, isAlphabetic, isDigit } from "unicode-properties";
import {
  DeclKind,
  IBuildFile,
  IBuildFileContents,
  IFabrDecl,
  IResolvableDecl,
  IIncludeDecl,
  IMapItemDecl,
  IPluginDecl,
  IRepositoryDecl,
  IRuleBlock,
  IRuleDecl,
  IPropertyDecl,
  ICommandStage,
  CommandPipeline,
  StreamName,
  ICommandValue,
  INameValue,
  IPropertySchema,
  isMapValue,
  isPropertyDecl,
  isNameValue,
  ITargetDecl,
  ITargetDefDecl,
  IValue,
  optionalLibOf,
  PropertyType,
} from "./AST";
import { Diagnostic, ISourcePosition, Log, LogLevel } from "../support/Log";
import { Name, NameBuilder, NameConstraint } from "../core/Name";
import { EMPTY_FILESET, FileSource } from "../core/FileSet";
import { FabrError } from "../core/Errors";
import { parseVersion, versionToString } from "../resolver/Semver";
import { COMMAND_LINE_FILE } from "../core/Constants";

/**
 * A token's type. A bare name token is one of three tiers, by the characters it
 * contains, narrowest first:
 *
 * - `IDENTIFIER` — `@`/`_`/alphanumeric, plus interior `-` (`@fabr-build`,
 *   `my-target`): keywords, property names, constraint keys, target types.
 * - `SIMPLE_NAME` — IDENTIFIER plus interior `/` and `.` (`@fabr-build/js`,
 *   `lib/utils`, `lodash.merge`): a declared name, a simple path, or a
 *   reference with no `:`.
 * - `NAME` — anything else: text with a `:` (`@npm:pkg:1.2.3`), a glob
 *   character (`* ? [`), quoting or a substitution. A declared name may not be
 *   a NAME: `foo:bar` would read as projecting `bar` out of target `foo`.
 *
 * A reference's `<k=v>` and `-> rename` are separate tokens (`LANGLE`, `ARROW`),
 * which {@link BuildParser.parseReference} adds to a base token of any tier.
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
  /* Command-pipeline operators. Stdin `<` and stdout `>` are LANGLE/RANGLE (a
   * `<` that does not abut a name is no `<k=v>`); these have their own tokens:
   * the pipe, the redirects `1>`/`2>`/`&>` (a `1`/`2`/`&` abutting `>`), and
   * the `N>&M` dup, which takes no target. */
  PIPE,
  REDIR_STDOUT,
  REDIR_STDERR,
  REDIR_BOTH,
  REDIR_DUP,
  /** The `` ` `` closing a command substitution. */
  BACKTICK,
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
const CHAR_AMP = "&".codePointAt(0);
const CHAR_BACKTICK = "`".codePointAt(0);
const CHAR_COLON = ":".codePointAt(0);
const CHAR_PIPE = "|".codePointAt(0);
const CHAR_LPAREN = "(".codePointAt(0);
const CHAR_RPAREN = ")".codePointAt(0);
const CHAR_BANG = "!".codePointAt(0);
const CHAR_PLUS = "+".codePointAt(0);
const CHAR_PERCENT = "%".codePointAt(0);

interface TokenBase {
  start: number;
  /** The doc comment before this token ({@link extractDocComment}), if any.
   * Declaration parsers read it off a declaration's first token. */
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

/** `N>&M` — the fds it names, already validated to be 1 or 2. */
interface DupToken extends TokenBase {
  type: TokenType.REDIR_DUP;
  from: number;
  to: number;
}

interface NonNameToken extends TokenBase {
  type: Exclude<TokenType, TokenType.NAME | TokenType.IDENTIFIER | TokenType.SIMPLE_NAME | TokenType.REDIR_DUP>;
}

type Token = NameToken | IdentToken | DupToken | NonNameToken;

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
  [TokenType.REDIR_DUP]: "'2>&1'",
  [TokenType.BACKTICK]: "'`'",
  [TokenType.ERROR]: "ERROR",
};

/** The redirect token for each fd-prefix word abutting `>` (`1>`/`2>`/`&>`). */
const REDIR_FD_TOKEN: Record<string, TokenType.REDIR_STDOUT | TokenType.REDIR_STDERR | TokenType.REDIR_BOTH> = {
  "1": TokenType.REDIR_STDOUT,
  "2": TokenType.REDIR_STDERR,
  "&": TokenType.REDIR_BOTH,
};

/** A command-pipeline operator: `Pipe` the `|` between stages, `Stdin` `<`,
 * `Stdout` `>` or `1>`, `Stderr` `2>`, `Both` `&>`, `Dup` `N>&M`. */
const enum CommandOpKind {
  Pipe,
  Stdin,
  Stdout,
  Stderr,
  Both,
  Dup,
}

/** @return true if an operator is followed by a target name (every redirect
 * but a dup, `2>&1`), otherwise false. */
function takesTarget(op: CommandOpKind): boolean {
  return op !== CommandOpKind.Pipe && op !== CommandOpKind.Dup;
}

/** A pipeline operator, its source offset, and for a dup the fds it names
 * (`{from: 2, to: 1}` for `2>&1`). */
type CommandOp = { op: CommandOpKind; at: number; from?: number; to?: number };

const OP_SYMBOL: Record<CommandOpKind, string> = {
  [CommandOpKind.Pipe]: "|",
  [CommandOpKind.Stdin]: "<",
  [CommandOpKind.Stdout]: ">",
  [CommandOpKind.Stderr]: "2>",
  [CommandOpKind.Both]: "&>",
  [CommandOpKind.Dup]: "N>&M",
};

/** @return the error message for a redirect operator with no target. */
function missingTarget(op: CommandOpKind): string {
  return `redirect '${OP_SYMBOL[op]}' must be followed by a target name`;
}

/**
 * Where one of a stage's output streams goes: the name its output is captured
 * as, or, with no `file`, the stream's default (for stdout the next stage or
 * the pipeline's output, for stderr the diagnostic output).
 *
 * Object identity matters: a dup makes both streams refer to one `Dest`, and a
 * later capture replaces one side's object, leaving the other where the dup put
 * it (`2>&1 > f`). Two streams share a destination exactly when `err === out`.
 */
type Dest = { file?: INameValue };

/** A stage's output fds while its redirects are applied, left to right. `out`
 * and `err` start as two distinct objects, both with no `file`. */
interface StageFds {
  out: Dest;
  err: Dest;
  /** The stream the other was merged into by a dup or `&>`. Read it only
   * while `out` and `err` are still one object: a later capture separates them
   * and leaves this stale. */
  mergedTo?: StreamName;
}

/** A stage under construction, with the fd table {@link flattenStage} writes
 * onto it. */
interface PendingStage {
  stage: ICommandStage;
  fds: StageFds;
}

function newStageFds(): StageFds {
  return { out: {}, err: {} };
}

/** Each stream's name in a diagnostic. */
const STREAM_LABEL: Record<StreamName, string> = { out: "stdout", err: "stderr" };

/**
 * Write the fd table onto the stage: `stdout` and `stderr` from the captures,
 * and `mergedTo` where the two streams share one destination, the merged
 * stream's capture left out. `&> n` and `> n 2>&1` give the same stage.
 *
 * Whether they share is read from `out === err` at the end of the stage, so a
 * capture after a dup (`2>&1 > f`, stderr left on its default) is no merge.
 */
function flattenStage({ stage, fds }: PendingStage): ICommandStage {
  const mergedTo = fds.err === fds.out ? fds.mergedTo : undefined;
  if (mergedTo !== "err" && fds.out.file !== undefined) {
    stage.stdout = fds.out.file;
  }
  if (mergedTo !== "out" && fds.err.file !== undefined) {
    stage.stderr = fds.err.file;
  }
  stage.mergedTo = mergedTo;
  return stage;
}

/** @return true if `name` is written `<package>:<path>`, an include of a plugin's optional lib, otherwise false. */
function isOptionalLibName(name: Name): boolean {
  const lib = optionalLibOf(name);
  return lib !== undefined && lib.plugin !== "" && !lib.path.isEmpty() && !lib.path.hasLevelSeparator();
}

function isWhitespace(ch: number): boolean {
  // unicode-properties' isWhiteSpace covers space and the Unicode Zs category
  // but not TAB, LF, VT, FF and CR (0x09–0x0D), which are added here.
  return (ch >= 0x09 && ch <= 0x0d) || isWhiteSpaceChar(ch);
}

/** @return true if `ch` may follow the `>` of a `->` arrow (which must be
 * whitespace-delimited), otherwise false. */
function isArrowTerminator(ch: number | undefined): boolean {
  return ch === undefined || isWhitespace(ch);
}

/**
 * Extract the doc comment from the whitespace and comments (`gap`) before a
 * token: the last contiguous run of `#` comment lines in it, with only blank
 * lines between it and the token. An earlier block, separated from that one by
 * a blank line, is not part of it. Each line loses its leading whitespace, its
 * `#` marker and one following space; blank `#` lines at either end are
 * dropped.
 *
 * Gotcha: a trailing comment on the line before (`x = y; # note`) is taken as
 * the next token's doc comment too.
 *
 * @return the comment's lines joined with newlines, or undefined where the gap
 * holds no comment.
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

/* The characters after the first of an IDENTIFIER and a SIMPLE_NAME (see
 * {@link TokenType}). Both start like an identifier, so a name starting with
 * `.`, `-`, `/` or a digit (`./x`, `1.2.3`) is a NAME, as is any with a `:`. */
function isIdentChar(ch: number): boolean {
  return isFirstIdentChar(ch) || isDigit(ch) || ch === CHAR_DASH;
}

function isSimpleNameChar(ch: number): boolean {
  return isIdentChar(ch) || ch === CHAR_SLASH || ch === CHAR_DOT;
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

/** @return true if `text` is a SIMPLE_NAME (an identifier's characters plus
 * interior `/` and `.`), otherwise false. */
function isSimpleName(text: string): boolean {
  const first = text.codePointAt(0);
  if (first === undefined || !isFirstIdentChar(first)) return false;
  for (const code of codepoints(text)) {
    if (!isSimpleNameChar(code)) return false;
  }
  return true;
}

/** @return true if `text` is an exact semver version in its canonical form, otherwise false. */
function isCanonicalVersion(text: string): boolean {
  try {
    return versionToString(parseVersion(text)) === text;
  } catch {
    return false;
  }
}

/** The deepest `{ ... }` blocks may nest; deeper is reported as an error. */
const MAX_BLOCK_DEPTH = 100;

/**
 * The kind of a `<k=v>` list. On a reference it is a `"requirement"`: the
 * configuration the reference is built under, its values exact. On a property
 * key it is a `"guard"`: the configurations the declaration applies in, its
 * values patterns. A `"rule"` guard is a guard whose keys may also name a
 * property of the rule's target (`pkg.test_framework`).
 */
type ConstraintKind = "requirement" | "guard" | "rule";

const DIAG_PARSE_ERROR = new Diagnostic<{ actual: string; expected: string; loc: ISourcePosition }>(
  LogLevel.Error,
  "Read {actual} but expected {expected}"
);
const DIAG_DUP_CONSTRAINT = new Diagnostic<{ key: string; loc: ISourcePosition }>(LogLevel.Error, "Duplicate constraint key '{key}'");
const DIAG_UNEXPECTED_EOF = new Diagnostic<{ expected: string; loc: ISourcePosition }>(
  LogLevel.Error,
  "Unexpected end of file, expected {expected}"
);
const DIAG_RENAME_TEMPLATE = new Diagnostic<{ detail: string; loc: ISourcePosition }>(
  LogLevel.Error,
  "Invalid rename template: {detail}"
);
const DIAG_GLOB_CONSTRAINT = new Diagnostic<{ key: string; loc: ISourcePosition; help: string[] }>(
  LogLevel.Error,
  "Constraint '{key}' is required as a pattern, but a requirement names an exact configuration"
);
const DIAG_GUARDED_SPLICE = new Diagnostic<{ loc: ISourcePosition }>(
  LogLevel.Error,
  "A splice of a target's properties takes no guard"
);

const DIAG_SPACED_GUARD = new Diagnostic<{ loc: ISourcePosition; help: string[] }>(
  LogLevel.Error,
  "A constraint guard must abut the property name"
);
const DIAG_GUARD_CONFLICT = new Diagnostic<{ key: string; site: string; loc: ISourcePosition }>(
  LogLevel.Error,
  "Constraint '{key}' is guarded on twice — by an enclosing block and by {site}"
);
const DIAG_INVALID_SUBSTITUTION = new Diagnostic<{ detail: string; loc: ISourcePosition }>(
  LogLevel.Error,
  "Invalid substitution: {detail}"
);
const DIAG_INVALID_COMMAND = new Diagnostic<{ detail: string; loc: ISourcePosition }>(LogLevel.Error, "Invalid command: {detail}");
const DIAG_INVALID_INCLUDE = new Diagnostic<{ detail: string; loc: ISourcePosition }>(
  LogLevel.Error,
  "Invalid include name: {detail}"
);
const DIAG_ABSOLUTE_INCLUDE = new Diagnostic<{ loc: ISourcePosition }>(
  LogLevel.Error,
  "Include paths must be relative to the including file"
);
const DIAG_RULE_GUARD_KEY = new Diagnostic<{ key: string; param: string; loc: ISourcePosition }>(
  LogLevel.Error,
  "Rule guard '{key}' is neither a property of the configuration nor one of '{param}'"
);
const DIAG_INVALID_IMPLEMENTATION = new Diagnostic<{ loc: ISourcePosition }>(
  LogLevel.Error,
  "An implementation names an entry of a package, as 'package:entry' (no glob patterns or variables)"
);
/** The keywords whose declarations cannot be written `default` (`default rule` is read before these). */
const DEFAULT_REFUSED = new Set(["targetdef", "private", "repository"]);
/** The declarations that cannot be private, by their keyword. */
const PRIVATE_REFUSED = new Set(["include", "plugin", "rule", "targetdef", "default", "private", "repository"]);
/** The declarations a rule's block cannot hold, by their keyword. */
const RULE_BLOCK_REFUSED = new Set(["include", "plugin", "rule", "targetdef", "default", "private", "repository"]);
const DIAG_RULE_BLOCK_DECL = new Diagnostic<{ keyword: string; loc: ISourcePosition }>(
  LogLevel.Error,
  "A rule's block declares only targets and properties, not '{keyword}'"
);
const DIAG_INVALID_PLUGIN = new Diagnostic<{ loc: ISourcePosition }>(
  LogLevel.Error,
  "A plugin is named by a reference, with no glob patterns, variables or rename"
);
const DIAG_INVALID_FABR = new Diagnostic<{ loc: ISourcePosition }>(
  LogLevel.Error,
  "The fabr release is declared as 'fabr <version>;', its exact version written as it is (such as 'fabr 0.4.0;')"
);
/** A `fabr <version>;` anywhere but the first statement of the project file. */
export const DIAG_FABR_PLACEMENT = new Diagnostic<{ loc: ISourcePosition }>(
  LogLevel.Error,
  "The fabr release is declared only by the first statement of the project file"
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
const DIAG_NESTED_NEGATION = new Diagnostic<{ loc: ISourcePosition }>(
  LogLevel.Error,
  "A '!(…)' group cannot be inside another extglob group"
);

/** @return true if a name is the bare `*` wildcard, otherwise false (as for a
 * quoted `'*'`, the literal character). */
function isWildcardKey(name: Name): boolean {
  const units = name.getGlobUnits();
  return units.length === 1 && units[0] === "*" && name.toString() === "*";
}

/**
 * @return `selector`'s glob units with its `!(…)` groups left out: a group subtracts
 * from what the selector matches and captures nothing for a template to replay.
 */
function unitsOutsideNegations(selector: Name): string[] {
  const units: string[] = [];
  let depth = 0;
  for (const unit of selector.getGlobUnits()) {
    let outside = "";
    for (let at = 0; at < unit.length; at++) {
      if (depth > 0) {
        depth += unit[at] === "(" ? 1 : unit[at] === ")" ? -1 : 0;
      } else if (unit.startsWith("!(", at)) {
        depth = 1;
        at++;
      } else {
        outside += unit[at];
      }
    }
    if (outside !== "") {
      units.push(outside);
    }
  }
  return units;
}

/**
 * Check that a rename template's wildcards can be filled from the selector's.
 * Both sides may use only `*` and `**`, a `!(…)` group in the selector not
 * counted. A positional template has as many wildcards as the selector; a
 * numbered one (`$1`) may use them in any number and order, each index naming
 * one the selector has. The two forms may not be mixed.
 *
 * A template with no wildcards is exempt, and its selector may be any pattern;
 * where it selects several different files, `FileSet.rename` reports the
 * conflict.
 *
 * @return the error message, or undefined where the template is valid.
 */
function checkRenameWildcards(selector: Name, template: Name): string | undefined {
  const templateUnits = template.getGlobUnits();
  const captures = template.getBackrefIndices();
  if (templateUnits.length === 0 && captures.length === 0) {
    return undefined;
  }
  const selectorUnits = unitsOutsideNegations(selector);
  const bad = [...selectorUnits, ...templateUnits].find(unit => unit !== "*" && unit !== "**");
  if (bad !== undefined) {
    return `rename wildcards must be '*' or '**' (found '${bad}')`;
  }
  if (captures.length > 0) {
    /* A numbered template may reuse a wildcard (`v$1/node-v$1`), reorder them
     * or leave some unused; each index must name one the selector has. */
    if (templateUnits.length > 0) {
      return "a rename template replays wildcards either positionally ('*') or by number ('$1'), not both";
    }
    const outOfRange = captures.find(index => index < 1 || index > selectorUnits.length);
    if (outOfRange !== undefined) {
      return selectorUnits.length === 0
        ? `'$${outOfRange}' has no wildcard to replay — the selector has none`
        : `'$${outOfRange}' is out of range — the selector has ${selectorUnits.length} wildcard(s)`;
    }
    return undefined;
  }
  if (selectorUnits.length !== templateUnits.length) {
    return `selector and template must have equal wildcard counts (${selectorUnits.length} vs ${templateUnits.length})`;
  }
  return undefined;
}

/** Thrown once an error has been reported, to abandon what is being parsed;
 * recovery catches it and resumes at the next statement or property. */
class ParseAbort extends FabrError {
  constructor() {
    super("Parse Error");
  }
}

/** The lexer and parser of one build file. It resolves nothing. */
export class BuildParser {
  private reader: StringReader;
  private log: Log;
  private token: Token;
  /** True where the current token follows the previous one with no whitespace
   * between. A `<k=v>` or a `:projection` tail binds to a reference only where
   * it abuts it. */
  private tokenAbutsPrev = false;
  /** The end offset (exclusive) of the most recently consumed token. */
  private prevTokenEnd = 0;
  /** Set while lexing a `<k=v>` list, where `1>`/`2>` are not redirects: `<X=1>`
   * is the value `1` and the closing `>`. */
  private suppressRedirect = false;
  /** Current `{ ... }` block nesting, bounded by {@link MAX_BLOCK_DEPTH}. */
  private blockDepth = 0;
  /** Non-zero while lexing inside a `` `cmd` `` substitution, where a backtick
   * closes it (substitutions do not nest). A counter so that it restores
   * correctly; it never exceeds 1. */
  private commandSubstDepth = 0;

  private source: IBuildFile;
  private result: IBuildFileContents;
  /** The statements parsed so far, those with errors included. */
  private statements = 0;

  constructor(source: IBuildFile, log: Log) {
    this.reader = source.reader;
    this.log = log;
    this.token = { type: TokenType.ERROR, start: 0 };
    this.source = source;
    this.result = {
      targets: [],
      targetdefs: [],
      properties: [],
      defaults: [],
      includes: [],
      plugins: [],
      rules: [],
      repositories: [],
    };
    this.skipToken();
  }

  /** Read a single-quoted string, through its closing quote: everything
   * between the quotes is literal text, newlines included.
   * @param builder receives the quoted text
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

  /** Read a double-quoted string, through its closing quote. A backslash
   * escapes the next character; `$` and `${…}` substitutions, and command
   * substitutions outside one, are read inside it. */
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
        case CHAR_BACKTICK:
          /* A command substitution, as in a bare name. Inside a substitution's
           * own quoted word a backtick is a literal character. */
          if (this.commandSubstDepth === 0) {
            builder?.appendEscapedString(this.reader.substring(posn));
            this.readCommandSubst(builder);
            posn = this.reader.currentOffset();
          }
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

  /** Read a variable substitution (`$NAME` or `${…}`), leaving the reader at
   * the first character after it. */
  private readSubstVar(builder?: NameBuilder): void {
    const next = this.reader.consume(CHAR_DOLLAR);
    if (next !== CHAR_LBRACE) {
      const posn = this.reader.currentOffset();
      this.reader.skipUntil(ch => !isAlphabetic(ch) && !isDigit(ch) && ch !== CHAR_UNDERSCORE);
      const str = this.reader.substring(posn);
      if (str.length === 0) {
        /* A `$` with no name after it is a literal `$`. */
        builder?.appendLiteralString("$");
      } else {
        builder?.appendSubstVar(str);
      }
    } else {
      this.readBracedSubstVar(builder);
    }
  }

  /**
   * Read the `{NAME}`, `{NAME<k=v>}` or `{NAME…edit}` of a braced substitution,
   * from its `{` to just past its `}`. The name is a property name or
   * `<name>.<name>`, whitespace around it ignored. The name and the edit are
   * read by character (a name token would take in `/` and `*`, and a `#` would
   * start a comment); the `<k=v>` is read as tokens, as on a reference.
   *
   * This runs inside the scan of an enclosing token, so the token state is
   * restored on return.
   */
  private readBracedSubstVar(builder?: NameBuilder): void {
    const outer = { token: this.token, abuts: this.tokenAbutsPrev, prevEnd: this.prevTokenEnd };
    this.reader.next(); /* the '{' */
    try {
      this.reader.skipUntil(ch => !isWhitespace(ch));
      const nameStart = this.reader.currentOffset();
      this.reader.skipUntil(ch => !isIdentChar(ch) && ch !== CHAR_DOT);
      const name = this.reader.substring(nameStart);
      /* A property name, or a property of one (`pkg.version`, of a rule's parameter). */
      const parts = name.split(".");
      if (!isIdentifier(name) && !(parts.length === 2 && parts.every(isIdentifier))) {
        this.unexpectedCharacterError("a property name", nameStart, name === "" ? undefined : "Name");
      }
      let constraints: NameConstraint[] | undefined;
      if (this.reader.current() === CHAR_LANGLE) {
        this.nextToken(); /* the '<' */
        this.nextToken();
        constraints = this.parseConstraintList(undefined, "requirement", false);
      }
      this.reader.skipUntil(ch => !isWhitespace(ch));
      const edit = this.reader.current() === CHAR_RBRACE || this.reader.eof() ? undefined : this.readPatternEdit();
      if (this.reader.current() !== CHAR_RBRACE) {
        this.unexpectedCharacterError("'}'", this.reader.currentOffset());
      }
      this.reader.next(); /* the '}' */
      builder?.appendSubstVar(name, constraints, edit);
    } finally {
      this.token = outer.token;
      this.tokenAbutsPrev = outer.abuts;
      this.prevTokenEnd = outer.prevEnd;
    }
  }

  /** Read the edit after a substitution's name, bash's `#pattern`, `##pattern`,
   * `%pattern`, `%%pattern`, and `/pattern/replacement` with `/`, `//`, `/#` or
   * `/%`, leaving the reader at the closing `}`. A pattern runs to the `}`, or a
   * replacing edit's to the `/` before its replacement; a backslash quotes the
   * next character. A `$` or backtick in either is reported as an error. */
  private readPatternEdit(): PatternEdit {
    const start = this.reader.currentOffset();
    const first = this.reader.current();
    let operator: PatternOperator;
    if (first === CHAR_HASH || first === CHAR_PERCENT) {
      const single = first === CHAR_HASH ? "#" : "%";
      const doubled = this.reader.next() === first;
      if (doubled) {
        this.reader.next();
      }
      operator = (doubled ? single + single : single) as PatternOperator;
    } else if (first === CHAR_SLASH) {
      const next = this.reader.next();
      operator = next === CHAR_SLASH ? "//" : next === CHAR_HASH ? "/#" : next === CHAR_PERCENT ? "/%" : "/";
      if (operator !== "/") {
        this.reader.next();
      }
    } else {
      this.unexpectedCharacterError("'}' or an edit ('#', '%' or '/')", start);
    }
    const replacing = isReplacing(operator);
    const pattern = this.readEditText(replacing ? [CHAR_SLASH, CHAR_RBRACE] : [CHAR_RBRACE]);
    if (!replacing) {
      return { operator, pattern };
    }
    if (this.reader.current() !== CHAR_SLASH) {
      return { operator, pattern, replacement: "" };
    }
    this.reader.next();
    return { operator, pattern, replacement: this.readEditText([CHAR_RBRACE]) };
  }

  /** Read an edit's pattern or replacement as written, up to the first of
   * `ends` not quoted by a backslash, leaving the reader at that character. */
  private readEditText(ends: ReadonlyArray<number | undefined>): string {
    const start = this.reader.currentOffset();
    let quoted = false;
    const end = this.reader.skipUntil(ch => {
      if (quoted) {
        quoted = false;
        return false;
      }
      if (ch === CHAR_DOLLAR || ch === CHAR_BACKTICK) {
        this.invalidSubstitution("a substitution inside a pattern or replacement is not supported", this.reader.currentOffset());
      }
      quoted = ch === CHAR_BACKSLASH;
      return ends.includes(ch);
    });
    if (end === undefined) {
      this.unexpectedCharacterError("'}'", this.reader.currentOffset());
    }
    return this.reader.substring(start);
  }

  private invalidSubstitution(detail: string, offset: number): never {
    this.log.log(DIAG_INVALID_SUBSTITUTION, { detail, loc: { ...this.source, offset } });
    throw new ParseAbort();
  }

  /** Report that `expected` was wanted at `at`, naming what was read as
   * `actual`, else the character at the reader (or EOF), and throw. */
  private unexpectedCharacterError(expected: string, at: number, actual?: string): never {
    const ch = this.reader.current();
    this.log.log(DIAG_PARSE_ERROR, {
      loc: { ...this.source, offset: at },
      actual: actual ?? (ch === undefined ? TOKEN_NAME_MAP[TokenType.EOF] : `'${String.fromCodePoint(ch)}'`),
      expected,
    });
    throw new ParseAbort();
  }

  /** Read a `[...]` character class, through its `]`, as glob text. */
  private readCharClass(builder?: NameBuilder): void {
    const start = this.reader.currentOffset();
    const next = this.reader.consume(CHAR_LSQUARE);
    if (next === CHAR_RSQUARE) {
      this.reader.next(); /* a ']' right after '[' (or '[^') is a literal member */
    }
    /* Scan to the closing ']'. The contents are literal (a '$' matches '$'),
     * bar a POSIX class ('[:alpha:]', '[.coll.]', '[=e=]'), skipped whole so its
     * ':]' / '.]' / '=]' does not close the class. */
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

  /** @return the length, brackets included, of the POSIX class element
   * ('[:name:]', '[.coll.]', '[=equiv=]') starting at the reader, or 0 where
   * none does (its closing '<kind>]' must come before any ']'). Reads ahead
   * without moving the reader. */
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

  /**
   * Read a name token, up to whitespace or one of `, = { } ; < > #` (and,
   * inside a command substitution, a backtick). Quoted strings, backslash
   * escapes, `$` and command substitutions, wildcards, character classes and
   * extglob groups (`!(…)`, `@(…)`, `*(…)`, `?(…)`, `+(…)`) are read as parts of
   * the name.
   *
   * @return an IDENTIFIER or SIMPLE_NAME token for plain text of that tier,
   * otherwise a NAME token holding the Name, its override marker set where it
   * ends in an unquoted `?` or `!` after another character. An extglob group
   * left open, or a `!(` inside another group, is reported and thrown.
   */
  private readNameOrIdentifier(): Token {
    const start = this.reader.currentOffset();
    const nameBuilder = new NameBuilder();
    let maybeIdent = true;
    /* The depth of open extglob groups, and the offset of the outermost one
     * for the unterminated-group error. */
    let extglobDepth = 0;
    let extglobStart = 0;
    /* Whether the name ends in an override marker: a `?` or `!` written
     * unquoted after at least one other character (see Name.getMarker). */
    let marked = false;
    const endsName = (ch: number | undefined): boolean =>
      ch === undefined ||
      isWhitespace(ch) ||
      [CHAR_COMMA, CHAR_EQUALS, CHAR_LBRACE, CHAR_RBRACE, CHAR_SEMI, CHAR_LANGLE, CHAR_RANGLE, CHAR_HASH].includes(ch) ||
      (ch === CHAR_BACKTICK && this.commandSubstDepth > 0);
    /* The reader is at a character that starts a name. Quoted strings,
     * substitutions and character classes are read whole by their readers; the
     * scan moves past what they leave. */
    let posn = this.reader.currentOffset();
    /* Append an extglob leader, `X(`, as glob text and enter the group. Its
     * interior is scanned as the rest of the name is. */
    const openExtglob = (leader: number): void => {
      if (leader === CHAR_BANG && extglobDepth > 0) {
        this.nestedNegationError(this.reader.currentOffset());
      }
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
        case CHAR_BACKTICK:
          /* Inside a substitution's words a backtick ends the word and the
           * substitution; substitutions do not nest. */
          if (this.commandSubstDepth > 0) {
            return true;
          }
          maybeIdent = false;
          nameBuilder.appendEscapedString(this.reader.substring(posn));
          this.readCommandSubst(nameBuilder);
          posn = this.reader.currentOffset();
          break;
        case CHAR_STAR:
        case CHAR_QUESTION:
          /* A wildcard, or an extglob leader before a `(` (`*(a|b)`, `?(a|b)`);
           * `**(` reads as `*` then `*(`. */
          if (this.reader.peekAt(1) === CHAR_LPAREN) {
            openExtglob(ch);
            break;
          }
          maybeIdent = false;
          marked = ch === CHAR_QUESTION && this.reader.currentOffset() > start && endsName(this.reader.peekAt(1));
          nameBuilder.appendEscapedString(this.reader.substring(posn));
          nameBuilder.appendGlobMetachars(String.fromCodePoint(ch));
          posn = this.reader.currentOffset() + 1;
          break;
        case CHAR_BANG:
        case CHAR_PLUS:
        case CHAR_AT:
          /* An extglob leader where a `(` abuts; otherwise a literal character
           * (`@npm:pkg`, `1.0.0+build`). A leading `!` is literal too, not
           * picomatch's whole-pattern negation (see escapeGlob in Name.ts). */
          if (this.reader.peekAt(1) === CHAR_LPAREN) {
            openExtglob(ch);
          } else if (ch === CHAR_BANG && this.reader.currentOffset() > start && endsName(this.reader.peekAt(1))) {
            marked = true;
            maybeIdent = false;
          }
          break;
        case CHAR_RPAREN:
        case CHAR_PIPE:
          /* Inside an extglob group `)` closes it and `|` separates its
           * alternatives; outside one both are literal (`a|b` names that file). */
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

    /* A group left open at the end of the name is an error, as an unterminated
     * `[...]` class is; such a file name must be quoted. */
    if (extglobDepth > 0) {
      this.unterminatedExtglobError(extglobStart);
    }

    const rest = this.reader.substring(posn);
    if (maybeIdent) {
      /* Plain literal text: an IDENTIFIER or SIMPLE_NAME where it is one, else
       * a NAME. */
      if (isIdentifier(rest)) {
        return { type: TokenType.IDENTIFIER, text: rest, start };
      } else if (isSimpleName(rest)) {
        return { type: TokenType.SIMPLE_NAME, text: rest, start };
      }
    }

    nameBuilder.appendEscapedString(rest);
    const name = nameBuilder.name();
    return { type: TokenType.NAME, text: marked ? name.withMarker() : name, start };
  }

  /**
   * Parse the whole source as one reference, read as in a build file (a
   * command-line name, `fabr cat pkg:build/*.js`). Text left after the
   * reference is reported as an error.
   *
   * @return the reference, or the empty name for empty input or input starting
   * with an operator.
   */
  public parseName(): Name {
    /* The constructor already primed the first token */
    const token = this.token;
    if (token.type === TokenType.NAME || token.type === TokenType.IDENTIFIER || token.type === TokenType.SIMPLE_NAME) {
      const name = this.parseReference();
      /* The whole input is one name: report anything after it, such as a
       * `<...>` with a space before it, which does not bind. */
      if (this.token.type !== TokenType.EOF) {
        this.unexpectedTokenError("end of input");
      }
      return name;
    }
    /* Empty input or a leading operator yields the empty name. */
    return Name.fromLiteral("");
  }

  /**
   * Advance to the next token without throwing, for recovery and for reading
   * the first token. A lexical error is reported and the token becomes an
   * `ERROR` token past it, which {@link unexpectedTokenError} refuses without
   * reporting again.
   */
  private skipToken(): Token {
    const from = this.reader.currentOffset();
    try {
      return this.nextToken();
    } catch (error) {
      if (!(error instanceof ParseAbort)) {
        throw error;
      }
      if (this.reader.currentOffset() === from) {
        this.reader.next();
      }
      this.token = { type: TokenType.ERROR, start: from };
      return this.token;
    }
  }

  /** Read the next token into `this.token`, skipping whitespace and `#`
   * comments, and attach the doc comment from the gap before it. */
  private nextToken(): Token {
    const start = this.reader.currentOffset();
    /* The reader is just past the previous token, so this is its end. */
    this.prevTokenEnd = start;

    /* Skip whitespace and comments. */
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

    /* The token starts here, past the gap; it abuts the previous token where
     * there was none. Position each token at `tokenStart`, not `start`, which is
     * the start of the whitespace before it. */
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
      case CHAR_BACKTICK:
        /* Inside a substitution a backtick closes it and is a token of its own.
         * Outside one it opens a substitution, which is part of a name
         * (`V = \`node --version\`;`), read by the name scan. */
        if (this.commandSubstDepth > 0) {
          this.reader.next();
          this.token = { type: TokenType.BACKTICK, start: tokenStart };
          break;
        }
        this.token = this.readNameOrIdentifier();
        break;
      case CHAR_DASH:
        /* A `->` followed by whitespace or the end is the rename ARROW
         * (`sel -> tmpl`); any other `-` starts a name. In `sel-> x` the name
         * takes the `-` and the `>` is a RANGLE, which the value parser reports
         * with a spacing hint. */
        if (this.reader.peekAt(1) === CHAR_RANGLE && isArrowTerminator(this.reader.peekAt(2))) {
          this.reader.next(); /* the '-' */
          this.reader.next(); /* the '>' */
          this.token = { type: TokenType.ARROW, start: tokenStart };
          break;
        }
        this.token = this.readNameOrIdentifier();
        break;
      default:
        /* A name. */
        this.token = this.readNameOrIdentifier();
    }
    /* A bare `1`/`2`/`&` word with a `>` abutting it is one redirect token
     * (`2>`, `&>`); a spaced `2 >` is the word `2` and a `>`. Validate refuses a
     * redirect outside a command value. */
    const fd = this.redirectFdText();
    if (!this.suppressRedirect && fd !== undefined && this.reader.current() === CHAR_RANGLE) {
      this.reader.next(); /* the '>' */
      this.token = { type: REDIR_FD_TOKEN[fd], start: this.token.start };
      /* `N>&M` is a dup (stream N takes stream M's current destination), one
       * token with no target; `readDupFd` checks that M is 1 or 2. */
      const from = fd === "1" ? 1 : fd === "2" ? 2 : undefined;
      if (from !== undefined && this.reader.current() === CHAR_AMP) {
        this.token = { type: TokenType.REDIR_DUP, start: this.token.start, from, to: this.readDupFd(this.token.start) };
      }
    }
    /* Attach the doc comment from the gap just skipped. */
    if (sawComment) {
      const docComment = extractDocComment(this.reader.substring(start, tokenStart));
      if (docComment !== undefined) {
        this.token.docComment = docComment;
      }
    }
    return this.token;
  }

  /**
   * Read the `&M` of a dup redirect (`2>&1`), the reader at the `&`.
   *
   * @return M, which must be 1 or 2 (stdout or stderr); anything else (`2>&3`,
   * `2>&`, `2>&x`) is reported, positioned at `opStart`.
   */
  private readDupFd(opStart: number): number {
    this.reader.next(); /* the '&' */
    const start = this.reader.currentOffset();
    this.reader.skipUntil(ch => !isDigit(ch));
    const digits = this.reader.substring(start);
    if (digits !== "1" && digits !== "2") {
      this.commandError(`'${digits === "" ? "&" : "&" + digits}' is not a stream: fabr has stdout (1) and stderr (2)`, opStart);
    }
    return Number(digits);
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
   * The name is a path relative to the including file, or a plugin's optional
   * lib, `<package>:<path>`. Either may be a glob (`include rules/*.fabr;`),
   * naming every file it matches. An absolute path, a variable, or any other
   * `:` is reported as an error.
   */
  private parseIncludeDecl(): IIncludeDecl {
    const token = this.token;
    if (token.type === TokenType.IDENTIFIER || token.type === TokenType.SIMPLE_NAME || token.type === TokenType.NAME) {
      const name = typeof token.text === "string" ? Name.fromLiteral(token.text) : token.text;
      /* Either platform's absolute form, by text and not the host's
       * `path.isAbsolute`, so a file parses alike everywhere. Checked before the
       * `:` test, so a Windows path is reported as absolute. */
      const head = name.getLiteralPrefix();
      if (head.startsWith("/") || /^[A-Za-z]:[\\/]/.test(head)) {
        this.absoluteIncludeName();
      } else if (name.hasVarSubst()) {
        this.invalidIncludeName("variables are not permitted");
      } else if (name.hasLevelSeparator() && !isOptionalLibName(name)) {
        /* A single name token has no `<...>` or `-> `, so a `:` is the only
         * reference syntax it can hold. */
        this.invalidIncludeName("an include names a path, or a plugin's optional lib as <package>:<path>");
      } else if (!name.hasGlob() && name.getSimpleName() === undefined) {
        /* A name that does not glob must be one literal: the loader tells a path
         * from a pattern by `getSimpleName()`. Only an escaped metacharacter can
         * split a glob-free name into parts. */
        this.invalidIncludeName("not a path");
      } else {
        const offset = token.start;
        this.nextToken();
        /* The reader is just past the name, so this is its end. */
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
   * FabrDecl ::= 'fabr' VERSION ';'
   *
   * The version is an exact semver version written literally: unquoted,
   * unescaped and in its canonical form, so that the text is the version.
   * Valid only as the file's first statement: anywhere else it is reported
   * and @return undefined.
   */
  private parseFabrDecl(start: number): IFabrDecl | undefined {
    const token = this.token as NameToken;
    const version = token.text.toString();
    this.nextToken();
    /* Quoting or escaping makes the written text longer than the version. */
    if (this.prevTokenEnd - token.start !== version.length || !isCanonicalVersion(version) || this.token.type !== TokenType.SEMI) {
      this.log.log(DIAG_INVALID_FABR, { loc: { ...this.source, offset: token.start } });
      throw new ParseAbort();
    }
    const endOffset = this.prevTokenEnd;
    this.nextToken();
    if (this.statements > 0) {
      this.log.log(DIAG_FABR_PLACEMENT, { loc: { ...this.source, offset: start } });
      return undefined;
    }
    return { source: this.source, offset: start, endOffset, version };
  }

  /**
   * PluginDecl ::= 'plugin' Reference ';'
   */
  private parsePluginDecl(): IPluginDecl {
    const token = this.token;
    if (token.type !== TokenType.IDENTIFIER && token.type !== TokenType.SIMPLE_NAME && token.type !== TokenType.NAME) {
      this.unexpectedTokenError("Name");
    }
    const name = this.parseReference();
    if (name.hasVarSubst() || name.hasGlob() || name.getRenameTo() !== undefined) {
      this.log.log(DIAG_INVALID_PLUGIN, { loc: { ...this.source, offset: token.start } });
      throw new ParseAbort();
    }
    const endOffset = this.prevTokenEnd;
    this.consumeIfToken(TokenType.SEMI);
    return { kind: DeclKind.Plugin, source: this.source, offset: token.start, endOffset, name };
  }

  /**
   * Consume the command-pipeline operator at the current token.
   *
   * @return the operator and its offset, or undefined where the token is none.
   * A `>` right after a `-` is reported as a mis-spaced rename arrow. An
   * operator makes the property a command, which Validate allows only on a
   * COMMAND property.
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
      case TokenType.REDIR_DUP: {
        const { start, from, to } = this.token;
        this.nextToken();
        return { op: CommandOpKind.Dup, at: start, from, to };
      }
      default:
        return undefined;
    }
    const at = this.token.start;
    this.nextToken();
    return { op, at };
  }

  /** @return true if the current token is a command operator, otherwise false.
   * Consumes nothing and reports nothing. */
  private atCommandOp(): boolean {
    switch (this.token.type) {
      case TokenType.PIPE:
      case TokenType.LANGLE:
      case TokenType.RANGLE:
      case TokenType.REDIR_STDOUT:
      case TokenType.REDIR_STDERR:
      case TokenType.REDIR_BOTH:
      case TokenType.REDIR_DUP:
        return true;
      default:
        return false;
    }
  }

  private commandError(detail: string, offset: number): never {
    this.log.log(DIAG_INVALID_COMMAND, { detail, loc: { ...this.source, offset } });
    throw new ParseAbort();
  }

  /**
   * Command  ::= Stage ('|' Stage)*
   * Stage    ::= Word (Word | Redirect)*
   * Redirect ::= ('<' | '>' | '1>' | '2>' | '&>') Word | N '>&' M     (N, M: 1 or 2)
   *
   * Parse a command pipeline from its first operator. `stage0` is the words
   * already read before it (the first stage's command and arguments), `firstOp`
   * the operator, already consumed, and `firstTarget` that operator's target
   * where the caller has read it too. Reported as errors: a stage other than the
   * last capturing stdout, a stage other than the first taking stdin, a stream
   * redirected twice ({@link applyRedirect}), a missing command or target, and a
   * `{ ... }` block as a word.
   *
   * @return the stages, each with its redirects applied.
   */
  private parseCommand(stage0: IValue[], firstOp: CommandOp, firstTarget?: INameValue): ICommandStage[] {
    const stages: ICommandStage[] = [];
    let pending = this.firstStage(stage0, firstOp);
    let op: CommandOp | undefined = firstOp;
    /* `firstTarget` is used by the first operator only. */
    while (op !== undefined) {
      if (op.op === CommandOpKind.Pipe) {
        /* Only a capture of stdout is refused before a `|`; `2>&1` there sends
         * stderr into the pipe. */
        if (pending.fds.out.file !== undefined) {
          this.commandError("only the final stage of a pipeline can capture stdout ('>' / '&>')", op.at);
        }
        stages.push(flattenStage(pending));
        pending = { stage: { command: this.parseRequiredWord(op), args: [] }, fds: newStageFds() };
      } else {
        this.applyRedirect(pending, op, takesTarget(op.op) ? (firstTarget ?? this.parseRequiredWord(op)) : undefined);
        if (op.op === CommandOpKind.Stdin && stages.length > 0) {
          this.commandError("only the first stage of a pipeline can take stdin ('<')", op.at);
        }
      }
      firstTarget = undefined;
      /* Words up to the next operator are the stage's arguments, after a
       * redirect too (`cmd a > out b`). */
      while (!this.atCommandOp() && !this.atCommandEnd()) {
        pending.stage.args.push(this.parseWord());
      }
      op = this.tryCommandOp();
    }
    stages.push(flattenStage(pending));
    return stages;
  }

  /** Make the first stage from the words read before the first operator: the
   * command, then its arguments. No words, or a block among them, is reported. */
  private firstStage(words: IValue[], firstOp: CommandOp): PendingStage {
    if (words.length === 0) {
      this.commandError(
        firstOp.op === CommandOpKind.Pipe ? "empty command (nothing beside '|')" : "a redirect must follow a command",
        firstOp.at
      );
    }
    const [command, ...args] = words;
    return { stage: { command: this.asWord(command), args: args.map(word => this.asWord(word)) }, fds: newStageFds() };
  }

  /**
   * Read a `` `cmd args` `` substitution, the reader at the opening backtick,
   * and append it to `builder` as one command-substitution part: the text
   * between the backticks, as written, and the pipeline parsed from it.
   *
   * This runs inside {@link readNameOrIdentifier}'s character scan. It parses by
   * token and stops on the closing backtick token without reading past it, so
   * the reader is just after the backtick, where the scan resumes; `this.token`
   * is left holding the backtick until the caller's next `nextToken`.
   */
  private readCommandSubst(builder?: NameBuilder): void {
    const open = this.reader.currentOffset();
    this.reader.next(); /* the opening backtick — consumed here, not lexed */
    this.commandSubstDepth++;
    try {
      this.nextToken(); /* the command's first word */
      const pipeline = this.parseCommandSubstPipeline(open);
      /* The text between the backticks, as written: what the part renders as,
       * and the key its result is looked up under. */
      builder?.appendCommandSubst(this.reader.substring(open + 1, this.token.start), pipeline);
    } finally {
      this.commandSubstDepth--;
    }
  }

  /** Parse the pipeline inside a substitution: the first stage's words, then
   * {@link parseCommand} where an operator follows. Ending on anything but the
   * closing backtick (a `;`, a `}`, EOF) is reported as unterminated, and no
   * words as empty. */
  private parseCommandSubstPipeline(open: number): CommandPipeline {
    const words: IValue[] = [];
    while (!this.atCommandOp() && !this.atCommandEnd()) {
      words.push(this.parseValue());
    }
    const op = this.tryCommandOp();
    if (op !== undefined) {
      const pipeline = this.parseCommand(words, op);
      if (this.token.type !== TokenType.BACKTICK) {
        this.commandError("unterminated command substitution (no closing '`')", open);
      }
      return pipeline;
    }
    if (this.token.type !== TokenType.BACKTICK) {
      this.commandError("unterminated command substitution (no closing '`')", open);
    }
    if (words.length === 0) {
      this.commandError("empty command substitution", open);
    }
    const [command, ...args] = words;
    return [{ command: this.asWord(command), args: args.map(word => this.asWord(word)) }];
  }

  /** @return true if the current token ends a command (`;`, `}`, EOF, or inside a
   * substitution its closing backtick), otherwise false. */
  private atCommandEnd(): boolean {
    return (
      this.token.type === TokenType.SEMI ||
      this.token.type === TokenType.RBRACE ||
      this.token.type === TokenType.EOF ||
      (this.commandSubstDepth > 0 && this.token.type === TokenType.BACKTICK)
    );
  }

  /** Parse one command word; the current token must start one. */
  private parseWord(): INameValue {
    return this.asWord(this.parseValue());
  }

  /** Parse the word an operator needs, a `|`'s next command or a redirect's
   * target, reporting at the operator where none follows. */
  private parseRequiredWord(op: CommandOp): INameValue {
    if (this.atCommandOp() || this.atCommandEnd()) {
      this.commandError(op.op === CommandOpKind.Pipe ? "empty command (nothing beside '|')" : missingTarget(op.op), op.at);
    }
    return this.parseWord();
  }

  /** @return `value` as a command word, reporting a `{ ... }` block. */
  private asWord(value: IValue): INameValue {
    if (!isNameValue(value)) {
      this.commandError("a `{ ... }` block is not a command", value.offset);
    }
    return value;
  }

  /**
   * Apply one redirect to the stage. A capture gives its stream a new
   * {@link Dest}, so an earlier dup is left on the old one (`2>&1 > f` leaves
   * stderr on its default, as in a shell); a dup makes its `from` stream share
   * the other's `Dest`; `&>` makes both share a new one.
   *
   * A stream redirected twice is reported as an error, a dup counting as a
   * redirect of its `from` stream. A dup of a stream to itself (`2>&2`) does
   * nothing.
   */
  private applyRedirect({ stage, fds }: PendingStage, op: CommandOp, target: INameValue | undefined): void {
    /* True if a stream was captured, or pointed at the other by a dup. */
    const directed = (fd: Dest, other: Dest): boolean => fd.file !== undefined || fd === other;
    switch (op.op) {
      case CommandOpKind.Stdin:
        if (stage.stdin !== undefined) {
          this.commandError("stdin is redirected more than once", op.at);
        }
        stage.stdin = target;
        break;
      case CommandOpKind.Stdout:
        if (fds.out.file !== undefined) {
          this.commandError("stdout is redirected more than once", op.at);
        }
        fds.out = { file: target };
        break;
      case CommandOpKind.Stderr:
        if (directed(fds.err, fds.out)) {
          this.commandError("stderr is redirected more than once", op.at);
        }
        fds.err = { file: target };
        break;
      case CommandOpKind.Dup: {
        if (op.from === op.to) {
          break; /* `1>&1` / `2>&2`: a stream to its own destination, a no-op */
        }
        const [from, to]: [StreamName, StreamName] = op.from === 1 ? ["out", "err"] : ["err", "out"];
        if (directed(fds[from], fds[to])) {
          this.commandError(`${STREAM_LABEL[from]} is redirected more than once`, op.at);
        }
        fds[from] = fds[to];
        fds.mergedTo = to;
        break;
      }
      case CommandOpKind.Both:
        if (fds.out.file !== undefined || directed(fds.err, fds.out)) {
          this.commandError("a stream is redirected more than once", op.at);
        }
        fds.out = { file: target };
        fds.err = fds.out;
        fds.mergedTo = "out";
        break;
      default:
        break;
    }
  }

  /** Parse one value: a reference, or a `{ … }` block. */
  private parseValue(): IValue {
    const token = this.token;
    if (token.type === TokenType.LBRACE) {
      /* A `{ key = value; ... }` block (a map, or one of a list of maps).
       * Validate checks where a block may appear. */
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
      /* The end of the reference's last token is the value's end. */
      return {
        kind: DeclKind.NameValue,
        source: this.source,
        offset,
        endOffset: this.prevTokenEnd,
        value,
      };
    } else if (token.type === TokenType.RANGLE) {
      /* A `>` here is taken as a mis-spaced rename arrow (`sel-> x`, the `-` read
       * into the name). */
      this.renameTemplateError("the '->' arrow must be surrounded by spaces (`sel -> tmpl`)");
    } else {
      this.unexpectedTokenError("Name, ';', or '}'");
    }
  }

  /** @return the Name for a ref token (a bare identifier is a literal name). */
  private tokenToName(token: NameToken | IdentToken): Name {
    return typeof token.text === "string" ? Name.fromLiteral(token.text) : token.text;
  }

  /** @return the current token's text if it is a bare `1`, `2` or `&` (which an
   * abutting `>` makes a redirect), else undefined. */
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
   * Reference ::= Ref Constraints? Tail? ( '->' Template )?
   *
   * Parse a reference from its base token (NAME, IDENTIFIER or SIMPLE_NAME), with
   * an abutting `<k=v, …>`, the abutting `:projection`, `/path` or marker after it
   * ({@link applyConstraintsAndRename}), and a `-> template` rename, into one
   * Name. A `<...>` or tail with whitespace before it is not part of the
   * reference. `kind` says what the `<k=v>` is. Leaves the current token after
   * the reference.
   */
  private parseReference(kind: ConstraintKind = "requirement"): Name {
    const name = this.tokenToName(this.token as NameToken | IdentToken);
    this.nextToken();
    return this.parseRefSuffix(name, kind);
  }

  /**
   * Parse what follows a reference's base token, already consumed: an abutting
   * `<k=v>` with what follows it, or a `-> template` rename.
   *
   * @return `name` with them applied.
   */
  private parseRefSuffix(name: Name, kind: ConstraintKind = "requirement"): Name {
    if (this.token.type === TokenType.LANGLE && this.tokenAbutsPrev) {
      this.nextToken(); /* consume '<' */
      return this.applyConstraintsAndRename(name, this.parseConstraintList(undefined, kind));
    }
    /* The rename; the arrow is spaced, so it never abuts. */
    if (this.token.type === TokenType.ARROW) {
      name = this.withRename(name);
    }
    return name;
  }

  /**
   * Attach a `-> template` rename to `name`, the current token the ARROW. A
   * template with a `:`, or whose wildcards cannot be filled from `name`'s
   * ({@link checkRenameWildcards}), is reported at the arrow.
   *
   * Keep these checks here: every rename is parsed through this, a CLI reference
   * (`fabr cat 'x:*.a -> *.b.*'`) included, which no Validate pass sees.
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

  /**
   * Attach a parsed `<k=v>` list to `name`, then a `-> rename` where one follows.
   * A token abutting the `>` that starts with `:` or `/` (`pkg<k=v>:build/*.js`)
   * is joined to the name, and a bare `!` or `?` is its marker. Used for an
   * abutting `ref<k=v>` and a spaced `ref <k=v>` alike.
   */
  private applyConstraintsAndRename(name: Name, constraints: NameConstraint[]): Name {
    const tail = this.tokenAbutsPrev ? this.peekRefToken() : undefined;
    /* Other abutting text (`foo<k=v>bar`) is not joined: leave it unconsumed. */
    if (tail) {
      const tailName = this.tokenToName(tail);
      const tailLiteral = tailName.getLiteralPrefix();
      if (tailLiteral.startsWith(":") || tailLiteral.startsWith("/")) {
        name = name.concat(tailName);
        this.nextToken();
      } else if (tailName.toBaseString() === "!" || tailName.toBaseString() === "?") {
        /* An override marker written after the constraints (`pkg<k=v>!`) is
         * the reference's, as one written before them is. */
        name = name.concat(tailName).withMarker();
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
   * Parse a rename template, the current token the ARROW: the arrow and one name
   * token. A missing template, an abutting `<...>` and a second arrow are
   * reported. {@link withRename} checks its content; the rules that need the
   * property's type are Validate's.
   */
  private parseRenameTemplate(): Name {
    this.consumeToken(TokenType.ARROW);
    const token = this.peekRefToken();
    if (!token) {
      this.unexpectedTokenError("a rename template");
    }
    const template = this.tokenToName(token).asRenameTemplate();
    this.nextToken();
    if (this.token.type === TokenType.LANGLE && this.tokenAbutsPrev) {
      this.renameTemplateError("a rename template cannot carry constraints");
    }
    if (this.token.type === TokenType.ARROW) {
      this.renameTemplateError("rename templates cannot be chained");
    }
    return template;
  }

  /** Report an invalid rename template at `at` (default the current token) and
   * throw. */
  private renameTemplateError(detail: string, at: number = this.token.start): never {
    this.log.log(DIAG_RENAME_TEMPLATE, { detail, loc: { ...this.source, offset: at } });
    throw new ParseAbort();
  }

  /** Report an unterminated extglob group at its outermost leader (`at`) and
   * throw. */
  private unterminatedExtglobError(at: number): never {
    this.log.log(DIAG_UNTERMINATED_EXTGLOB, {
      leader: this.reader.substring(at, at + 2),
      loc: { ...this.source, offset: at },
    });
    throw new ParseAbort();
  }

  /** Report a `!(` inside another extglob group, at its offset `at`, and throw. */
  private nestedNegationError(at: number): never {
    this.log.log(DIAG_NESTED_NEGATION, { loc: { ...this.source, offset: at } });
    throw new ParseAbort();
  }

  /**
   * Constraints ::= '<' Constraint ( ',' Constraint )* ','? '>'
   * Constraint  ::= IDENTIFIER '=' ( IDENTIFIER | SIMPLE_NAME | NAME )
   *
   * Parse a `<k=v, …>` list from after its `<` through its `>`. An empty `<>`, a
   * key that is not an identifier (or, for a `"rule"` guard, `<name>.<name>`) and
   * a repeated key are reported. A `"requirement"` value may not be a pattern:
   * that is reported with a hint to write a guard on the property instead
   * (`deps<TARGET=*-linux-*> = mylib` for `deps = mylib<TARGET=*-linux-*>`).
   *
   * Where `firstKey` is given, that key has already been read too and the
   * current token is its `=`. With `readOn` false, the `>` is left as the
   * current token with the reader just past it, for a caller that reads on by
   * character.
   *
   * @return the constraints, in written order.
   */
  private parseConstraintList(
    firstKey?: { text: string; start: number },
    kind: ConstraintKind = "requirement",
    readOn = true
  ): NameConstraint[] {
    const constraints: NameConstraint[] = [];
    const seen = new Set<string>();
    /* A `>` here closes the list and is no redirect; reset in `finally`. */
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
          /* A rule's guard may name a property of its target, as `pkg.test_framework`. */
          if (
            key.type !== TokenType.IDENTIFIER &&
            !(
              kind === "rule" &&
              key.type === TokenType.SIMPLE_NAME &&
              key.text.split(".").length === 2 &&
              key.text.split(".").every(isIdentifier)
            )
          ) {
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
        if (value.type !== TokenType.IDENTIFIER && value.type !== TokenType.SIMPLE_NAME && value.type !== TokenType.NAME) {
          this.unexpectedTokenError("a constraint value");
        }
        const valueName = this.tokenToName(value);
        if (kind === "requirement" && valueName.hasGlob()) {
          this.globConstraintError(keyText, value.start);
        }
        constraints.push([keyText, valueName]);
        this.nextToken();
        /* Continue after a comma, unless it is a trailing one before the '>'. */
        if (!this.consumeIfToken(TokenType.COMMA) || this.token.type === TokenType.RANGLE) {
          break;
        }
      }
    } finally {
      this.suppressRedirect = false;
    }
    if (readOn) {
      this.consumeToken(TokenType.RANGLE);
    } else if (this.token.type !== TokenType.RANGLE) {
      this.unexpectedTokenError(TOKEN_NAME_MAP[TokenType.RANGLE]);
    }
    return constraints;
  }

  private duplicateConstraintError(key: string, offset: number): never {
    this.log.log(DIAG_DUP_CONSTRAINT, { key, loc: { ...this.source, offset } });
    throw new ParseAbort();
  }

  /** Report a pattern as a requirement's value, with a hint to write it as a
   * guard on the property, and throw. */
  private globConstraintError(key: string, offset: number): never {
    this.log.log(DIAG_GLOB_CONSTRAINT, {
      key,
      loc: { ...this.source, offset },
      help: [`did you mean a guard on the property — '<property><${key}=…> = <value>'?`],
    });
    throw new ParseAbort();
  }

  /**
   * Read a property key from its token: the name as written, with an abutting
   * `<k=v>` as its guard. A `<` with a space before it is reported: a guard
   * must abut its key.
   */
  private parsePropertyKey(): Name {
    const base = this.tokenToName(this.token as NameToken | IdentToken);
    this.nextToken();
    return this.finishPropertyKey(base);
  }

  /** Read a property key as {@link parsePropertyKey} does, its base token
   * already consumed (a statement parser reads past it to tell a property from a
   * target). */
  private finishPropertyKey(base: Name): Name {
    const key = this.parseRefSuffix(base, "guard");
    if (this.token.type === TokenType.LANGLE) {
      this.log.log(DIAG_SPACED_GUARD, {
        loc: { ...this.source, offset: this.token.start },
        help: ["write it against the name, as 'srcs<TARGET=*-linux-*> = …'"],
      });
      throw new ParseAbort();
    }
    return key;
  }

  /**
   * PropertyDecl ::= NAME '=' Value* ';'
   *                      ^
   * Parse a property declaration from its `=`. The enclosing guard block's
   * guard is added to the key's own; a rename on the key is reported.
   *
   * @param key the key as written, a bare identifier or a whole reference (a
   * `sync` coordinate), its `<k=v>` already parsed as its guard.
   */
  private parsePropertyDecl(key: Name, nameOffset: number, docComment?: string): IPropertyDecl {
    if (key.getRenameTo() !== undefined) {
      /* `srcs -> foo = …` */
      this.renameTemplateError("a property key cannot carry a rename", nameOffset);
    }
    const name = this.blockGuard ? key.withConstraints(this.mergeGuards(key.getConstraints(), nameOffset, "this declaration")) : key;
    this.consumeToken(TokenType.EQUALS);
    const base = {
      kind: DeclKind.Property as const,
      source: this.source,
      name,
      offset: nameOffset,
      docComment,
    };
    return this.parsePropertyValues(base);
  }

  /** The guard of the `<k=v> { … }` block being parsed, added to every
   * declaration in it; undefined outside one. */
  private blockGuard?: readonly NameConstraint[];

  /** @return the enclosing block's guard followed by `own`, a declaration's or a
   * nested block's guard. A key in both is reported, `site` saying which. */
  private mergeGuards(own: readonly NameConstraint[], offset: number, site: string): readonly NameConstraint[] {
    const block = this.blockGuard ?? [];
    for (const [key] of own) {
      if (block.some(([blockKey]) => blockKey === key)) {
        this.log.log(DIAG_GUARD_CONFLICT, { key, site, loc: { ...this.source, offset } });
        throw new ParseAbort();
      }
    }
    return [...block, ...own];
  }

  /**
   * Parse a property's values through the terminating ';', for a `name = …;`
   * declaration and a targetdef's `default …;` clause alike. The current token
   * starts the first value. Where an operator appears, the values are a command
   * (one {@link ICommandValue}).
   */
  private parsePropertyValues(base: Omit<IPropertyDecl, "values">): IPropertyDecl {
    const values: IValue[] = [];
    /* Values are names and `{...}` blocks (`maintainers = { ... } { ... };`); a
     * block consumes its own `}`, so the RBRACE test sees only the enclosing
     * body's. A block ends the property, with no ';', unless another block
     * follows. On the first pipeline operator (`|`, `<`, `>`, …) the words read
     * so far are the command's first stage. Words with no operator stay a value
     * list. */
    while (this.token.type !== TokenType.SEMI && this.token.type !== TokenType.RBRACE) {
      /* A spaced `<` after a reference is either a `<k=v>` on that reference or
       * a stdin redirect. Read the `<` and, if it follows, an identifier: an `=`
       * after that makes it a `<k=v>`, anything else a redirect. */
      if (this.token.type === TokenType.LANGLE && values.length > 0 && isNameValue(values[values.length - 1])) {
        const langleAt = this.token.start;
        const afterLangle = this.nextToken(); /* consume '<' */
        if (afterLangle.type === TokenType.IDENTIFIER) {
          const keyToken = { text: afterLangle.text, start: afterLangle.start };
          const afterKey = this.nextToken(); /* consume the shared identifier prefix */
          if (afterKey.type === TokenType.EQUALS) {
            /* A `<k=v>` on the preceding reference, as if it abutted. */
            const last = values[values.length - 1] as INameValue;
            const refined = this.applyConstraintsAndRename(last.value, this.parseConstraintList(keyToken));
            values[values.length - 1] = { ...last, value: refined, endOffset: this.prevTokenEnd };
            continue;
          }
          /* A stdin redirect whose target starts with the identifier. */
          const target: INameValue = {
            kind: DeclKind.NameValue,
            source: this.source,
            offset: keyToken.start,
            value: this.parseRefSuffix(Name.fromLiteral(keyToken.text)),
            endOffset: this.prevTokenEnd,
          };
          return this.finishCommandProperty(
            base,
            values,
            this.parseCommand(values, { op: CommandOpKind.Stdin, at: langleAt }, target)
          );
        }
        /* A stdin redirect whose target is not an identifier. */
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

  /** Make the property's one command value from a parsed pipeline, positioned at
   * the first of `values` (the words before the first operator), else at
   * `prevTokenEnd`. */
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
   * MapItem   ::= MapKey '=' Value* ';' | Splice
   * Splice    ::= Ref ';'
   * MapKey    ::= IDENTIFIER | SIMPLE_NAME | NAME
   *
   * Parse a MAP value from its `{`: `key = value;` entries and `NAME;` splices.
   * A key is literal text, never a reference (`process.env.NODE_ENV`). A splice
   * names another block-valued property, whose entries are merged in at that
   * position. Values are ordinary values, blocks included. A bad entry is
   * reported and skipped. Nesting beyond {@link MAX_BLOCK_DEPTH} is reported.
   */
  private parseMapBlock(): IMapItemDecl[] {
    if (this.blockDepth >= MAX_BLOCK_DEPTH) {
      this.log.log(DIAG_NESTING_TOO_DEEP, { loc: { ...this.source, offset: this.token.start } });
      throw new ParseAbort();
    }
    this.blockDepth++;
    /* An enclosing guard block applies to the property holding the map, not to
     * the map's entries. */
    const outerGuard = this.blockGuard;
    this.blockGuard = undefined;
    try {
      return this.parseMapBlockBody();
    } finally {
      this.blockGuard = outerGuard;
      this.blockDepth--;
    }
  }

  /**
   * GuardBlock ::= Constraints '{' PropertyList '}'
   *                ^
   *
   * Parse `<TARGET=…> { … }` from its `<`: the declarations in it, each with the
   * guard added to its own. Nested blocks add theirs too; the block introduces
   * no scope.
   */
  private parseGuardBlock(): IPropertyDecl[] {
    if (this.blockDepth >= MAX_BLOCK_DEPTH) {
      this.log.log(DIAG_NESTING_TOO_DEEP, { loc: { ...this.source, offset: this.token.start } });
      throw new ParseAbort();
    }
    const at = this.token.start;
    this.nextToken(); /* consume '<' */
    const guard = this.parseConstraintList(undefined, "guard");
    const outerGuard = this.blockGuard;
    this.blockGuard = outerGuard ? this.mergeGuards(guard, at, "this block") : guard;
    this.blockDepth++;
    try {
      this.consumeToken(TokenType.LBRACE);
      const list = this.parsePropertyList(false).filter(isPropertyDecl);
      this.consumeToken(TokenType.RBRACE);
      return list;
    } finally {
      this.blockGuard = outerGuard;
      this.blockDepth--;
    }
  }

  /** Parse {@link parseMapBlock}'s block, its depth already counted. */
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
          entries.push(this.parsePropertyDecl(name, offset));
        } else if (next.type === TokenType.SEMI || next.type === TokenType.RBRACE) {
          /* A splice; its Name may carry `${...}` substitutions. */
          entries.push({
            kind: DeclKind.Splice,
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
        if (!(error instanceof ParseAbort)) {
          throw error;
        }
        /* Skip to the next entry or the block's own `}`. */
        this.recoverInBody();
      }
    }
    this.consumeToken(TokenType.RBRACE);
    return entries;
  }

  /**
   * PropertyList ::= ( PropertyDecl | GuardBlock | Splice )*
   * Splice       ::= Ref ';'
   *
   * Parse a target's body, or a guard block's. A splice is accepted only where
   * `splices` is true (a target's own body), and never with a guard. A bad
   * property is reported and skipped.
   */
  private parsePropertyList(splices: boolean): IMapItemDecl[] {
    const list: IMapItemDecl[] = [];
    while (this.token.type !== TokenType.RBRACE && this.token.type !== TokenType.EOF) {
      try {
        const token = this.token;
        if (token.type === TokenType.LANGLE) {
          list.push(...this.parseGuardBlock());
        } else if (token.type === TokenType.IDENTIFIER || token.type === TokenType.NAME || token.type === TokenType.SIMPLE_NAME) {
          /* A property name, or a reference as the key: a `sync` member
           * coordinate (`@npm:pkg:ver = srcs`) or a name or path
           * (`@fabr-build/core`, `lib/x`). */
          const start = token.start;
          const key = this.parsePropertyKey();
          const keyEnd = this.prevTokenEnd;
          if (this.token.type === TokenType.SEMI) {
            if (!splices || key.getConstraints().length > 0) {
              this.log.log(DIAG_GUARDED_SPLICE, { loc: { ...this.source, offset: start } });
              throw new ParseAbort();
            }
            this.nextToken();
            list.push({ kind: DeclKind.Splice, source: this.source, offset: start, endOffset: keyEnd, ref: key });
            continue;
          }
          const decl = this.parsePropertyDecl(key, start);
          /* The span is the key's, not the whole declaration's. */
          decl.endOffset = keyEnd;
          list.push(decl);
        } else {
          this.unexpectedTokenError("Identifier, reference, or '}'");
        }
      } catch (error) {
        if (!(error instanceof ParseAbort)) {
          throw error;
        }
        /* Skip to the next property or the body's own `}`. */
        this.recoverInBody();
      }
    }
    return list;
  }

  /** Skip tokens after an error in a `{...}` body: through the next `;` at the
   * body's depth, or up to (not past) the body's own `}`. Nested `{...}` are
   * skipped whole. */
  private recoverInBody(): void {
    let depth = 0;
    while (this.token.type !== TokenType.EOF) {
      switch (this.token.type) {
        case TokenType.LBRACE:
          depth++;
          break;
        case TokenType.RBRACE:
          if (depth === 0) {
            return; /* the body's own close — left for the caller */
          }
          depth--;
          break;
        case TokenType.SEMI:
          if (depth === 0) {
            this.skipToken(); /* consume the `;`, resume at the next property */
            return;
          }
          break;
      }
      this.skipToken();
    }
  }

  /**
   * TargetDecl ::= IDENTIFIER ( IDENTIFIER | SIMPLE_NAME ) '{' PropertyList '}'
   *                           ^
   * `type` and `typeOffset` are the type token, already consumed.
   */
  private parseTargetDecl(type: string, typeOffset: number, docComment?: string): ITargetDecl {
    if (this.token.type !== TokenType.IDENTIFIER && this.token.type !== TokenType.SIMPLE_NAME) {
      this.unexpectedTokenError("Path");
    } else {
      const nameToken = this.token;
      this.nextToken();
      const nameEnd = this.prevTokenEnd;
      this.consumeToken(TokenType.LBRACE);
      const properties = this.parsePropertyList(true);
      this.consumeToken(TokenType.RBRACE);
      return {
        kind: DeclKind.Target,
        source: this.source,
        type,
        typeOffset,
        name: Name.fromLiteral(nameToken.text),
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
   * PrivateDecl ::= 'private' ( PropertyDecl | TargetDecl )
   *                            ^
   *
   * Parse the declaration after `keyword`, a property or a target, told apart
   * by the token after its first word as for an unprefixed one. That word must
   * be an IDENTIFIER. `default targetdef`, `default repository` and
   * `default private` are reported, as is `private` before any keyword.
   */
  private parsePrefixedDecl(keyword: "default" | "private", docComment: string | undefined): IResolvableDecl {
    const name = this.token;
    const expected = `a property name or target type after '${keyword}'`;
    if (name.type !== TokenType.IDENTIFIER || (keyword === "private" && PRIVATE_REFUSED.has(name.text))) {
      this.unexpectedTokenError(expected);
    }
    const next = this.nextToken();
    if (next.type === TokenType.EQUALS || next.type === TokenType.LANGLE) {
      /* `<` is the declaration's guard (`default F<TARGET=…> = …`). */
      return this.parsePropertyDecl(this.finishPropertyKey(Name.fromLiteral(name.text)), name.start, docComment);
    } else if (next.type === TokenType.IDENTIFIER || next.type === TokenType.SIMPLE_NAME) {
      /* Reported at the keyword word, not read as a target of that type. */
      if (DEFAULT_REFUSED.has(name.text)) {
        this.unexpectedTokenError(expected, name.start);
      }
      return this.parseTargetDecl(name.text, name.start, docComment);
    } else {
      this.unexpectedTokenError("'=' or a target name");
    }
  }

  /**
   * RuleBody ::= NAME RuleGuard? '=' RuleImplementation
   *              ^
   * RuleGuard ::= '<' RuleGuardKey '=' NAME ( ',' RuleGuardKey '=' NAME )* '>'
   * RuleGuardKey ::= NAME | <param> '.' NAME
   *
   * Parse a rule declaration from its target parameter: the rule of `type`,
   * written at `typeOffset`, or of every type where undefined; `offset` is where
   * the declaration starts. The guard abuts the parameter; a key
   * `<param>.<name>` guards on the target's property, any other dotted key is
   * reported.
   */
  private parseRuleDecl(type: string | undefined, typeOffset: number | undefined, offset: number): IRuleDecl {
    const param = this.token;
    if (param.type !== TokenType.IDENTIFIER) {
      this.unexpectedTokenError("the rule's target parameter");
    }
    this.nextToken();
    const properties: NameConstraint[] = [];
    const targetProperties: NameConstraint[] = [];
    if (this.token.type === TokenType.LANGLE && this.token.start === this.prevTokenEnd) {
      this.nextToken();
      for (const [key, pattern] of this.parseConstraintList(undefined, "rule")) {
        if (key.startsWith(param.text + ".")) {
          targetProperties.push([key.substring(param.text.length + 1), pattern]);
        } else if (key.includes(".")) {
          this.log.log(DIAG_RULE_GUARD_KEY, { key, param: param.text, loc: { ...this.source, offset: param.start } });
          throw new ParseAbort();
        } else {
          properties.push([key, pattern]);
        }
      }
    }
    this.consumeToken(TokenType.EQUALS);
    const implementation = this.parseRuleImplementation();
    return {
      kind: DeclKind.Rule,
      source: this.source,
      offset,
      type,
      ...(typeOffset === undefined ? {} : { typeOffset }),
      param: param.text,
      paramOffset: param.start,
      properties,
      targetProperties,
      implementation,
    };
  }

  /**
   * RuleImplementation ::= NAME ';'                                         a package entry
   *                      | IDENTIFIER ( IDENTIFIER | SIMPLE_NAME ) '{' PropertyList '}'   one target, the result
   *                      | Reference RuleBlockBody                         the result, and the block
   *                        ^
   *
   * Parse a rule's implementation; the forms are told apart by what follows the
   * first token: a second name, a `{` after the reference, or a `;`. A package
   * entry with a glob, variable, `<k=v>` or rename, or without a `:`, is
   * reported.
   */
  private parseRuleImplementation(): INameValue | IRuleBlock {
    const first = this.token;
    if (first.type !== TokenType.IDENTIFIER && first.type !== TokenType.SIMPLE_NAME && first.type !== TokenType.NAME) {
      this.unexpectedTokenError("a package entry, a target declaration or a reference");
    }
    this.nextToken();
    if (
      first.type === TokenType.IDENTIFIER &&
      (this.token.type === TokenType.IDENTIFIER || this.token.type === TokenType.SIMPLE_NAME)
    ) {
      const target = this.parseTargetDecl(first.text, first.start);
      return { result: this.syntheticResult(target), targets: [target], properties: [] };
    }
    const value = this.parseRefSuffix(this.tokenToName(first));
    const result: INameValue = {
      kind: DeclKind.NameValue,
      source: this.source,
      offset: first.start,
      endOffset: this.prevTokenEnd,
      value,
    };
    if (this.token.type === TokenType.LBRACE) {
      return { result, ...this.parseRuleBlockBody() };
    }
    if (
      value.hasVarSubst() ||
      value.hasGlob() ||
      !value.hasLevelSeparator() ||
      value.hasConstraints() ||
      value.getRenameTo() !== undefined
    ) {
      this.log.log(DIAG_INVALID_IMPLEMENTATION, { loc: { ...this.source, offset: first.start } });
      throw new ParseAbort();
    }
    this.consumeToken(TokenType.SEMI);
    return result;
  }

  /** Make the result of a short-form rule: the name of its one target, written where the name is. */
  private syntheticResult(target: ITargetDecl): INameValue {
    return {
      kind: DeclKind.NameValue,
      source: this.source,
      offset: target.offset,
      endOffset: target.endOffset ?? target.offset,
      value: target.name,
    };
  }

  /**
   * RuleBlockBody ::= '{' ( TargetDecl | PropertyDecl | GuardBlock )* '}'
   *                   ^
   */
  private parseRuleBlockBody(): { targets: ITargetDecl[]; properties: IPropertyDecl[] } {
    const targets: ITargetDecl[] = [];
    const properties: IPropertyDecl[] = [];
    this.consumeToken(TokenType.LBRACE);
    while (this.token.type !== TokenType.RBRACE && this.token.type !== TokenType.EOF) {
      try {
        const token = this.token;
        if (token.type === TokenType.LANGLE) {
          properties.push(...this.parseGuardBlock());
        } else if (token.type === TokenType.IDENTIFIER) {
          const doc = token.docComment;
          const next = this.nextToken();
          if (next.type === TokenType.EQUALS || next.type === TokenType.LANGLE) {
            properties.push(this.parsePropertyDecl(this.finishPropertyKey(Name.fromLiteral(token.text)), token.start, doc));
          } else if (RULE_BLOCK_REFUSED.has(token.text)) {
            this.log.log(DIAG_RULE_BLOCK_DECL, { keyword: token.text, loc: { ...this.source, offset: token.start } });
            throw new ParseAbort();
          } else if (next.type === TokenType.IDENTIFIER || next.type === TokenType.SIMPLE_NAME) {
            targets.push(this.parseTargetDecl(token.text, token.start, doc));
          } else {
            this.unexpectedTokenError("'=' or a target name");
          }
        } else {
          this.unexpectedTokenError("a target or property declaration, or '}'");
        }
      } catch (error) {
        if (!(error instanceof ParseAbort)) {
          throw error;
        }
        this.recoverInBody();
      }
    }
    this.consumeToken(TokenType.RBRACE);
    return { targets, properties };
  }

  /**
   * RepositoryDecl ::= 'repository' NAME '=' NAME ';'
   *                     ^
   */
  private parseRepositoryDecl(offset: number): IRepositoryDecl {
    const type = this.token;
    if (type.type !== TokenType.IDENTIFIER) {
      this.unexpectedTokenError("a repository type");
    }
    this.nextToken();
    this.consumeToken(TokenType.EQUALS);
    return { kind: DeclKind.Repository, source: this.source, offset, type: type.text, implementation: this.parseImplementation() };
  }

  /**
   * Parse a repository's implementation, a reference to an entry of a package
   * (`@fabr-build/js:rules/BuildJSPackage`), and the `;` after it.
   */
  private parseImplementation(): INameValue {
    const token = this.token;
    if (token.type !== TokenType.IDENTIFIER && token.type !== TokenType.SIMPLE_NAME && token.type !== TokenType.NAME) {
      this.unexpectedTokenError("a package entry");
    }
    const value = this.tokenToName(token);
    if (value.hasVarSubst() || value.hasGlob() || !value.hasLevelSeparator()) {
      this.log.log(DIAG_INVALID_IMPLEMENTATION, { loc: { ...this.source, offset: token.start } });
      throw new ParseAbort();
    }
    this.nextToken();
    const endOffset = this.prevTokenEnd;
    this.consumeToken(TokenType.SEMI);
    return { kind: DeclKind.NameValue, source: this.source, offset: token.start, endOffset, value };
  }

  /**
   * TargetDefDecl ::= 'targetdef' NAME ( 'extends' NAME )? '{' PropertyTypeList '}'
   *                     ^
   */
  private parseTargetDefDecl(docComment: string | undefined): ITargetDefDecl {
    if (this.token.type !== TokenType.IDENTIFIER) {
      this.unexpectedTokenError("Identifier");
    } else {
      const nameToken = this.token;
      this.nextToken();
      const nameEnd = this.prevTokenEnd;
      let base: { name: string; offset: number } | undefined;
      if (this.token.type === TokenType.IDENTIFIER && this.token.text === "extends") {
        this.nextToken();
        if (this.token.type !== TokenType.IDENTIFIER) {
          this.unexpectedTokenError("Identifier");
        }
        base = { name: this.token.text, offset: this.token.start };
        this.nextToken();
      }
      this.consumeToken(TokenType.LBRACE);
      const properties = this.parsePropertyTypeList();
      this.consumeToken(TokenType.RBRACE);
      return {
        kind: DeclKind.TargetDef,
        source: this.source,
        name: nameToken.text,
        offset: nameToken.start,
        endOffset: nameEnd,
        ...(base === undefined ? {} : { extends: base }),
        properties,
        docComment,
      };
    }
  }

  /**
   * PropertyTypeList ::= PropertyType*
   * PropertyType ::= ( IDENTIFIER | '*' ) '=' PropertySchema DefaultClause? ';'
   * PropertySchema ::=  ( 'STRING'|'FILES'|'PACKAGES'|'REWRITE'|'MAP'|'COMMAND'|'REQUIRED' )*
   * DefaultClause ::= 'default' Value*
   *
   * Parse a targetdef's property types, keyed by property name, `*` the type of
   * any key the targetdef does not name. Reported, the first declaration
   * standing: no type, `default` before the type, REQUIRED with a default, a
   * default on `*`, and a repeated key.
   */
  private parsePropertyTypeList(): Map<string, IPropertySchema> {
    const result = new Map<string, IPropertySchema>();
    while (this.token.type !== TokenType.RBRACE) {
      const token = this.token;
      const docComment = token.docComment;
      let required = false;
      let type: PropertyType | undefined;
      let defaultDecl: IPropertyDecl | undefined;
      /* A property name (`srcs`), or the `*` wildcard (a `sync`'s
       * reference-keyed members). Match `*` by its parts, not its text: a quoted
       * `'*'` is the literal character. */
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
        this.unexpectedTokenError("'STRING' or 'FILES' or 'PACKAGES' or 'REWRITE' or 'MAP' or 'COMMAND' or 'REQUIRED'");
      } else {
        while (next.type === TokenType.IDENTIFIER) {
          /* `default` ends the keywords; the rest, through the ';', is parsed as
           * a property's values. The default's declaration is positioned at the
           * schema key. */
          if (next.text === "default") {
            this.nextToken();
            defaultDecl = this.parsePropertyValues({
              kind: DeclKind.Property,
              source: this.source,
              name: Name.fromLiteral(key),
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
            case "PACKAGES":
              type = PropertyType.Packages;
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
              this.unexpectedTokenError("'STRING' or 'FILES' or 'PACKAGES' or 'REWRITE' or 'MAP' or 'COMMAND' or 'REQUIRED'");
          }
          next = this.nextToken();
        }
      }
      if (type === undefined) {
        if (defaultDecl) {
          /* `default` before any type keyword. The clause has been parsed, so
           * this is logged without throwing. */
          this.log.log(DIAG_DEFAULT_BEFORE_TYPE, { key, loc: { ...this.source, offset: token.start } });
        } else {
          this.unexpectedTokenError("'STRING' or 'FILES' or 'PACKAGES' or 'REWRITE' or 'MAP' or 'COMMAND'");
        }
      } else if (required && defaultDecl) {
        this.log.log(DIAG_REQUIRED_DEFAULT, { key, loc: { ...this.source, offset: token.start } });
      } else if (key === "*" && defaultDecl) {
        this.log.log(DIAG_WILDCARD_DEFAULT, { loc: { ...this.source, offset: token.start } });
      } else if (result.has(key)) {
        /* The first declaration stands. */
        this.log.log(DIAG_DUP_SCHEMA_KEY, { key, loc: { ...this.source, offset: token.start } });
      } else {
        result.set(key, { required, type, default: defaultDecl, docComment });
      }
      /* A default clause has already consumed its ';'. */
      if (!defaultDecl && next.type !== TokenType.RBRACE) {
        this.consumeToken(TokenType.SEMI);
      }
    }
    return result;
  }

  /**
   * Report the current token as unexpected and throw, without consuming it. An
   * ERROR token's error was reported when it was read, so it only throws.
   * @param expected what was wanted, as the message names it
   * @param at the offset to report at, by default the current token's; an
   * earlier one where the wrong token was only found wrong by reading past it
   * (`default targetdef`)
   */
  private unexpectedTokenError(expected: string, at: number = this.token.start): never {
    if (this.token.type === TokenType.ERROR) {
      throw new ParseAbort();
    }
    this.log.log(DIAG_PARSE_ERROR, {
      loc: { ...this.source, offset: at },
      actual: TOKEN_NAME_MAP[this.token.type],
      expected,
    });
    throw new ParseAbort();
  }

  private unexpectedEndOfFile(expected: string, offset: number = this.token.start): never {
    this.log.log(DIAG_UNEXPECTED_EOF, {
      loc: { ...this.source, offset },
      expected,
    });
    throw new ParseAbort();
  }

  private invalidIncludeName(detail: string): never {
    this.log.log(DIAG_INVALID_INCLUDE, { detail, loc: { ...this.source, offset: this.token.start } });
    throw new ParseAbort();
  }

  private absoluteIncludeName(): never {
    this.log.log(DIAG_ABSOLUTE_INCLUDE, { loc: { ...this.source, offset: this.token.start } });
    throw new ParseAbort();
  }

  /**
   * Parse a statement.
   *
   * Statement ::= PropertyDecl | TargetDecl | IncludeDecl | PluginDecl | TargetDefDecl | DefaultDecl
   *             | PrivateDecl | RuleDecl | RepositoryDecl | GuardBlock
   *               ^
   * PropertyDecl ::= NAME Guard? '=' expr ';'
   * TargetDecl ::= IDENTIFIER ( IDENTIFIER | SIMPLE_NAME ) '{' PropertyList '}'
   * IncludeDecl ::= 'include' NAME ';'
   * PluginDecl ::= 'plugin' Reference ';'
   * TargetDefDecl ::= 'targetdef' NAME ( 'extends' NAME )? '{' PropertyTypeList '}'
   * DefaultDecl ::= 'default' ( PropertyDecl | TargetDecl | 'rule' RuleBody )
   * PrivateDecl ::= 'private' ( PropertyDecl | TargetDecl )
   * RuleDecl ::= 'rule' NAME RuleBody
   * RuleBody ::= NAME RuleGuard? '=' RuleImplementation
   * RepositoryDecl ::= 'repository' NAME '=' NAME ';'
   */

  public parseStatement(): void {
    const token = this.token;
    if (token.type === TokenType.IDENTIFIER) {
      /* The doc comment is on the statement's first token. */
      const doc = token.docComment;
      const next = this.nextToken();
      if (token.text === "fabr" && next.type === TokenType.NAME) {
        const fabr = this.parseFabrDecl(token.start);
        if (fabr !== undefined) {
          this.result.fabr = fabr;
        }
      } else if (token.text === "include") {
        this.result.includes.push(this.parseIncludeDecl());
      } else if (token.text === "plugin") {
        this.result.plugins.push(this.parsePluginDecl());
      } else if (token.text === "default" && next.type === TokenType.IDENTIFIER && next.text === "rule") {
        this.nextToken();
        this.result.rules.push(this.parseRuleDecl(undefined, undefined, token.start));
      } else if (token.text === "default") {
        this.result.defaults.push(this.parsePrefixedDecl("default", doc));
      } else if (token.text === "private" && next.type === TokenType.IDENTIFIER) {
        const decl = { ...this.parsePrefixedDecl("private", doc), private: true };
        if (decl.kind === DeclKind.Target) {
          this.result.targets.push(decl);
        } else {
          this.result.properties.push(decl);
        }
      } else if (token.text === "rule" && next.type === TokenType.IDENTIFIER) {
        const type = next.text;
        this.nextToken();
        this.result.rules.push(this.parseRuleDecl(type, next.start, token.start));
      } else if (token.text === "repository" && next.type === TokenType.IDENTIFIER) {
        this.result.repositories.push(this.parseRepositoryDecl(token.start));
      } else if (next.type === TokenType.EQUALS || next.type === TokenType.LANGLE) {
        /* `<` is the property's guard (`TSC<TARGET=…> = …`). */
        this.result.properties.push(this.parsePropertyDecl(this.finishPropertyKey(Name.fromLiteral(token.text)), token.start, doc));
      } else if (next.type === TokenType.IDENTIFIER || next.type === TokenType.SIMPLE_NAME) {
        if (token.text === "targetdef") {
          this.result.targetdefs.push(this.parseTargetDefDecl(doc));
        } else {
          this.result.targets.push(this.parseTargetDecl(token.text, token.start, doc));
        }
      } else {
        this.unexpectedTokenError("Identifier or '='");
      }
    } else if (token.type === TokenType.LANGLE) {
      /* A statement-initial guard: `<TARGET=…> { … }` over global properties. */
      this.result.properties.push(...this.parseGuardBlock());
    } else {
      this.unexpectedTokenError("Statement");
    }
  }

  /**
   * Skip tokens after an error to the next statement: an IDENTIFIER after a ';'
   * or '}'. A guard block there (a statement starting `<`) is skipped as well.
   */
  private recoverFromError(): void {
    let last = this.token.type;
    while (last !== TokenType.EOF) {
      const next = this.skipToken();
      if ((last === TokenType.SEMI || last === TokenType.RBRACE) && next.type === TokenType.IDENTIFIER) {
        break;
      }
      last = next.type;
    }
  }

  /** Parse the whole file, reporting errors and resuming after each. */
  public parse(): IBuildFileContents {
    while (this.token.type !== TokenType.EOF) {
      try {
        this.parseStatement();
      } catch (error) {
        if (!(error instanceof ParseAbort)) {
          throw error;
        } else {
          this.recoverFromError();
        }
      }
      this.statements++;
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

/** Parse a single name expression, such as a command-line reference. A
 * malformed name throws a FabrError whose message holds the diagnostics; none
 * is logged. */
export function parseName(contents: string): Name {
  const messages: string[] = [];
  const captureLog: Log = { log: (diagnostic, params) => messages.push(diagnostic.message(params)) };
  try {
    /* A lexical error in the first token (an unterminated quote, character
     * class or extglob group) is captured as the constructor reads it, and the
     * name parsed is then empty. */
    const parser = new BuildParser({ fs: EMPTY_FILESET, file: COMMAND_LINE_FILE, reader: new StringReader(contents) }, captureLog);
    const name = parser.parseName();
    if (messages.length === 0) {
      return name;
    }
  } catch (err) {
    if (!(err instanceof ParseAbort)) {
      throw err;
    }
  }
  throw new FabrError(`Invalid name '${contents}': ${messages.join("; ")}`);
}
