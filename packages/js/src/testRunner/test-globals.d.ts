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

/*
 * Ambient types for the globals the runner preloads into every test process
 * (see globals.ts). The test rules mount this file as a synthetic @types
 * package in the test compile, so test files can use describe/it without
 * importing them. Deliberately NOT part of the devchain tsconfig (it would
 * collide with @types/jest's globals there).
 */

declare const describe: typeof import("node:test").describe;
declare const it: typeof import("node:test").it;
declare const test: typeof import("node:test").test;
declare const before: typeof import("node:test").before;
declare const after: typeof import("node:test").after;
declare const beforeEach: typeof import("node:test").beforeEach;
declare const afterEach: typeof import("node:test").afterEach;
declare const beforeAll: typeof import("node:test").before;
declare const afterAll: typeof import("node:test").after;
