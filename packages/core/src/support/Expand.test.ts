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

import * as fsNode from "fs";
import * as os from "os";
import * as pathNode from "path";
import zlib from "zlib";
import { expect } from "chai";
import { Computable } from "../core/Computable";
import { FileSet, IFile } from "../core/FileSet";
import { FSFileSource } from "../core/FSFileSource";
import { MemoryFile } from "../core/MemoryFS";
import { Name, NameBuilder } from "../core/Name";
import { packToTarball } from "./Pack";
import { descentPrefixes, expandOnce, findWithDescent } from "./Expand";

/** A zip-magic file: an archive by mime, but not one fabr can expand. */
const zipFile = (): MemoryFile => new MemoryFile(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(300)]));

/** A `.tgz` shaped like a git archive: everything under one root directory. */
function archive(): Computable<MemoryFile> {
  const files = new FileSet(
    new Map([
      ["amperize-3f2dc4e/package.json", MemoryFile.from('{"name":"amperize"}')],
      ["amperize-3f2dc4e/lib/x.js", MemoryFile.from("module.exports = 1;")],
    ])
  );
  return packToTarball(files).then((tar: Buffer) => new MemoryFile(zlib.gzipSync(tar)));
}

const names = (files: FileSet): string[] => [...files].map(([name]) => name).sort();

