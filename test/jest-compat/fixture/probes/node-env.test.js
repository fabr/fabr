/**
 * @jest-environment node
 */
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

const { probe } = require("./lib/probe");
it("lists the node environment's globals", () => {
  const names = new Set();
  for (let o = globalThis; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) for (const k of Object.getOwnPropertyNames(o)) names.add(k);
  const types = {};
  for (const k of [...names].sort()) { try { types[k] = typeof globalThis[k]; } catch (e) { types[k] = "<throws>"; } }
  probe("node-env.globals", types);
  probe("node-env.process", { NODE_ENV: process.env.NODE_ENV, isRealProcess: process === require("process") });
});
