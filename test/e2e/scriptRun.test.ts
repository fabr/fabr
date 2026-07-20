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

import { expect } from "chai";
import { runFabr } from "./harness";

/* The core `script` rule defines a runnable plain shell script (no plugin, no
 * toolchain); `fabr run` launches it and the generic `run` target collects its
 * output. These cases exercise that pair through the real CLI. */
describe("e2e: script (shell runnable) + run", () => {
  it("runs a shell script and collects its output", () => {
    const result = runFabr(
      {
        "PROJECT.fabr":
          "script gen_prog { entry = src:gen.sh; }\n" +
          "run gen { tool = gen_prog; output = out:**; }\n",
        "src/gen.sh": 'mkdir -p out\nprintf "e2e ran\\n" > out/msg.txt\n',
      },
      ["cat", "gen:msg.txt"]
    );
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("e2e ran\n");
  });

  it("passes fixed and caller args through to the script", () => {
    const result = runFabr(
      {
        "PROJECT.fabr":
          "script hello { entry = src:hello.sh; args = Ada; }\n",
        "src/hello.sh": 'printf "hi %s %s" "$1" "$2"\n',
      },
      ["run", "hello", "Lovelace"]
    );
    expect(result.status).to.equal(0);
    expect(result.stdout).to.equal("hi Ada Lovelace");
  });

  it("propagates the script's exit code", () => {
    const result = runFabr(
      {
        "PROJECT.fabr": "script boom { entry = src:boom.sh; }\n",
        "src/boom.sh": "exit 7\n",
      },
      ["run", "boom"]
    );
    expect(result.status).to.equal(7);
  });

  it("fails with a clear error when entry names no file", () => {
    const result = runFabr(
      {
        "PROJECT.fabr":
          "script gen_prog { deps = src:gen.sh; entry = src:missing.sh; }\n" +
          "run gen { tool = gen_prog; output = out:**; }\n",
        "src/gen.sh": "# present, but not the entry\n",
      },
      ["build", "gen"]
    );
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.contain("Unable to resolve 'src:missing.sh'");
  });
});
