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

/**
 * The Language Server Protocol, for fabr's build files
 * (https://microsoft.github.io/language-server-protocol/), served beside the
 * Build Server Protocol over one connection. A document's structure is read
 * from its text as the editor holds it; what its names mean, from the model
 * the run loaded last. A document's diagnostics are its parse's while the
 * editor's text differs from the saved file, else what the last load reported
 * in it, published as each cycle ends.
 */

import {
  type BuildModel,
  completionsAt,
  type ICompletion,
  namedAt,
  EMPTY_FILESET,
  type ExecutionContext,
  type IBuildFileContents,
  type IBuildFileSymbol,
  type IDocumentation,
  type Log,
  parseBuildString,
  type INamed,
  symbolsOf,
  writtenAt,
} from "@fabr-build/core";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getVersion } from "./Command";
import { served } from "./BspServer";
import { type JsonRpcConnection, MethodNotFound } from "./JsonRpc";
import { collectingLog, documentOf, type IProtocolDiagnostic, rangeOf } from "./ProtocolDiagnostics";
import { type IPosition, toChangedParams, toDocumentParams, toOpenedParams, toPositionParams } from "./ProtocolParams";

/** LSP's `TextDocumentSyncKind.Full`: a change sends the document's whole text. */
const FULL_SYNC = 1;

/** LSP's `SymbolKind`s, for each kind of declaration a build file holds. */
const SYMBOL_KINDS: Record<IBuildFileSymbol["kind"], number> = { target: 19, property: 13, targetdef: 23 };

/** The requests answered from the model, which wait for the first to be loaded. */
const FROM_THE_MODEL = new Set(["textDocument/definition", "textDocument/hover", "textDocument/completion", "textDocument/codeLens"]);

/**
 * The lenses shown above a target, each for an operation its type has rules
 * for and, where `served`, that the build server serves the target under (a
 * package with no tests has no test target): the editor's command, given the
 * target's identifier.
 */
const LENSES = [
  { operation: "build", title: "Build", command: "fabr.build", served: false },
  { operation: "test", title: "Test", command: "fabr.test", served: true },
];

/** LSP's `CompletionItemKind`s, for each kind of completion a build file offers. */
const COMPLETION_KINDS: Record<ICompletion["kind"], number> = { property: 10, target: 9, type: 7, keyword: 14 };

/** A log that reports nothing: a document's parse is read for its structure, its errors being the load's to report. */
const SILENT: Log = { log: () => undefined };

/** The server of the LSP half of a connection: the documents the editor has open, and the model it answers from. */
export class LanguageServer {
  private model?: BuildModel;
  private modelLoaded: () => void = () => undefined;
  /** Settled once the first model is loaded, or the first cycle ends without one: what a request answered from the model waits for until then. */
  private readonly firstModel = new Promise<void>(resolve => (this.modelLoaded = resolve));
  /** Each open document's text, by URI. */
  private readonly documents = new Map<string, string>();
  /** The diagnostics reported in the cycle under way, by document. */
  private reported = new Map<string, IProtocolDiagnostic[]>();
  /** The diagnostics the last load reported in build files, by document. */
  private loaded = new Map<string, IProtocolDiagnostic[]>();
  /** The diagnostics of the parse of each open document whose text differs from the saved file, by URI. */
  private readonly typed = new Map<string, IProtocolDiagnostic[]>();
  /** The documents diagnostics were last published in. */
  private published = new Set<string>();
  private execution?: ExecutionContext;

  /** Serve LSP over `connection`, for the project at `sourceRoot`, `isServed` saying which targets the build server serves. */
  constructor(
    private readonly sourceRoot: string,
    private readonly connection: JsonRpcConnection,
    private readonly isServed: (uri: string) => boolean
  ) {
    connection.serve("lsp", (method, params) =>
      this.model === undefined && FROM_THE_MODEL.has(method) ? this.firstModel.then(() => this.handle(method, params)) : this.handle(method, params)
    );
  }

