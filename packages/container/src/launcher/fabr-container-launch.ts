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

/*
 * The launcher of a runnable image, run by the node that runs fabr. It is
 * staged into the image's install on its own, so it uses node's own modules
 * and nothing else.
 *
 * `run <engine> <owner> <tag> <layout> <count> <options…> <args…>` runs the
 * image `tag` with the container engine `engine` (Docker or podman): the first
 * `count` arguments after `count` are the engine's options for the run
 * (`-p 8080:8080/tcp`, `-e NAME=value`) and the rest the program's own.
 *
 * - Where the engine does not hold the tag, it loads the OCI layout in the
 *   directory `layout`, streamed as a tar into `load`, then removes the
 *   repository's other tags except the one tagged most recently, leaving any a
 *   container still uses.
 * - It runs the image with `--rm` and `--init` (a minimal init that passes
 *   signals on to the program: the kernel ignores signals sent to a PID 1 that
 *   does not handle them), stdin attached, and a terminal where stdin is one.
 * - The container is named `fabr-$FABR_LAUNCH` where fabr launched it, which
 *   `remove` removes; otherwise `fabr-<owner>-<pid>-run`, the pid the
 *   launcher's, which a later run's reaping removes once it has exited.
 * - It passes SIGTERM on to the engine's client, and SIGINT and SIGHUP where
 *   it has no terminal (a terminal delivers those to both), and exits as the
 *   client did.
 *
 * `remove <engine>` removes the container of the launch `FABR_LAUNCH` names,
 * whether or not it is still running.
 */

import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Readable } from "stream";
import * as tty from "tty";
import { pipeline } from "stream/promises";

/** The size of a tar block, header or padding. */
const BLOCK = 512;

/** Write `message` as the launcher's failure and exit. */
function fail(message: string): never {
  process.stderr.write(`fabr-container-launch: ${message}\n`);
  process.exit(125);
}

