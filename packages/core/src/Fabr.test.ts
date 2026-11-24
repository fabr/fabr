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

import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Computable, ComputableSource, ComputableState } from "./core/Computable";
import { CacheDamagedError, FabrError } from "./core/Errors";
import { IFile } from "./core/FileSet";
import { Fabr, repairingEvaluation } from "./Fabr";
import { Log, LogFormatter, LogLevel } from "./support/Log";

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-run-")));
  fs.mkdirSync(path.join(root, "project"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function toPromise<T>(computable: ComputableSource<T>): Promise<T> {
  return new Promise((resolve, reject) => computable.then(resolve, reject));
}

describe("Fabr", () => {
  it("reads absolute paths where they lie, and fabr's installation as copies in the blob pool", async () => {
    const cacheRoot = path.join(root, "cache");
    const fabr = new Fabr({
      sourceRoot: path.join(root, "project"),
      cacheRoot,
      log: new LogFormatter(LogLevel.Info, () => undefined),
    });
    const credentials = path.join(root, "settings.xml");
    fs.writeFileSync(credentials, "<password>secret</password>");

    const read = (await toPromise(fabr.execution.absFileSource.get(credentials))) as IFile;
    expect(read.getAbsPath()).to.equal(credentials);
    expect(fs.existsSync(fabr.execution.buildCache.blobPathOf(read.hash))).to.equal(false);

    const installed = (await toPromise(fabr.execution.installedFileSource.get(credentials))) as IFile;
    expect(installed.getAbsPath()?.startsWith(cacheRoot + path.sep)).to.equal(true);
  });

  describe("evaluating again over a damaged cache", () => {
    /** Make a log writing into `lines`. */
    const logInto = (lines: string[]): Log => new LogFormatter(LogLevel.Info, line => lines.push(line));
    const damage = (repair: () => void = () => undefined): CacheDamagedError =>
      new CacheDamagedError(path.join(root, "gone"), "named by 'm'", repair);
    /** @return the error `computable` rejects with, or undefined where it resolves. */
    const failureOf = (computable: ComputableSource<unknown>): Promise<unknown> =>
      toPromise(computable).then(
        () => undefined,
        (err: unknown) => err
      );

    it("repairs the damage and takes the next evaluation's result", async () => {
      const lines: string[] = [];
      let repairs = 0;
      let evaluations = 0;
      const { result } = repairingEvaluation(() => {
        evaluations++;
        return evaluations === 1
          ? Computable.reject<string>(
              new FabrError(
                "wrapped",
                damage(() => void repairs++)
              )
            )
          : Computable.resolve("built");
      }, logInto(lines));
      expect(await toPromise(result)).to.equal("built");
      expect([repairs, evaluations]).to.deep.equal([1, 2]);
      expect(lines.join("\n")).to.contain("evaluating again");
    });

    it("evaluates once more for damage repaired already, then fails", async () => {
      let repairs = 0;
      let evaluations = 0;
      const { result } = repairingEvaluation(() => {
        evaluations++;
        return Computable.reject<string>(damage(() => void repairs++));
      }, logInto([]));
      expect(await failureOf(result)).to.be.instanceOf(CacheDamagedError);
      expect([repairs, evaluations]).to.deep.equal([1, 3]);
    });

    it("repairs damage `after` finds, evaluating again and calling it on the new result", async () => {
      let evaluations = 0;
      let afters = 0;
      const { result } = repairingEvaluation(
        () => Computable.resolve(++evaluations),
        logInto([]),
        value => (++afters === 1 ? Computable.reject<string>(damage()) : Computable.resolve(`after ${value}`))
      );
      expect(await toPromise(result)).to.equal("after 2");
      expect([evaluations, afters]).to.deep.equal([2, 2]);
    });

    it("ends where `after` finds the same damage on every evaluation", async () => {
      let evaluations = 0;
      const { result } = repairingEvaluation(
        () => Computable.resolve(++evaluations),
        logInto([]),
        () => Computable.reject<string>(damage())
      );
      expect(await failureOf(result)).to.be.instanceOf(CacheDamagedError);
      expect(evaluations).to.equal(3);
    });

    it("forgets what it repaired once an evaluation fails holding no damage", async () => {
      /* An input a later batch changes, as a watched file is. */
      class Input extends ComputableSource<string> {
        constructor(private current: string) {
          super();
        }
        protected override attach(): void {
          super.attach();
          this.settle(ComputableState.Valid, this.current);
        }
        public change(to: string): void {
          this.current = to;
          this.invalidate();
          this.settle(ComputableState.Valid, to);
        }
      }
      const input = new Input("damaged");
      let repairs = 0;
      const { result } = repairingEvaluation(
        () =>
          input.then(state =>
            state === "damaged"
              ? Computable.reject<string>(damage(() => void repairs++))
              : Computable.reject<string>(new FabrError(state))
          ),
        logInto([])
      );
      const outcomes: string[] = [];
      result.then(
        value => outcomes.push(value),
        (err: Error) => outcomes.push(err.message)
      );
      const settled = async (count: number): Promise<void> => {
        while (outcomes.length < count) {
          await new Promise(resolve => setImmediate(resolve));
        }
      };
      await settled(1);
      input.change("broken");
      await settled(2);
      input.change("damaged");
      await settled(3);
      expect(outcomes.slice(1, 2)).to.deep.equal(["broken"]);
      expect(repairs, "the damage found after the plain failure is repaired again").to.equal(2);
    });

    it("passes any other failure through, evaluating once", async () => {
      let evaluations = 0;
      const { result } = repairingEvaluation(() => {
        evaluations++;
        return Computable.reject<string>(new FabrError("broken"));
      }, logInto([]));
      expect(((await failureOf(result)) as Error).message).to.equal("broken");
      expect(evaluations).to.equal(1);
    });
  });
});
