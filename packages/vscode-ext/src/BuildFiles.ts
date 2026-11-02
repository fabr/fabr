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
 * A project's build files in the editor, through the language server its
 * `fabr build-server` carries beside BSP: the documents open in the editor
 * sent to it, and its outline, definitions, hovers, completions, code lenses
 * and diagnostics shown.
 */

import * as vscode from "vscode";
import type { JsonRpcClient } from "./JsonRpcClient";
import { type IProtocolRange, isRecord, toDiagnostic, toProtocolDiagnostics, toRange } from "./ProtocolDiagnostics";

/** The language a build file is, as `extension.json` contributes it. */
export const FABR_LANGUAGE = "fabr";

/** A definition's location, as LSP carries one: the span of the document asked about that names it, and where it is declared. */
interface ILspLocationLink {
  originSelectionRange?: IProtocolRange;
  targetUri: string;
  targetRange: IProtocolRange;
  targetSelectionRange: IProtocolRange;
}

/** A completion item, as LSP carries one. */
interface ILspCompletion {
  label: string;
  kind: number;
  detail?: string;
  documentation?: { value: string };
}

/** A document symbol, as LSP carries one. */
interface ILspSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: IProtocolRange;
  selectionRange: IProtocolRange;
}

/**
 * Show the build files of the project at `root` through `client`, the
 * server's language server: initialize it, keep it told of the build files
 * open in the editor, and answer outline, definition, hover, completion and
 * code lenses from it, its diagnostics shown in `problems`.
 *
 * @return what to dispose of when the project's server ends, and what has the
 * editor ask for the lenses again once the targets served change.
 */
export function serveBuildFiles(root: string, client: JsonRpcClient, problems: vscode.DiagnosticCollection): vscode.Disposable & { refreshLenses(): void } {
  const lensesChanged = new vscode.EventEmitter<void>();
  const selector: vscode.DocumentSelector = { language: FABR_LANGUAGE, pattern: new vscode.RelativePattern(root, "**/*.fabr") };
  const ours = (document: vscode.TextDocument): boolean => vscode.languages.match(selector, document) > 0;
  const opened = (document: vscode.TextDocument): void => {
    if (ours(document)) {
      client.notify("textDocument/didOpen", {
        textDocument: { uri: document.uri.toString(), languageId: FABR_LANGUAGE, version: document.version, text: document.getText() },
      });
    }
  };
  const textDocument = (document: vscode.TextDocument): { uri: string } => ({ uri: document.uri.toString() });
  const ready = client.request("initialize", { processId: process.pid, rootUri: vscode.Uri.file(root).toString(), capabilities: {} }).then(() => {
    client.notify("initialized", {});
    vscode.workspace.textDocuments.forEach(opened);
  });
  /* The documents this project's server reported in: `problems` is every project's. */
  const reportedIn = new Set<string>();
  client.onNotification("textDocument/publishDiagnostics", params => {
    if (!isRecord(params) || typeof params.uri !== "string") {
      return;
    }
    reportedIn.add(params.uri);
    problems.set(vscode.Uri.parse(params.uri), toProtocolDiagnostics(params.diagnostics).map(toDiagnostic));
  });
  const request = <T>(method: string, params: unknown): Thenable<T | undefined> =>
    ready.then(() => client.request<T>(method, params)).then(
      result => result,
      () => undefined
    );
  const disposable = vscode.Disposable.from(
    lensesChanged,
    vscode.workspace.onDidOpenTextDocument(opened),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (ours(event.document)) {
        client.notify("textDocument/didChange", {
          textDocument: { ...textDocument(event.document), version: event.document.version },
          contentChanges: [{ text: event.document.getText() }],
        });
      }
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      if (ours(document)) {
        client.notify("textDocument/didClose", { textDocument: textDocument(document) });
      }
    }),
    vscode.languages.registerDocumentSymbolProvider(selector, {
      provideDocumentSymbols: document =>
        request<ILspSymbol[]>("textDocument/documentSymbol", { textDocument: textDocument(document) }).then(symbols =>
          (symbols ?? []).map(
            symbol => new vscode.DocumentSymbol(symbol.name, symbol.detail ?? "", symbol.kind - 1, toRange(symbol.range), toRange(symbol.selectionRange))
          )
        ),
    }),
    vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition: (document, position) =>
        request<ILspLocationLink[]>("textDocument/definition", { textDocument: textDocument(document), position }).then(links =>
          (links ?? []).map(
            (link): vscode.LocationLink => ({
              ...(link.originSelectionRange === undefined ? {} : { originSelectionRange: toRange(link.originSelectionRange) }),
              targetUri: vscode.Uri.parse(link.targetUri),
              targetRange: toRange(link.targetRange),
              targetSelectionRange: toRange(link.targetSelectionRange),
            })
          )
        ),
    }),
    vscode.languages.registerCompletionItemProvider(
      selector,
      {
        provideCompletionItems: (document, position) =>
          request<ILspCompletion[]>("textDocument/completion", { textDocument: textDocument(document), position }).then(items =>
            (items ?? []).map(item => {
              /* LSP's kinds count from 1, VS Code's from 0. */
              const completion = new vscode.CompletionItem(item.label, item.kind - 1);
              completion.detail = item.detail;
              completion.documentation = item.documentation === undefined ? undefined : new vscode.MarkdownString(item.documentation.value);
              return completion;
            })
          ),
      },
      "{",
      "$"
    ),
    vscode.languages.registerCodeLensProvider(selector, {
      onDidChangeCodeLenses: lensesChanged.event,
      provideCodeLenses: document =>
        request<Array<{ range: IProtocolRange; command: { title: string; command: string; arguments?: unknown[] } }>>("textDocument/codeLens", {
          textDocument: textDocument(document),
        }).then(lenses => (lenses ?? []).map(lens => new vscode.CodeLens(toRange(lens.range), lens.command))),
    }),
    vscode.languages.registerHoverProvider(selector, {
      provideHover: (document, position) =>
        request<{ contents: { value: string }; range?: IProtocolRange } | null>("textDocument/hover", { textDocument: textDocument(document), position }).then(hover =>
          hover ? new vscode.Hover(new vscode.MarkdownString(hover.contents.value), hover.range === undefined ? undefined : toRange(hover.range)) : undefined
        ),
    }),
    { dispose: () => reportedIn.forEach(uri => problems.delete(vscode.Uri.parse(uri))) }
  );
  return { dispose: () => disposable.dispose(), refreshLenses: () => lensesChanged.fire() };
}