/** @return the names under `root`, `/`-separated and sorted, a directory (with a trailing `/`) before what it holds. */
function entriesOf(root: string, prefix = ""): string[] {
  return fs
    .readdirSync(path.join(root, prefix), { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap(entry =>
      entry.isDirectory() ? [`${prefix}${entry.name}/`, ...entriesOf(root, `${prefix}${entry.name}/`)] : [`${prefix}${entry.name}`]
    );
}

/** Write `value` into `header` at `offset` as a NUL-terminated octal field of
 * `width` bytes, or, where it is too large for one, as a base-256 number (the
 * field's first byte 0x80, the rest big-endian), which GNU tar and Go read. */
function octal(header: Buffer, offset: number, width: number, value: number): void {
  if (value < 8 ** (width - 1)) {
    header.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, width, "ascii");
    return;
  }
  header[offset] = 0x80;
  let rest = value;
  for (let at = offset + width - 1; at > offset; at--) {
    header[at] = rest % 256;
    rest = Math.floor(rest / 256);
  }
}

/** @return the ustar header of the entry `name`: a directory where it ends in `/`, else a file of `size` bytes. */
function headerOf(name: string, size: number): Buffer {
  const header = Buffer.alloc(BLOCK);
  const directory = name.endsWith("/");
  /* A name over 100 bytes is split at a `/` into the 155-byte prefix and the
   * name, a directory's own trailing `/` dropped (its type says what it is). */
  let prefix = "";
  let rest = name;
  if (Buffer.byteLength(name) > 100) {
    const written = directory ? name.slice(0, -1) : name;
    const splits = [...written.matchAll(/\//g)].map(match => match.index);
    const at =
      Buffer.byteLength(written) <= 100
        ? -1
        : splits.find(
            at => at > 0 && Buffer.byteLength(written.slice(0, at)) <= 155 && Buffer.byteLength(written.slice(at + 1)) <= 100
          );
    if (at === undefined) {
      throw new Error(`the layout's entry '${name}' is too long a name for a tar`);
    }
    prefix = at === -1 ? "" : written.slice(0, at);
    rest = written.slice(at + 1);
  }
  header.write(rest, 0, 100, "utf8");
  octal(header, 100, 8, directory ? 0o755 : 0o644);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, directory ? 0 : size);
  octal(header, 136, 12, 0);
  header.write("        ", 148, 8, "ascii");
  header.write(directory ? "5" : "0", 156, 1, "ascii");
  header.write("ustar\u000000", 257, 8, "ascii");
  header.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of header) {
    sum += byte;
  }
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

/** Yield the tar of the directory `root`, its entries in {@link entriesOf}'s order. */
export async function* tarOf(root: string): AsyncGenerator<Buffer> {
  for (const name of entriesOf(root)) {
    if (name.endsWith("/")) {
      yield headerOf(name, 0);
      continue;
    }
    const file = path.join(root, name);
    const size = fs.statSync(file).size;
    yield headerOf(name, size);
    for await (const chunk of fs.createReadStream(file)) {
      yield chunk as Buffer;
    }
    if (size % BLOCK !== 0) {
      yield Buffer.alloc(BLOCK - (size % BLOCK));
    }
  }
  yield Buffer.alloc(2 * BLOCK);
}

/** @return the standard output of `engine` run with `args`, empty where it fails. */
function engineOutput(engine: string, args: string[]): string {
  const result = spawnSync(engine, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout : "";
}

/** Load the layout `layout` into `engine`, then remove the other tags of `image`'s repository but the most recent. */
async function load(engine: string, image: string, layout: string): Promise<void> {
  const child = spawn(engine, ["load", "-q"], { stdio: ["pipe", "ignore", "inherit"] });
  const exited = new Promise<number | null>(resolve => {
    child.on("error", err => fail(`could not run ${engine}: ${err.message}`));
    child.on("close", resolve);
  });
  /* The engine's exit status decides the outcome; a failure writing to it is
   * only its consequence, bar one reading the layout. */
  const sent = pipeline(Readable.from(tarOf(layout)), child.stdin).then(
    () => undefined,
    (err: NodeJS.ErrnoException) => err
  );
  const [status, unsent] = await Promise.all([exited, sent]);
  const reading = unsent !== undefined && unsent.code !== "EPIPE" && unsent.code !== "ERR_STREAM_PREMATURE_CLOSE";
  if (status !== 0 || unsent !== undefined) {
    fail(`'${engine} load' could not load ${image}${reading ? `: ${unsent.message}` : ` (exit status ${status})`}`);
  }
  const repository = image.slice(0, image.lastIndexOf(":"));
  const others = engineOutput(engine, ["image", "ls", repository, "--format", "{{.Repository}}:{{.Tag}}"])
    .split("\n")
    .filter(tag => tag !== "" && tag !== image);
  const byAge = others
    .map(tag => ({ tag, tagged: engineOutput(engine, ["image", "inspect", "-f", "{{.Metadata.LastTagTime}}", tag]).trim() }))
    .sort((a, b) => (a.tagged < b.tagged ? 1 : a.tagged > b.tagged ? -1 : 0));
  for (const { tag } of byAge.slice(1)) {
    spawnSync(engine, ["rmi", tag], { stdio: "ignore" });
  }
}

/**
 * @return the engine's arguments running `image` in the container `name`:
 * `options`, the image, then `args`, with a terminal where `terminal` says
 * stdin is one.
 */
export function runArguments(
  name: string,
  image: string,
  options: readonly string[],
  args: readonly string[],
  terminal: boolean
): string[] {
  return ["run", "--rm", "--init", "-i", ...(terminal ? ["-t"] : []), "--name", name, ...options, image, ...args];
}

/** Run the image as `run` describes (see the file's description). */
async function run([engine, owner, image, layout, count, ...rest]: string[]): Promise<void> {
  const options = Number(count);
  if (engine === undefined || owner === undefined || image === undefined || layout === undefined || !(options <= rest.length)) {
    fail("usage: run <engine> <owner> <tag> <layout> <count> <options…> <args…>");
  }
  if (spawnSync(engine, ["image", "inspect", image], { stdio: "ignore" }).status !== 0) {
    await load(engine, image, layout);
  }
  const name = `fabr-${process.env.FABR_LAUNCH || `${owner}-${process.pid}-run`}`;
  const child = spawn(engine, runArguments(name, image, rest.slice(0, options), rest.slice(options), tty.isatty(0)), {
    stdio: "inherit",
  });
  /* A terminal delivers its own signals to the client too, so where there is
   * one only a signal sent to the launcher alone is passed on. */
  const terminal = [0, 1, 2].some(fd => tty.isatty(fd));
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    process.on(signal, signal === "SIGTERM" || !terminal ? () => child.kill(signal) : () => undefined);
  }
  child.on("error", err => fail(`could not run ${engine}: ${err.message}`));
  child.on("exit", (code, signal) => process.exit(code ?? 128 + (signal === null ? 0 : os.constants.signals[signal])));
}

/** Remove the container of the launch `FABR_LAUNCH` names, where it names one. */
function remove([engine]: string[]): void {
  const launch = process.env.FABR_LAUNCH;
  if (engine !== undefined && launch) {
    spawnSync(engine, ["rm", "-f", `fabr-${launch}`], { stdio: "ignore" });
  }
}

/** Run the command the launcher was given. */
function main([command, ...args]: string[]): void {
  if (command === "run") {
    run(args).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
  } else if (command === "remove") {
    remove(args);
  } else {
    fail(`unknown command '${command ?? ""}': expected 'run' or 'remove'`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}
