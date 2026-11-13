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
 * Map a platform triple to npm's `os`, `cpu` and `libc` values, the ones a
 * package's `os`/`cpu`/`libc` fields are matched against. The arch is read off
 * the first field; the OS and libc are recognized in any later field, so a
 * triple with or without a vendor, of two to four fields, is read alike. A
 * field nothing recognizes leaves its value undefined.
 */
export function tripleToNpm(triple: string): NpmPlatform {
  const parts = triple.split("-");
  const cpu = ARCH_TO_NODE[parts[0]];
  let os: string | undefined;
  if (parts.some(p => p === "darwin" || p.startsWith("macosx") || p === "apple" || p.startsWith("ios"))) {
    os = "darwin";
  } else if (parts.some(p => p.startsWith("android"))) {
    /* Test android before linux: an android triple names linux too
     * (`aarch64-linux-android`), and npm calls its os `android`. */
    os = "android";
  } else if (parts.includes("linux")) {
    os = "linux";
  } else if (parts.some(p => p.startsWith("windows") || p === "win32" || p === "mingw32" || p === "msvc")) {
    os = "win32";
  } else if (parts.some(p => p.startsWith("aix"))) {
    os = "aix";
  }
  /* npm states a libc for linux alone (android's bionic is neither of its values). */
  const libc = os === "linux" ? (parts.some(p => p.includes("musl")) ? "musl" : "glibc") : undefined;
  return { os, cpu, libc };
}

/** The node arch (`process.arch`) of each triple arch field, in GNU/LLVM
 * spellings and node's own. Keep every `process.arch` value in it, mapped to
 * itself where no other spelling is: {@link hostTriple}'s fallback triple
 * begins with one, and an arch missing here leaves `cpu` undefined. */
const ARCH_TO_NODE: Record<string, string> = {
  x86_64: "x64",
  amd64: "x64",
  x64: "x64",
  i686: "ia32",
  i386: "ia32",
  x86: "ia32",
  ia32: "ia32",
  aarch64: "arm64",
  arm64: "arm64",
  armv7: "arm",
  armv7l: "arm",
  armv7a: "arm",
  arm: "arm",
  powerpc64: "ppc64",
  powerpc64le: "ppc64",
  ppc64: "ppc64",
  ppc64le: "ppc64",
  powerpc: "ppc",
  ppc: "ppc",
  mips: "mips",
  mipsel: "mipsel",
  s390: "s390",
  s390x: "s390x",
  riscv64: "riscv64",
  loongarch64: "loong64",
  loong64: "loong64",
};

/** A platform as npm names one: `process.platform` and `process.arch` values, and a libc. */
export interface NpmPlatform {
  /** process.platform vocabulary: darwin, linux, win32, android, aix (undefined if unrecognized). */
  os?: string;
  /** process.arch vocabulary: x64, arm64, ia32, arm (undefined if unrecognized). */
  cpu?: string;
  /** glibc / musl — linux only; undefined elsewhere. */
  libc?: string;
}

/**
 * Get the platform triple of the machine fabr is running on (the value of
 * `HOST`), from `process.arch` and `process.platform`, the Darwin kernel
 * version and the linux libc, without starting a process: such as
 * `aarch64-apple-macosx15.0`, `x86_64-linux-gnu` or `x86_64-pc-windows-msvc`.
 * Any other platform is `<process.arch>-<process.platform>`.
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

/** Map a node arch to a triple's arch field: arm64 is `aarch64` where `gnuStyle`, else `arm64` (Apple's). */
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
 * Map a Darwin kernel version (`os.release()`, such as `24.6.0`) to the macOS
 * version a `macosx…` triple field names: kernel 20 and later is macOS
 * `<kernel − 9>.0` (the minor always 0), kernel 5 to 19 is `10.<kernel − 4>`,
 * and anything else `10.0`.
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
 * Detect the linux host's libc as a triple field: `gnu` where node's diagnostic
 * report header states `glibcVersionRuntime`, else `musl`, so also `musl`
 * where `process.report` is absent. `gnu` where making the report throws.
 */
function detectLinuxLibc(): string {
  try {
    const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
    return header && header.glibcVersionRuntime ? "gnu" : "musl";
  } catch {
    return "gnu";
  }
}
