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

/**
 * Let a process read files through PnP virtual locations: `fs`'s reading
 * functions, given a path at a virtual location, read the physical file
 * beneath it, so a package wired several ways reads its own files through
 * `__dirname` whichever wiring loaded it. `realpath` keeps a virtual path
 * virtual, resolving only the part before the virtual segment, so a module
 * that resolves its own path stays the wiring it is. Nothing writes into the
 * tree pool, so writing functions are left alone. Native code opening a file
 * itself, and another process given a virtual path, find nothing there.
 */

/* The module object itself, which the patch changes: `import * as` would be a copy. */
import fs = require("node:fs");
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";
import { isVirtual, realpathKeepingVirtual, resolveVirtual } from "./VirtualPath";

/** The functions that read through a path given as their first argument. */
const READERS = ["readFile", "stat", "lstat", "access", "open", "readdir", "opendir", "readlink", "exists"] as const;
const SYNC_READERS = [...READERS.map(name => `${name}Sync`), "createReadStream"];
const PROMISE_READERS = READERS.filter(name => name !== "exists");

type AnyFunction = (...args: unknown[]) => unknown;

/** @return the path `file` reads from: the physical file beneath a virtual
 * location, else `file` as given. */
function physical(file: unknown): unknown {
  if (typeof file === "string") {
    return isVirtual(file) ? resolveVirtual(file) : file;
  }
  if (file instanceof URL && file.protocol === "file:") {
    const at = fileURLToPath(file);
    return isVirtual(at) ? resolveVirtual(at) : file;
  }
  return file;
}

/** @return `file` as a path string where it is one or a file URL, else undefined. */
function pathOf(file: unknown): string | undefined {
  if (typeof file === "string") {
    return file;
  }
  return file instanceof URL && file.protocol === "file:" ? fileURLToPath(file) : undefined;
}

/** Replace `target[name]` with a function calling it with its first argument read through {@link physical}. */
function mapFirst(target: Record<string, unknown>, name: string): void {
  const original = target[name] as AnyFunction | undefined;
  if (typeof original !== "function") {
    return;
  }
  const mapped = function (this: unknown, file: unknown, ...rest: unknown[]): unknown {
    return original.call(this, physical(file), ...rest);
  };
  Object.defineProperties(mapped, Object.getOwnPropertyDescriptors(original));
  target[name] = mapped;
}

/**
 * Install the patch: every later read of a virtual path in this process,
 * through `fs`, `fs.promises` or `fs/promises`, reads the file beneath it.
 * Call it once per process (the runtime does, with the first table it
 * installs): a second call patches the patched functions again.
 */
export function installVirtualFs(): void {
  const callbacks = fs as unknown as Record<string, unknown>;
  const promises = fs.promises as unknown as Record<string, unknown>;
  for (const name of [...READERS, ...SYNC_READERS]) {
    mapFirst(callbacks, name);
  }
  for (const name of PROMISE_READERS) {
    mapFirst(promises, name);
  }
  patchRealpath();
  /* Named imports of `fs` in ES modules read the module's own copies. */
  nodeModule.syncBuiltinESMExports();
}

/**
 * Make every form of `realpath` keep a virtual path virtual: the file beneath
 * it is resolved first, so a missing one fails as it would, then the part
 * before the virtual segment is resolved and the rest kept as written.
 */
function patchRealpath(): void {
  const sync = fs.realpathSync;
  const syncNative = fs.realpathSync.native;
  const keepingSync =
    (real: (file: string) => string) =>
    (file: unknown, options?: unknown): unknown => {
      const at = pathOf(file);
      if (at === undefined || !isVirtual(at)) {
        return (real as AnyFunction)(file, options);
      }
      (real as AnyFunction)(resolveVirtual(at));
      return realpathKeepingVirtual(at, base => (real as AnyFunction)(base) as string);
    };
  const patchedSync = keepingSync(sync) as typeof fs.realpathSync;
  patchedSync.native = keepingSync(syncNative) as typeof fs.realpathSync.native;
  (fs as unknown as Record<string, unknown>).realpathSync = patchedSync;

  const callback = fs.realpath;
  const callbackNative = fs.realpath.native;
  const keepingCallback =
    (real: AnyFunction, realSync: (file: string) => string) =>
    (file: unknown, options: unknown, done?: unknown): unknown => {
      const at = pathOf(file);
      const reply = (typeof options === "function" ? options : done) as (err: unknown, resolved?: string) => void;
      if (at === undefined || !isVirtual(at) || typeof reply !== "function") {
        return real(file, options, done);
      }
      return real(resolveVirtual(at), (err: unknown) => {
        if (err) {
          reply(err);
          return;
        }
        try {
          reply(null, realpathKeepingVirtual(at, realSync));
        } catch (thrown: unknown) {
          reply(thrown);
        }
      });
    };
  const patchedCallback = keepingCallback(callback as AnyFunction, sync) as typeof fs.realpath;
  patchedCallback.native = keepingCallback(callbackNative as AnyFunction, syncNative) as typeof fs.realpath.native;
  (fs as unknown as Record<string, unknown>).realpath = patchedCallback;

  const promised = fs.promises.realpath;
  fs.promises.realpath = (async (file: unknown, options?: unknown): Promise<unknown> => {
    const at = pathOf(file);
    if (at === undefined || !isVirtual(at)) {
      return (promised as AnyFunction)(file, options);
    }
    await promised(resolveVirtual(at));
    return realpathKeepingVirtual(at, sync);
  }) as typeof fs.promises.realpath;
}