describe("Expand", () => {
  it("reads an archive as a directory of its contents", async () => {
    const expanded = await expandOnce(await archive());
    expect(names(expanded)).to.deep.equal(["amperize-3f2dc4e/lib/x.js", "amperize-3f2dc4e/package.json"]);
  });

  it("preserves content through the round trip", async () => {
    const expanded = await expandOnce(await archive());
    const manifest = await expanded.get("amperize-3f2dc4e/package.json");
    expect(await manifest?.readString()).to.equal('{"name":"amperize"}');
  });

  it("yields an empty set for a file that is not an archive", async () => {
    expect(names(await expandOnce(MemoryFile.from("just some text")))).to.deep.equal([]);
  });

  describe("descentPrefixes", () => {
    const prefixes = (name: Name): string[] => descentPrefixes(name).map(prefix => prefix.toString());

    it("yields one slash-form prefix per separator with selector remaining", () => {
      /* `a.tgz:*:**` — one candidate before the `*` and one before the `**`,
       * every `:` a `/` so a probe's matches keep their paths. */
      const name = new NameBuilder()
        .appendLiteralString("a.tgz:")
        .appendGlobMetachars("*")
        .appendLiteralString(":")
        .appendGlobMetachars("**")
        .name();
      expect(prefixes(name)).to.deep.equal(["a.tgz", "a.tgz/*"]);
    });

    it("treats slash and colon separators alike (the boundary is not syntactic)", () => {
      expect(prefixes(Name.fromLiteral("x.tgz/foo"))).to.deep.equal(["x.tgz"]);
      expect(prefixes(Name.fromLiteral("x.tgz:foo"))).to.deep.equal(["x.tgz"]);
      expect(prefixes(Name.fromLiteral("dir:x.tgz/foo"))).to.deep.equal(["dir", "dir/x.tgz"]);
    });

    it("yields nothing for a separator-free selector", () => {
      expect(prefixes(new NameBuilder().appendGlobMetachars("**").name())).to.deep.equal([]);
      expect(prefixes(new NameBuilder().appendGlobMetachars("*").appendLiteralString(".ts").name())).to.deep.equal([]);
      expect(prefixes(Name.fromLiteral("a.tgz"))).to.deep.equal([]);
    });

    it("never lets ** participate in a crossing", () => {
      /* A globstar followed by `/x`: the only prefix ends in the globstar —
       * excluded, so a recursive glob can never name an archive to descend into. */
      const globstar = new NameBuilder().appendGlobMetachars("**").appendLiteralString("/x").name();
      expect(prefixes(globstar)).to.deep.equal([]);
      // `dir/**/*.ts`: `dir` is a candidate, `dir/**` is not.
      const swept = new NameBuilder()
        .appendLiteralString("dir/")
        .appendGlobMetachars("**")
        .appendLiteralString("/")
        .appendGlobMetachars("*")
        .appendLiteralString(".ts")
        .name();
      expect(prefixes(swept)).to.deep.equal(["dir"]);
    });

    it("allows a single-star crossing segment", () => {
      const name = new NameBuilder().appendGlobMetachars("*").appendLiteralString(".tgz:x").name();
      expect(prefixes(name)).to.deep.equal(["*.tgz"]);
    });

    it("stops at an unsubstituted variable", () => {
      const name = new NameBuilder().appendSubstVar("A").appendLiteralString("/x").name();
      expect(prefixes(name)).to.deep.equal([]);
    });

    it("carries no facets onto the probes", () => {
      const name = Name.fromLiteral("x.tgz/foo")
        .withConstraints([["K", Name.fromLiteral("v")]])
        .withRenameTo(Name.fromLiteral("bar"));
      const [probe] = descentPrefixes(name);
      expect(probe.toString()).to.equal("x.tgz");
      expect(probe.hasConstraints()).to.equal(false);
      expect(probe.getRenameTo()).to.equal(undefined);
    });
  });

  describe("findWithDescent", () => {
    /** Parse a written selector into a Name: unquoted glob metachars live. */
    const selector = (written: string): Name => {
      const builder = new NameBuilder();
      for (const char of written) {
        if (char === "*") {
          builder.appendGlobMetachars(char);
        } else {
          builder.appendLiteralString(char);
        }
      }
      return builder.name();
    };
    const source = async (): Promise<FileSet> => new FileSet(new Map([["a.tgz", await archive()]]));

    it("descends into an archive across a colon boundary, naming by the written-name rule", async () => {
      /* The flagship: `a.tgz:*:**` — the `*` crosses into the archive and, being
       * part of the alias, eats git's redundant root directory. */
      const found = await findWithDescent(await source(), selector("a.tgz:*:**"), "", expandOnce);
      expect(names(found)).to.deep.equal(["lib/x.js", "package.json"]);
    });

    it("names relative to the archive under a bare colon projection (never the archive itself)", async () => {
      const found = await findWithDescent(await source(), selector("a.tgz:**"), "", expandOnce);
      expect(names(found)).to.deep.equal(["amperize-3f2dc4e/lib/x.js", "amperize-3f2dc4e/package.json"]);
    });

    it("crosses a slash boundary too, retaining written names", async () => {
      const found = await findWithDescent(await source(), selector("a.tgz/*/package.json"), "", expandOnce);
      expect(names(found)).to.deep.equal(["a.tgz/amperize-3f2dc4e/package.json"]);
    });

    it("keeps a bare reference to the archive as the file", async () => {
      const found = await findWithDescent(await source(), selector("a.tgz"), "", expandOnce);
      expect(names(found)).to.deep.equal(["a.tgz"]);
    });

    it("never descends under a recursive glob", async () => {
      const found = await findWithDescent(await source(), selector("**"), "", expandOnce);
      expect(names(found)).to.deep.equal(["a.tgz"]);
    });

    it("descends under a recursive glob only via an explicit intermediate step", async () => {
      /* `**` matches paths within one tree and never opens an archive, so a
       * sweep treats archives as opaque files; writing the step you mean —
       * a component that lands on the archive — opens it, and the next `**`
       * sweeps the tree inside. */
      const set = new FileSet(
        new Map([
          ["deep/nested/a.tgz", await archive()],
          ["deep/plain.ts", MemoryFile.from("plain")],
        ])
      );
      const swept = await findWithDescent(set, selector("**/*.ts"), "", expandOnce);
      expect(names(swept)).to.deep.equal(["deep/plain.ts"]);
      const stepped = await findWithDescent(set, selector("**/*.tgz/**/*.js"), "", expandOnce);
      expect(names(stepped)).to.deep.equal(["deep/nested/a.tgz/amperize-3f2dc4e/lib/x.js"]);
    });

    it("selects the boundary by glob and unions descents with ordinary matches", async () => {
      const set = new FileSet(
        new Map([
          ["things/a.tgz", await archive()],
          ["things/plain.txt", MemoryFile.from("not an archive")],
        ])
      );
      const found = await findWithDescent(set, selector("things/*/amperize-3f2dc4e/lib/x.js"), "", expandOnce);
      expect(names(found)).to.deep.equal(["things/a.tgz/amperize-3f2dc4e/lib/x.js"]);
    });

    it("descends a nested archive recursively", async () => {
      const outer = await packToTarball(new FileSet(new Map([["inner.tgz", await archive()]]))).then(
        (tar: Buffer) => new MemoryFile(zlib.gzipSync(tar))
      );
      const set = new FileSet(new Map([["outer.tgz", outer]]));
      const found = await findWithDescent(set, selector("outer.tgz:inner.tgz:*:lib/x.js"), "", expandOnce);
      expect(names(found)).to.deep.equal(["lib/x.js"]);
    });

    it("contributes nothing for a probed non-archive", async () => {
      const set = new FileSet(new Map([["notes.txt", MemoryFile.from("plain text")]]));
      const found = await findWithDescent(set, selector("notes.txt:**"), "", expandOnce);
      expect(found.isEmpty()).to.equal(true);
    });

    it("decides archive-ness by content, not name", async () => {
      /* A .tgz-named text file never opens (its sniffed mime says so) — and a
       * real archive opens whatever it is called. */
      const set = new FileSet(new Map([["fake.tgz", MemoryFile.from("not really")], ["oddly.named", await archive()]]));
      expect((await findWithDescent(set, selector("fake.tgz:**"), "", expandOnce)).isEmpty()).to.equal(true);
      expect(names(await findWithDescent(set, selector("oddly.named:*:**"), "", expandOnce))).to.deep.equal(["lib/x.js", "package.json"]);
    });

    it("skips an unexpandable archive a glob probe merely swept", async () => {
      /* A glob boundary is speculative: a zip (archive mime, but fabr can't
       * expand it) sitting where the sweep lands must contribute nothing, not
       * fail the projection that never named it. */
      const set = new FileSet(
        new Map([
          ["things/a.zip", zipFile()],
          ["things/data.tgz", await archive()],
        ])
      );
      const found = await findWithDescent(set, selector("things/*:**"), "", expandOnce);
      expect(names(found)).to.deep.equal(["amperize-3f2dc4e/lib/x.js", "amperize-3f2dc4e/package.json"]);
    });

    it("reports an unexpandable archive the user explicitly named", async () => {
      const set = new FileSet(new Map([["a.zip", zipFile()]]));
      let failure: Error | undefined;
      try {
        await findWithDescent(set, selector("a.zip:**"), "", expandOnce);
      } catch (err) {
        failure = err as Error;
      }
      expect(String(failure)).to.contain("ZIP archives are not supported");
    });

    it("descends in an absolutely-rooted namespace once the pattern is rebased", async () => {
      /* The shape of a plugin's contributed lib file: an absolute build-file
       * dir over the root FSFileSource. The resolver rebases the pattern into
       * the source's root-relative namespace before walking (the probes and
       * mounts must live in the same space as the matching). */
      const dir = fsNode.mkdtempSync(pathNode.join(os.tmpdir(), "fabr-expand-abs-"));
      try {
        fsNode.writeFileSync(pathNode.join(dir, "a.tgz"), await (await archive()).getBuffer());
        const source = new FSFileSource("/");
        const pattern = new NameBuilder()
          .appendLiteralString(`${dir}:a.tgz:`)
          .appendGlobMetachars("**")
          .name()
          .rebase("/");
        const found = await findWithDescent(source, pattern, "", expandOnce);
        expect(names(found)).to.deep.equal(["amperize-3f2dc4e/lib/x.js", "amperize-3f2dc4e/package.json"]);
      } finally {
        fsNode.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("reads archive contents only through the supplied expand function", async () => {
      /* The boundary action is the caller's — production binds the build
       * cache's expansion (BuildContext.expandArchive); here we observe it. */
      const seen: string[] = [];
      const expand = (file: IFile): Computable<FileSet> => {
        seen.push(file.hash);
        return expandOnce(file);
      };
      const file = await archive();
      const set = new FileSet(new Map([["a.tgz", file]]));
      await findWithDescent(set, selector("a.tgz:**"), "", expand);
      expect(seen).to.deep.equal([file.hash]);
    });
  });
});
