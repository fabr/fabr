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
import { FileSet, IFile, MemoryFile, parseName } from "@fabr-build/core";
import { makeJdkRunnable } from "./JdkDistribution";

/** A release laid out as `names`, each executable where it is marked `*`. */
function release(...names: string[]): FileSet {
  return new FileSet(
    new Map(names.map((name): [string, IFile] => (name.endsWith("*") ? [name.slice(0, -1), new MemoryFile(Buffer.from(name), 0o755)] : [name, MemoryFile.from(name)])))
  );
}

/** @return the install path `fabr run`'s `@jdk:<v>:<command>` would launch. */
function entryOf(files: FileSet, command: string): string {
  const selected = makeJdkRunnable(files).selectEntry([{ pattern: parseName(command), prefix: "" }]);
  return selected!.toCommandLine()[0];
}

describe("makeJdkRunnable", () => {
  it("offers each command in the home's bin by name, wherever the home is", () => {
    const mac = release("Contents/Home/bin/javac*", "Contents/Home/bin/java*", "Contents/Home/lib/modules", "Contents/Info.plist");
    expect(entryOf(mac, "javac")).to.equal("Contents/Home/bin/javac");
    const linux = release("bin/javac*", "bin/java*", "lib/modules");
    expect(entryOf(linux, "java")).to.equal("bin/java");
  });

  it("offers a Windows command without its .exe, and no DLL beside it", () => {
    const windows = release("bin/javac.exe", "bin/java.exe", "bin/jli.dll", "lib/modules");
    expect(entryOf(windows, "javac")).to.equal("bin/javac.exe");
    expect(makeJdkRunnable(windows).selectEntry([{ pattern: parseName("jli"), prefix: "" }])).to.equal(undefined);
  });
});
