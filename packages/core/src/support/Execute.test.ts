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

import { expect } from "chai";
import { Computable } from "../core/Computable";
import { execute, executeInteractive } from "./Execute";

const NODE = process.execPath;
const MISSING = "/nonexistent/fabr-definitely-not-here";

/* Record *every* settlement, not just the first. A spawn failure fires 'error'
 * then 'close', so a node that re-settles (the double-settle bug) shows up here
 * as two outcomes — and, for executeInteractive, the second one flipping a
 * rejection into a resolve. The grace window is armed only once the first
 * settlement lands (re-armed on each further one), so a slow spawn under load
 * doesn't race a fixed deadline — we wait for the process, then briefly for a
 * spurious second settle. */
function collectSettlements<T>(c: Computable<T>, graceMs = 150): Promise<Array<{ ok: boolean; value?: T; err?: Error }>> {
  return new Promise(resolve => {
    const outcomes: Array<{ ok: boolean; value?: T; err?: Error }> = [];
    let timer: NodeJS.Timeout | undefined;
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => resolve(outcomes), graceMs);
    };
    c.then(
      value => {
        outcomes.push({ ok: true, value });
        arm();
      },
      err => {
        outcomes.push({ ok: false, err });
        arm();
      }
    );
  });
}

describe("execute", () => {
  it("resolves on a zero exit", async () => {
    const outcomes = await collectSettlements(execute(NODE, ["-e", "process.exit(0)"], process.cwd(), {}));
    expect(outcomes).to.deep.equal([{ ok: true, value: undefined }]);
  });

  it("rejects on a non-zero exit, reporting the code", async () => {
    const outcomes = await collectSettlements(execute(NODE, ["-e", "process.exit(3)"], process.cwd(), {}));
    expect(outcomes).to.have.length(1);
    expect(outcomes[0].ok).to.equal(false);
    expect(outcomes[0].err?.message).to.include("exited with error code 3");
  });

  it("reports a spawn failure exactly once, with the exec error (not a bogus exit code)", async () => {
    /* Node fires 'error' (ENOENT) then 'close' (code -2); the informative error
     * must win and the 'close' must not settle a second time. */
    const outcomes = await collectSettlements(execute(MISSING, [], process.cwd(), {}));
    expect(outcomes).to.have.length(1);
    expect(outcomes[0].ok).to.equal(false);
    expect(outcomes[0].err?.message).to.include("unable to execute");
    expect(outcomes[0].err?.message).to.not.include("exited with error code");
  });

  it("gives a stdin-reading tool EOF instead of hanging", async () => {
    /* `readFileSync(0)` reads stdin to EOF; with stdin from /dev/null it returns
     * empty at once. Were stdin the default open pipe the parent holds, it would
     * block forever — so bound the wait and fail loudly on a hang. */
    const settled = collectSettlements(
      execute(NODE, ["-e", "require('fs').readFileSync(0); process.exit(0)"], process.cwd(), {})
    );
    const outcomes = await Promise.race([
      settled,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("execute hung reading stdin")), 4000)),
    ]);
    expect(outcomes).to.deep.equal([{ ok: true, value: undefined }]);
  });
});

describe("executeInteractive", () => {
  it("resolves the exit code as data", async () => {
    const outcomes = await collectSettlements(executeInteractive(NODE, ["-e", "process.exit(3)"]));
    expect(outcomes).to.deep.equal([{ ok: true, value: 3 }]);
  });

  it("rejects a spawn failure and never flips to success on the trailing 'close'", async () => {
    const outcomes = await collectSettlements(executeInteractive(MISSING, []));
    expect(outcomes).to.have.length(1);
    expect(outcomes[0].ok).to.equal(false);
    expect(outcomes[0].err?.message).to.include("unable to execute");
  });
});
