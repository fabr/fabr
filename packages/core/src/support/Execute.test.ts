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
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PassThrough } from "stream";
import { IOutputHandle } from "../core/BuildCache";
import { Computable } from "../core/Computable";
import { FileSet, IFile } from "../core/FileSet";
import { MemoryFile } from "../core/MemoryFS";
import { execute, executeInteractive, executePipeline } from "./Execute";

const NODE = process.execPath;
const MISSING = "/nonexistent/fabr-definitely-not-here";
const CWD = process.cwd();

/** An in-memory stand-in for BuildCache.getTemporaryWriteStream: collect the
 * piped bytes and finalize to a MemoryFile, so the pipeline tests exercise the
 * wiring without a real content store. */
function memoryOutput(): IOutputHandle {
  const chunks: Buffer[] = [];
  const stream = new PassThrough();
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  return {
    stream,
    finalize: (): Computable<IFile> =>
      Computable.fromOnce<IFile>(resolve => {
        stream.on("end", () => resolve(new MemoryFile(Buffer.concat(chunks))));
        stream.end();
      }),
    discard: () => stream.destroy(),
  };
}

function runPipeline(stages: Parameters<typeof executePipeline>[0], stdin?: Uint8Array): Promise<FileSet> {
  return new Promise((resolve, reject) => executePipeline(stages, CWD, memoryOutput, stdin).then(resolve, reject));
}

/** The text of a captured file in the pipeline result. */
function captured(files: FileSet, name: string): Promise<string> {
  return new Promise((resolve, reject) =>
    files.get(name).then(file => (file ? file.readString().then(resolve, reject) : reject(new Error(`no capture '${name}'`))), reject)
  );
}

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
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("execute hung reading stdin")), 20000)),
    ]);
    expect(outcomes).to.deep.equal([{ ok: true, value: undefined }]);
  });

  it("sweeps a step's leaked background process when the step exits", async () => {
    /* A step that spawns a long-lived child and exits without cleaning it up —
     * ill-behaved tooling fabr must not rely on. The step runs in its own
     * process group; on the step's exit the group is swept, so the straggler
     * dies instead of surviving as an orphan (and, had it inherited the step's
     * output pipes, hanging the build's stream-close wait). */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-exec-sweep-"));
    try {
      const pidFile = path.join(dir, "pid.txt");
      const script =
        'const { spawn } = require("child_process");' +
        'const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });' +
        'require("fs").writeFileSync(process.argv[1], String(c.pid));' +
        "c.unref();"; /* unref so the step's own process exits at once */
      const outcomes = await collectSettlements(execute(NODE, ["-e", script, pidFile], dir, {}));
      expect(outcomes).to.deep.equal([{ ok: true, value: undefined }]);
      expect(await processGone(Number(fs.readFileSync(pidFile, "utf8")), 15000)).to.equal(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Poll until `pid` no longer exists (true) or `timeoutMs` elapses (false). */
async function processGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

describe("executePipeline", () => {
  it("wires stdout->stdin between stages and captures the final stdout", async () => {
    const files = await runPipeline([
      { argv: [NODE, "-e", "process.stdout.write('hello')"] },
      {
        argv: [NODE, "-e", "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d.toUpperCase()))"],
        stdout: "out",
      },
    ]);
    expect(await captured(files, "out")).to.equal("HELLO");
  });

  it("feeds the head stage stdin and merges stdout+stderr for '&>'", async () => {
    const files = await runPipeline(
      [
        {
          argv: [NODE, "-e", "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{process.stdout.write('O'+d);process.stderr.write('E')})"],
          both: "log",
        },
      ],
      Buffer.from("x")
    );
    const log = await captured(files, "log");
    expect(log).to.contain("Ox");
    expect(log).to.contain("E");
  });

  it("fails on the first non-zero stage (pipefail), settling exactly once", async () => {
    const outcomes = await collectSettlements(executePipeline([{ argv: [NODE, "-e", "process.exit(4)"] }], CWD, memoryOutput));
    expect(outcomes).to.have.length(1);
    expect(outcomes[0].ok).to.equal(false);
    expect(outcomes[0].err?.message).to.include("exited with error code 4");
  });

  it("does not hang or double-settle when a downstream stage exits before draining (SIGPIPE)", async () => {
    /* The producer writes 4 MB; the consumer exits immediately without reading.
     * Without the broken-pipe propagation the producer blocks forever on a pipe
     * nobody drains (hang), and without the stream 'error' handlers the EPIPE
     * crashes the process. Assert it settles once, within a bound. */
    const settled = collectSettlements(
      executePipeline(
        [
          { argv: [NODE, "-e", "process.stdout.write(Buffer.alloc(4*1024*1024, 65))"] },
          { argv: [NODE, "-e", "process.exit(0)"], stdout: "out" },
        ],
        CWD,
        memoryOutput
      )
    );
    const outcomes = await Promise.race([
      settled,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("pipeline hung on early downstream exit")), 20000)),
    ]);
    expect(outcomes).to.have.length(1);
  });

  it("reports a stage spawn failure once, with the exec error", async () => {
    const outcomes = await collectSettlements(executePipeline([{ argv: [MISSING] }], CWD, memoryOutput));
    expect(outcomes).to.have.length(1);
    expect(outcomes[0].ok).to.equal(false);
    expect(outcomes[0].err?.message).to.include("unable to execute");
  });

  it("sweeps a failing stage's leaked child (pipefail leaves no orphans)", async () => {
    /* The genrule shape of the same guarantee: a stage that spawned a long-lived
     * child and then failed must not leave that child behind — each stage is a
     * group leader and its group is swept when it exits, whichever way. */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabr-pipe-sweep-"));
    try {
      const pidFile = path.join(dir, "pid.txt");
      const script =
        'const { spawn } = require("child_process");' +
        'const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });' +
        'require("fs").writeFileSync(process.argv[1], String(c.pid));' +
        "c.unref();" +
        "process.exit(1);";
      const outcomes = await collectSettlements(executePipeline([{ argv: [NODE, "-e", script, pidFile] }], dir, memoryOutput));
      expect(outcomes).to.have.length(1);
      expect(outcomes[0].ok).to.equal(false);
      expect(await processGone(Number(fs.readFileSync(pidFile, "utf8")), 15000)).to.equal(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
