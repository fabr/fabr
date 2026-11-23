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
 */

import { FocusHandling, focusForbidden } from "./RunTests";

/** The test functions whose `.only` focuses, and the jest aliases of their focused forms. */
const FOCUSABLE = ["it", "test", "describe", "context", "specify"];
const FOCUSED_ALIASES = new Map([
  ["fit", "it"],
  ["fdescribe", "describe"],
]);

/**
 * Rebind the focused forms of a framework's test functions on `globals`
 * (`it.only`, `test.only`, `describe.only`, and jest's `fit` and `fdescribe`)
 * as `handling` says: left as they are under `allow`, made the plain function
 * under `ignore`, and made a function that throws {@link focusForbidden}'s
 * error for `file` under `forbid`. A form missing from `globals` is left out.
 */
export function handleFocus(globals: Record<string, unknown>, handling: FocusHandling, file: string): void {
  if (handling === "allow") {
    return;
  }
  const refuse = (): never => {
    throw new Error(focusForbidden(file));
  };
  /* `.each` too, which a focused form carries (`it.only.each`). */
  const refused = Object.assign(refuse, { each: refuse });
  for (const name of FOCUSABLE) {
    const fn = globals[name] as (Record<string, unknown> & ((...args: unknown[]) => unknown)) | undefined;
    if (typeof fn === "function" && "only" in fn) {
      fn.only = handling === "ignore" ? fn : refused;
    }
  }
  for (const [alias, plain] of FOCUSED_ALIASES) {
    if (alias in globals) {
      globals[alias] = handling === "ignore" ? globals[plain] : refused;
    }
  }
}