  /** @return `log`, the run's, also collecting what it is told with a position in a build file, published as the cycle ends. */
  public observe(log: Log): Log {
    return { log: (diagnostic, params) => collectingLog(this.sourceRoot, log, this.reported).log(diagnostic, params) };
  }

  /** Publish the diagnostics of each of `execution`'s cycles as it ends, a request waiting for a model answered from none once one has. Subscribes once, however often called. */
  public attach(execution: ExecutionContext): void {
    if (this.execution === execution) {
      return;
    }
    this.execution = execution;
    execution.onBuildEvent(event => {
      if (event.kind === "cycle-start") {
        this.reported = new Map();
      } else if (event.kind === "cycle-end") {
        this.publish();
        this.modelLoaded();
      }
    });
  }

  /** Answer from `model`, the model the run loaded last. */
  public useModel(model: BuildModel): void {
    this.model = model;
    this.modelLoaded();
  }

  /** Take the diagnostics the cycle's load reported in build files, and publish each document's. */
  private publish(): void {
    const before = [...this.loaded.keys()];
    this.loaded = new Map([...this.reported].filter(([uri]) => uri.endsWith(".fabr")));
    for (const uri of new Set([...this.published, ...before, ...this.loaded.keys()])) {
      this.publishDocument(uri);
    }
  }

  /**
   * Publish the diagnostics of the document `uri`: its parse's, where the
   * editor's text differs from the saved file, else the last load's.
   */
  private publishDocument(uri: string): void {
    const diagnostics = this.typed.get(uri) ?? this.loaded.get(uri) ?? [];
    if (diagnostics.length === 0 && !this.published.has(uri)) {
      return;
    }
    this.connection.notify("textDocument/publishDiagnostics", { uri, diagnostics }, "lsp");
    if (diagnostics.length === 0) {
      this.published.delete(uri);
    } else {
      this.published.add(uri);
    }
  }

  /** Record the text the editor holds of the document `uri`, publishing its parse's diagnostics where it differs from the saved file. */
  private typedText(uri: string, text: string | undefined): void {
    if (text === undefined) {
      this.documents.delete(uri);
    } else {
      this.documents.set(uri, text);
    }
    const file = fileURLToPath(uri);
    const saved = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
    if (text === undefined || text === saved) {
      this.typed.delete(uri);
    } else {
      const found = new Map<string, IProtocolDiagnostic[]>();
      parseBuildString(EMPTY_FILESET, path.relative(this.sourceRoot, file), text, collectingLog(this.sourceRoot, SILENT, found));
      this.typed.set(uri, [...found.values()].flat());
    }
    this.publishDocument(uri);
  }

