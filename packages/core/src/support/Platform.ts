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

import * as os from "node:os";

/**
 * Project a triple to the node/npm {os, cpu, libc} vocabulary the npm os/cpu/libc
 * gate matches against. Lenient about vendor presence and 2/3/4-part forms: it
 * reads the arch off the first field and detects the OS family / libc from the
 * remaining fields, rather than imposing a strict positional parse (the verbatim
 * string is what native consumers want; this is only the lossy npm view).
 */
export function tripleToNpm(triple: string): NpmPlatform {
  const parts = triple.split("-");
  const cpu = ARCH_TO_NODE[parts[0]];
  let os: string | undefined;
  if (parts.some(p => p === "darwin" || p.startsWith("macosx") || p === "apple" || p.startsWith("ios"))) {
    os = "darwin";
  } else if (parts.includes("linux")) {
    os = "linux";
  } else if (parts.some(p => p.startsWith("windows") || p === "win32" || p === "mingw32" || p === "msvc")) {
    os = "win32";
  }
  /* libc is the linux abi field only; darwin/windows have no libc notion. */
  const libc = os === "linux" ? (parts.some(p => p.includes("musl")) ? "musl" : "glibc") : undefined;
  return { os, cpu, libc };
}

/** Triple arch field → node arch vocabulary. */
const ARCH_TO_NODE: Record<string, string> = {
  x86_64: "x64",
  amd64: "x64",
  i686: "ia32",
  i386: "ia32",
  x86: "ia32",
  aarch64: "arm64",
  arm64: "arm64",
  armv7: "arm",
  armv7l: "arm",
  arm: "arm",
};

/** node/npm platform vocabulary: process.platform / process.arch, plus libc. */
export interface NpmPlatform {
  /** process.platform vocabulary: darwin, linux, win32 (undefined if unrecognized). */
  os?: string;
  /** process.arch vocabulary: x64, arm64, ia32, arm (undefined if unrecognized). */
  cpu?: string;
  /** glibc / musl — linux only; undefined elsewhere. */
  libc?: string;
}

/**
 * The platform triple for the machine fabr is currently running on — the value of
 * the injected HOST fact (and the default for TARGET). Built from
 * process.arch/platform (+ the Darwin kernel version and libc detection); no
 * subprocess. Falls back to `<arch>-<platform>` for platforms we don't spell.
 */
export function hostTriple(): string {
  const arch = process.arch;
  switch (process.platform) {
    case "darwin":
      return `${nodeArchToTriple(arch, false)}-apple-macosx${darwinToMacOS(os.release())}`;
    case "linux":
      return `${nodeArchToTriple(arch, true)}-linux-${detectLinuxLibc()}`;
    case "win32":
      return `${nodeArchToTriple(arch, true)}-pc-windows-msvc`;
    default:
      return `${arch}-${process.platform}`;
  }
}

/** node arch → triple arch field, per OS (GNU spells arm64 `aarch64`; Apple `arm64`). */
function nodeArchToTriple(arch: string, gnuStyle: boolean): string {
  switch (arch) {
    case "x64":
      return "x86_64";
    case "ia32":
      return "i686";
    case "arm64":
      return gnuStyle ? "aarch64" : "arm64";
    case "arm":
      return "armv7";
    default:
      return arch;
  }
}

/**
 * Map a Darwin kernel version (`os.release()`, e.g. `24.6.0`) to the macOS product
 * version the `macosx…` triple component wants. Kernel major 20+ is macOS 11+
 * (major = kernel − 9); 5..19 is the 10.x era (10.<kernel − 4>). The minor is
 * always `.0` — a deployment floor, since the kernel major only pins the product
 * major (avoiding a `sw_vers` subprocess).
 */
function darwinToMacOS(release: string): string {
  const kernelMajor = parseInt(release.split(".")[0], 10);
  if (Number.isNaN(kernelMajor)) {
    return "10.0";
  } else if (kernelMajor >= 20) {
    return `${kernelMajor - 9}.0`;
  } else if (kernelMajor >= 5) {
    return `10.${kernelMajor - 4}`;
  } else {
    return "10.0";
  }
}

/**
 * Detect the host libc as a triple abi token (`gnu` / `musl`), synchronously and
 * without a subprocess: Node's diagnostic report header carries
 * `glibcVersionRuntime` on glibc builds and omits it on musl (verified: `'2.41'`
 * on glibc Linux, absent on darwin). Only meaningful on linux; the conservative
 * default if the report is unavailable is `gnu`.
 */
function detectLinuxLibc(): string {
  try {
    const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
    return header && header.glibcVersionRuntime ? "gnu" : "musl";
  } catch {
    return "gnu";
  }
}
