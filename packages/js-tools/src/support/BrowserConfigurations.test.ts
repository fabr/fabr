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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configurationOf, isConfigurationOption } from "./BrowserConfigurations";

describe("configurationOf", () => {
  it("reads the configuration with its settings", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabr-configurations-")));
    fs.writeFileSync(path.join(dir, "chrome"), "");
    expect(
      configurationOf([
        "--browser=desktop=chromium",
        `--browser-executable=desktop=${path.join(dir, "chrome")}`,
        "--browser-viewport=desktop=390x844",
        "--browser-user-agent=desktop=Agent=1",
        "--browser-device=desktop=iPhone 15",
        "a.spec.js",
      ])
    ).to.deep.equal({
      name: "desktop",
      browser: "chromium",
      executable: path.join(dir, "chrome"),
      viewport: { width: 390, height: 844 },
      userAgent: "Agent=1",
      device: "iPhone 15",
    });
    expect(configurationOf(["a.spec.js"])).to.equal(undefined);
    fs.rmSync(dir, { recursive: true });
  });

  it("refuses a second configuration, and a setting of one not declared", () => {
    expect(() => configurationOf(["--browser=a=chromium", "--browser=b=webkit"])).to.throw(/declares a second browser configuration/);
    expect(() => configurationOf(["--browser-viewport=desktop=1x1"])).to.throw(
      /names 'desktop', which no '--browser=' option declares/
    );
  });

  it("tells its options from the runner contract's", () => {
    expect(isConfigurationOption("--browser-viewport=a=1x1")).to.equal(true);
    expect(isConfigurationOption("--browser=a=chromium")).to.equal(true);
    expect(isConfigurationOption("--browsers=x")).to.equal(false);
  });
});