  /** Answer `method` from the model loaded, or from none where none has loaded. */
  private handle(method: string, params: unknown): unknown {
    switch (method) {
      case "initialize":
        return {
          capabilities: {
            textDocumentSync: FULL_SYNC,
            definitionProvider: true,
            hoverProvider: true,
            documentSymbolProvider: true,
            completionProvider: { triggerCharacters: ["{", "$"] },
            codeLensProvider: {},
          },
          serverInfo: { name: "fabr", version: getVersion() },
        };
      case "initialized":
      case "shutdown":
      case "exit":
        return null;
      case "textDocument/didOpen": {
        const { uri, text } = toOpenedParams(params);
        this.typedText(uri, text);
        return null;
      }
      case "textDocument/didChange": {
        const { uri, text } = toChangedParams(params);
        if (text !== undefined) {
          this.typedText(uri, text);
        }
        return null;
      }
      case "textDocument/didClose":
        this.typedText(toDocumentParams(params).uri, undefined);
        return null;
      case "textDocument/documentSymbol":
        return symbolsOf(this.parse(toDocumentParams(params).uri).contents).map(symbol => ({
          name: symbol.name,
          ...(symbol.detail === undefined ? {} : { detail: symbol.detail }),
          kind: SYMBOL_KINDS[symbol.kind],
          range: rangeOf({ ...symbol.range.source, offset: symbol.range.offset, endOffset: symbol.range.endOffset }),
          selectionRange: rangeOf({ ...symbol.selection.source, offset: symbol.selection.offset, endOffset: symbol.selection.endOffset }),
        }));
      case "textDocument/definition": {
        const named = this.named(toPositionParams(params));
        const origin = named === undefined ? undefined : rangeOf({ ...named.origin.source, offset: named.origin.offset, endOffset: named.origin.endOffset });
        return (named?.declarations ?? []).flatMap(span => {
          const range = rangeOf(span);
          return range === undefined
            ? []
            : [{ ...(origin === undefined ? {} : { originSelectionRange: origin }), targetUri: documentOf(this.sourceRoot, span), targetRange: range, targetSelectionRange: range }];
        });
      }
      case "textDocument/hover": {
        const named = this.named(toPositionParams(params));
        if (named?.documentation === undefined) {
          return null;
        }
        const range = rangeOf({ ...named.origin.source, offset: named.origin.offset, endOffset: named.origin.endOffset });
        return { contents: { kind: "markdown", value: markdownOf(named.documentation) }, ...(range === undefined ? {} : { range }) };
      }
      case "textDocument/codeLens": {
        const { contents } = this.parse(toDocumentParams(params).uri);
        const model = this.model;
        if (model === undefined) {
          return [];
        }
        return contents.targets.flatMap(target => {
          const range = rangeOf({ ...target.source, offset: target.offset, endOffset: target.offset + target.name.toString().length });
          return range === undefined
            ? []
            : LENSES.filter(({ operation, served: whereServed }) => model.getOperations(target.type).includes(operation) && (!whereServed || this.isServed(served({ name: target.name.toString(), operation })))).map(({ operation, title, command }) => ({
                range,
                command: { title, command, arguments: [served({ name: target.name.toString(), operation })] },
              }));
        });
      }
      case "textDocument/completion": {
        const { uri, position } = toPositionParams(params);
        const { text } = this.parse(uri);
        if (this.model === undefined) {
          return [];
        }
        return completionsAt(this.model, text, offsetOf(text, position)).map(completion => ({
          label: completion.label,
          kind: COMPLETION_KINDS[completion.kind],
          ...(completion.detail === undefined ? {} : { detail: completion.detail }),
          ...(completion.comment === undefined ? {} : { documentation: { kind: "markdown", value: completion.comment } }),
        }));
      }
      default:
        throw new MethodNotFound(`${method} is not served`);
    }
  }

  /** @return what is named at `position` of the document `uri`, in the model the server answers from. */
  private named({ uri, position }: { uri: string; position: IPosition }): INamed | undefined {
    const { contents, text } = this.parse(uri);
    const offset = offsetOf(text, position);
    const written = writtenAt(contents, offset);
    return written === undefined || this.model === undefined ? undefined : namedAt(this.model, written, offset);
  }

  /** @return the parse of the document `uri`: its text as the editor holds it, else as saved. */
  private parse(uri: string): { contents: IBuildFileContents; text: string } {
    const file = fileURLToPath(uri);
    const text = this.documents.get(uri) ?? fs.readFileSync(file, "utf8");
    return { contents: parseBuildString(EMPTY_FILESET, path.relative(this.sourceRoot, file), text, SILENT), text };
  }
}

/** @return `documentation` as a hover's Markdown: its title as code, in the declaration it is part of; its source as a build file's; then its comment. */
function markdownOf(documentation: IDocumentation): string {
  return [
    documentation.title === undefined ? undefined : `\`${documentation.title}\`${documentation.within === undefined ? "" : ` in \`${documentation.within}\``}`,
    documentation.source === undefined ? undefined : "```fabr\n" + documentation.source + "\n```",
    documentation.comment,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
}

/** @return the offset in `text` of `position`, a zero-based line and UTF-16 character. */
function offsetOf(text: string, position: IPosition): number {
  let offset = 0;
  for (let line = 0; line < position.line; line++) {
    const next = text.indexOf("\n", offset);
    if (next < 0) {
      return text.length;
    }
    offset = next + 1;
  }
  return Math.min(offset + position.character, text.length);
}
