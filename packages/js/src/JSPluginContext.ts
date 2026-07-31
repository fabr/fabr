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

import { Computable, ExecutionContext, PluginKey } from "@fabr-build/core";
import { NPMAuth } from "./NPMAuth";

/**
 * The js plugin's per-run state, held on the ExecutionContext under {@link JS_PLUGIN_KEY}
 * and shared across every NPMRepository instance of the run (which are interned
 * per BuildContext, so `@npm` under `{build}` and `{run}` are distinct instances
 * that must not each re-parse `.npmrc`). Currently just the run's {@link NPMAuth}
 * (whose one-instance-per-run sharing is what makes its second-factor sessions
 * run-wide); a home for future run-wide js state.
 */
export class JSPluginContext {
  private npmAuthMemo?: Computable<NPMAuth>;

  constructor(private readonly execution: ExecutionContext) {}

  /** The run's registry-auth authority, loaded (`.npmrc` parse) once per run. */
  public npmAuth(): Computable<NPMAuth> {
    if (!this.npmAuthMemo) {
      this.npmAuthMemo = NPMAuth.load(this.execution);
    }
    return this.npmAuthMemo;
  }
}

/** The js plugin's handle for its {@link JSPluginContext} on the ExecutionContext. */
export const JS_PLUGIN_KEY = new PluginKey<JSPluginContext>("@fabr-build/js");

/** The run's shared js plugin context, created on first access. */
export function jsPluginContext(execution: ExecutionContext): JSPluginContext {
  return execution.getOrCreatePluginContext(JS_PLUGIN_KEY, () => new JSPluginContext(execution));
}
