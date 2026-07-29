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
import { hostTriple, tripleToNpm } from "./Platform";

describe("tripleToNpm", () => {
  it("projects a macOS triple (deployment-version form) to darwin/arm64", () => {
    expect(tripleToNpm("arm64-apple-macosx15.0")).to.deep.equal({ os: "darwin", cpu: "arm64", libc: undefined });
  });

  it("projects an intel macOS triple", () => {
    expect(tripleToNpm("x86_64-apple-darwin")).to.deep.equal({ os: "darwin", cpu: "x64", libc: undefined });
  });

  it("reads libc off a linux triple's abi field", () => {
    expect(tripleToNpm("x86_64-linux-gnu")).to.deep.equal({ os: "linux", cpu: "x64", libc: "glibc" });
    expect(tripleToNpm("x86_64-linux-musl")).to.deep.equal({ os: "linux", cpu: "x64", libc: "musl" });
    expect(tripleToNpm("aarch64-unknown-linux-musl")).to.deep.equal({ os: "linux", cpu: "arm64", libc: "musl" });
  });

  it("defaults an unmarked linux abi to glibc", () => {
    expect(tripleToNpm("aarch64-linux")).to.deep.equal({ os: "linux", cpu: "arm64", libc: "glibc" });
  });

  it("projects a windows triple (no libc)", () => {
    expect(tripleToNpm("x86_64-pc-windows-msvc")).to.deep.equal({ os: "win32", cpu: "x64", libc: undefined });
  });

  it("is lenient about vendor presence (3- vs 4-part)", () => {
    expect(tripleToNpm("x86_64-linux-gnu")).to.deep.equal(tripleToNpm("x86_64-unknown-linux-gnu"));
  });

  it("leaves an unrecognized arch/os undefined rather than guessing", () => {
    expect(tripleToNpm("sparc-sun-solaris")).to.deep.equal({ os: undefined, cpu: undefined, libc: undefined });
  });

  it("gates android on os:android, not the linux the triple also names", () => {
    /* npm's `os` vocabulary has android as its own value; bionic isn't glibc/musl. */
    expect(tripleToNpm("aarch64-linux-android")).to.deep.equal({ os: "android", cpu: "arm64", libc: undefined });
    expect(tripleToNpm("armv7a-unknown-linux-androideabi")).to.deep.equal({
      os: "android",
      cpu: "arm",
      libc: undefined,
    });
  });

  it("maps the less-common arch fields to node's cpu vocabulary", () => {
    expect(tripleToNpm("powerpc64le-unknown-linux-gnu").cpu).to.equal("ppc64");
    expect(tripleToNpm("s390x-ibm-linux-gnu").cpu).to.equal("s390x");
    expect(tripleToNpm("riscv64-unknown-linux-gnu").cpu).to.equal("riscv64");
    expect(tripleToNpm("loongarch64-unknown-linux-gnu").cpu).to.equal("loong64");
  });

  it("reads node's own arch spelling, as the fallback triple emits it", () => {
    /* hostTriple falls back to `<process.arch>-<process.platform>` on a platform
     * it has no triple for, so those spellings must map or the cpu gate is lost. */
    expect(tripleToNpm("x64-freebsd").cpu).to.equal("x64");
    expect(tripleToNpm("ia32-openbsd").cpu).to.equal("ia32");
    expect(tripleToNpm("s390-zos").cpu).to.equal("s390");
  });
});

describe("hostTriple", () => {
  it("produces a triple that projects back to the running platform", () => {
    const triple = hostTriple();
    const npm = tripleToNpm(triple);
    expect(npm.os).to.equal(process.platform);
    expect(npm.cpu).to.equal(process.arch);
    /* libc is meaningful only on linux; elsewhere the abi carries no libc. */
    if (process.platform === "linux") {
      expect(npm.libc).to.be.oneOf(["glibc", "musl"]);
    } else {
      expect(npm.libc).to.equal(undefined);
    }
  });
});
