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

/* Write one observation, past jest's console buffering. */
exports.probe = (id, value) => {
  let text;
  try { text = JSON.stringify(value === undefined ? "<undefined>" : value); } catch (e) { text = JSON.stringify("<unserializable: " + e.message + ">"); }
  const line = "PROBE " + id + " " + text + "\n";
  /* Real jest's side collects them from a file: it may run a file in a worker whose stdout it does not pass on. */
  if (process.env.PROBE_FILE) require("fs").appendFileSync(process.env.PROBE_FILE, line);
  else process.stdout.write(line);
};
/* Run `fn`, observing its value or the error it throws. */
exports.attempt = fn => { try { return { value: fn() }; } catch (e) { return { threw: (e && e.constructor && e.constructor.name) + ": " + (e && e.message) }; } };
