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
import { TaskState } from "../model/BuildEvents";
import { activityCounter, execute, executeInteractive, executePipeline, lineSplitter, SILENT_REPORT } from "./Execute";
import { Semaphore } from "./Semaphore";

const NODE = process.execPath;
const MISSING = "/nonexistent/fabr-definitely-not-here";
const CWD = process.cwd();
/* Wide enough that no test here ever queues: these tests exercise the process
 * mechanics, not the funnel. */
const LIMIT = new Semaphore(16);

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

function runPipeline(stages: Parameters<typeof executePipeline>[1], stdin?: Uint8Array): Promise<FileSet> {
  return new Promise((resolve, reject) => executePipeline(LIMIT, stages, CWD, memoryOutput, stdin, SILENT_REPORT).then(resolve, reject));
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

describe("lineSplitter", () => {
  /** Feed `chunks` through a splitter and collect the lines it emits. */
  function split(chunks: string[], flush = true): string[] {
    const lines: string[] = [];
    const splitter = lineSplitter((text: string) => lines.push(text));
    chunks.forEach(chunk => splitter.push(Buffer.from(chunk)));
    if (flush) {
      splitter.flush();
    }
    return lines;
  }

  it("emits complete lines and holds a partial one until its newline arrives", () => {
    /* Chunk boundaries fall wherever the OS put them — the split must follow the
     * bytes, not the arrivals. */
    expect(split(["one\ntw", "o\nthree\n"])).to.deep.equal(["one", "two", "three"]);
  });

  it("holds an unterminated tail back until flush", () => {
    expect(split(["done"], false)).to.deep.equal([]);
    expect(split(["done"])).to.deep.equal(["done"]);
  });

  it("normalizes \\r\\n and treats a bare \\r as a line ending", () => {
    /* A tool repainting one line in place emits no newline at all; without this
     * its bytes would hold the rest of the output hostage until the stream ends. */
    expect(split(["a\r\nb\rc\n"])).to.deep.equal(["a", "b", "c"]);
  });

  it("does not manufacture a blank line when \\r\\n is split across chunks", () => {
    /* A chunk-final \r may be half of a \r\n the OS split; splitting it eagerly
     * would read the pair as two line endings. */
    expect(split(["a\r", "\nb\n"])).to.deep.equal(["a", "b"]);
  });

  it("ends a line at a held \\r once the next chunk shows no \\n follows", () => {
    expect(split(["a\r", "b\n"])).to.deep.equal(["a", "b"]);
  });

  it("treats a trailing \\r at flush as the line's ending, not its content", () => {
    expect(split(["a\r"])).to.deep.equal(["a"]);
  });

  it("emits an empty line for a blank line rather than dropping it", () => {
    expect(split(["a\n\nb\n"])).to.deep.equal(["a", "", "b"]);
  });
});

describe("activityCounter", () => {
  function record(): { states: TaskState[]; phase: ReturnType<typeof activityCounter> } {
    const states: TaskState[] = [];
    return { states, phase: activityCounter(state => states.push(state)) };
  }

  it("reports waiting only while everything the work wants is queued", () => {
    const { states, phase } = record();
    phase("queued");
    expect(states).to.deep.equal(["waiting"]);
    phase("started");
    expect(states).to.deep.equal(["waiting", "running"]);
    phase("finished");
    /* Nothing queued and nothing running is still "running" — the moment
     * between admissions is not a state anybody is waiting to hear about. */
    expect(states).to.deep.equal(["waiting", "running"]);
  });

  it("keeps a fan-out's state held by the executions still in flight", () => {
    const { states, phase } = record();
    phase("queued");
    phase("queued");
    phase("started");
    /* The first execution finishing must not clear the state the queued one
     * still holds: with one admitted piece gone and one still waiting for a
     * slot, the work is back to waiting. */
    phase("finished");
    expect(states).to.deep.equal(["waiting", "running", "waiting"]);
  });
});

describe("execute", () => {
  it("streams output to a sink, line by line, when given one", async () => {
    const lines: string[] = [];
    const script = "process.stdout.write('out one\\nout two\\n'); console.error('err'); process.exit(0)";
    const outcomes = await collectSettlements(
      execute(LIMIT, NODE, ["-e", script], process.cwd(), {}, { ...SILENT_REPORT, output: { line: (text: string) => lines.push(text) } })
    );
    expect(outcomes).to.deep.equal([{ ok: true, value: undefined }]);
    /* Both streams reach the one sink (fabr's output is stderr either way). */
    expect(lines.sort()).to.deep.equal(["err", "out one", "out two"]);
  });

  /* The child prints text that does NOT appear in its own command line, so
   * "was the output included in the error?" can be asked of the message. */
  const REASON_SCRIPT = "console.error('x'.repeat(9)); process.exit(2)";
  const REASON = "xxxxxxxxx";

  it("keeps a streamed failure's message to the command and outcome, output having already been delivered", async () => {
    const lines: string[] = [];
    const outcomes = await collectSettlements(
      execute(LIMIT, NODE, ["-e", REASON_SCRIPT], process.cwd(), {}, { ...SILENT_REPORT, output: { line: (text: string) => lines.push(text) } })
    );
    expect(lines).to.deep.equal([REASON]);
    expect(outcomes[0].err?.message).to.include("exited with error code 2");
    expect(outcomes[0].err?.message).to.not.include(REASON);
  });

  it("keeps each stream's lines its own, never splicing a partial line onto the other's", async () => {
    const lines: Array<[string, string]> = [];
    /* stdout leaves a line unfinished, stderr writes a whole one, stdout then
     * finishes its own. Through a shared splitter these spliced into
     * "Compiling: 41%src/a.ts: error TS2322" plus a stray " done". */
    const script =
      "process.stdout.write('Compiling: 41%');" +
      "setTimeout(() => { process.stderr.write('src/a.ts: error TS2322\\n'); process.stdout.write(' done\\n'); }, 60)";
    await collectSettlements(
      execute(LIMIT, NODE, ["-e", script], process.cwd(), {}, {
        ...SILENT_REPORT,
        output: { line: (text: string, stream: string) => lines.push([stream, text]) },
      })
    );
    expect(lines).to.deep.equal([
      ["err", "src/a.ts: error TS2322"],
      ["out", "Compiling: 41% done"],
    ]);
  });

  it("captures output into the failure message when there is no sink", async () => {
    const outcomes = await collectSettlements(execute(LIMIT, NODE, ["-e", REASON_SCRIPT], process.cwd(), {}, SILENT_REPORT));
    expect(outcomes[0].err?.message).to.include(REASON);
  });

  it("delivers a tool's unterminated last line", async () => {
    const lines: string[] = [];
    await collectSettlements(
      execute(LIMIT, NODE, ["-e", "process.stderr.write('no newline here')"], process.cwd(), {}, {
        ...SILENT_REPORT,
        output: { line: (text: string) => lines.push(text) },
      })
    );
    expect(lines).to.deep.equal(["no newline here"]);
  });

  it("resolves on a zero exit", async () => {
    const outcomes = await collectSettlements(execute(LIMIT, NODE, ["-e", "process.exit(0)"], process.cwd(), {}, SILENT_REPORT));
    expect(outcomes).to.deep.equal([{ ok: true, value: undefined }]);
  });

  it("rejects on a non-zero exit, reporting the code", async () => {
    const outcomes = await collectSettlements(execute(LIMIT, NODE, ["-e", "process.exit(3)"], process.cwd(), {}, SILENT_REPORT));
    expect(outcomes).to.have.length(1);
    expect(outcomes[0].ok).to.equal(false);
    expect(outcomes[0].err?.message).to.include("exited with error code 3");
  });

  it("reports a spawn failure exactly once, with the exec error (not a bogus exit code)", async () => {
    /* Node fires 'error' (ENOENT) then 'close' (code -2); the informative error
     * must win and the 'close' must not settle a second time. */
    const outcomes = await collectSettlements(execute(LIMIT, MISSING, [], process.cwd(), {}, SILENT_REPORT));
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
      execute(LIMIT, NODE, ["-e", "require('fs').readFileSync(0); process.exit(0)"], process.cwd(), {}, SILENT_REPORT)
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
      const outcomes = await collectSettlements(execute(LIMIT, NODE, ["-e", script, pidFile], dir, {}, SILENT_REPORT));
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
    const outcomes = await collectSettlements(executePipeline(LIMIT, [{ argv: [NODE, "-e", "process.exit(4)"] }], CWD, memoryOutput, undefined, SILENT_REPORT));
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
        LIMIT,
        [
          { argv: [NODE, "-e", "process.stdout.write(Buffer.alloc(4*1024*1024, 65))"] },
          { argv: [NODE, "-e", "process.exit(0)"], stdout: "out" },
        ],
        CWD,
        memoryOutput,
        undefined,
        SILENT_REPORT
      )
    );
    const outcomes = await Promise.race([
      settled,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("pipeline hung on early downstream exit")), 20000)),
    ]);
    expect(outcomes).to.have.length(1);
  });

  it("reports a stage spawn failure once, with the exec error", async () => {
    const outcomes = await collectSettlements(executePipeline(LIMIT, [{ argv: [MISSING] }], CWD, memoryOutput, undefined, SILENT_REPORT));
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
      const outcomes = await collectSettlements(executePipeline(LIMIT, [{ argv: [NODE, "-e", script, pidFile] }], dir, memoryOutput, undefined, SILENT_REPORT));
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
