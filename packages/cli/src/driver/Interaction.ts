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

import { Computable, Diagnostic, Log, UserInteraction } from "@fabr-build/core";
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { withTerminalSuspended } from "./Terminal";

const DIAG_OPEN_URL = Diagnostic.Info<{ purpose: string; url: string }>("{purpose}: {url}");

/** The platform's open-a-URL command; the URL is passed as its own argv entry,
 * never interpolated into a shell line. */
function openCommandFor(url: string): { command: string; args: string[] } {
  switch (process.platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      /* `start` is a cmd builtin; the empty string is its window title, which
       * would otherwise swallow the URL argument. */
      return { command: "cmd", args: ["/c", "start", "", url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

/**
 * The driver's {@link UserInteraction}: questions are asked on the controlling
 * terminal (stdin for the answer, stderr for the text — stderr is fabr's
 * diagnostic stream, so a build with redirected stdout still converses), and
 * URLs are announced through the log and dispatched to the platform's opener.
 * Constructed only when fabr is attached to a tty.
 */
export class TerminalInteraction implements UserInteraction {
  constructor(private readonly log: Log) {}

  public prompt(question: string): Computable<string> {
    /* readline writes the question and echoes the answer to stderr directly:
     * fabr's own display steps aside until the line is in. */
    return withTerminalSuspended(() => this.ask(question));
  }

  private ask(question: string): Computable<string> {
    return Computable.from((resolve, reject) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      let answered = false;
      rl.question(question, answer => {
        answered = true;
        rl.close();
        resolve(answer);
      });
      /* Ctrl-D (input closed with no answer) must settle the chain, not hang it. */
      rl.on("close", () => {
        if (!answered) {
          reject(new Error("input closed before the question was answered"));
        }
      });
    });
  }

  public openUrl(url: string, purpose: string): Computable<void> {
    /* The URL is always shown: over ssh (or if the opener fails) the browser
     * never appears, and the printed URL is the fallback the user follows by
     * hand — so a launch failure is deliberately not an error. */
    this.log.log(DIAG_OPEN_URL, { purpose, url });
    const { command, args } = openCommandFor(url);
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
    return Computable.resolve(undefined);
  }
}
