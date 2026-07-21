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

/* An error (not a warning) in the build files must STOP the run after loading:
 * the model is unsound, so no operation proceeds against it. The crisp check is
 * that an error in one target fails an *otherwise-successful* build of an
 * unrelated valid target — reporting-and-continuing would exit 0 here. */
describe("e2e: build files with errors stop the run", () => {
  it("fails an otherwise-successful build when an unrelated target is invalid", () => {
    const result = runFabr(
      {
        "PROJECT.fabr":
          "script good_prog { entry = src:gen.sh; }\n" +
          "generate good { run = good_prog; output = out:**; }\n" +
          /* Unrelated, unbuilt target with an unrecognized property. */
          "script bad_prog { entry = src:gen.sh; nonsense = oops; }\n",
        "src/gen.sh": 'mkdir -p out\nprintf "ran\\n" > out/msg.txt\n',
      },
      ["cat", "good:msg.txt"]
    );
    expect(result.status).to.not.equal(0);
    /* The error is reported once, positioned at the offending property... */
    expect(result.stderr).to.contain("Unrecognized property 'nonsense'");
    expect(result.stderr).to.contain("Build failed");
    /* ...and nothing was built: no output reached stdout. */
    expect(result.stdout).to.equal("");
  });

  it("reports a syntax error and stops (parse recovers to report, then fails)", () => {
    const result = runFabr(
      {
        "PROJECT.fabr": "good = value;\nthis is not valid syntax @@@\n",
      },
      ["build", "good"]
    );
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.contain("Build failed");
  });
});
