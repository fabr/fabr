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
import { Computable } from "../core/Computable";
import { Semaphore } from "./Semaphore";

/** A unit of work whose completion the test drives, recording when it started. */
class Job {
  public started = false;
  public done = false;
  private settle?: (value: string) => void;
  private fail?: (err: Error) => void;

  public readonly run = (): Computable<string> => {
    this.started = true;
    return Computable.from<string>((resolve, reject) => {
      this.settle = resolve;
      this.fail = reject;
    });
  };

  public finish(value = "done"): void {
    this.done = true;
    this.settle!(value);
  }

  public reject(err: Error): void {
    this.done = true;
    this.fail!(err);
  }
}

function jobs(count: number): Job[] {
  return Array.from({ length: count }, () => new Job());
}

describe("Semaphore", () => {
  it("starts work up to capacity and queues the rest", () => {
    const semaphore = new Semaphore(2);
    const [a, b, c] = jobs(3);
    [a, b, c].forEach(job => semaphore.run(job.run));

    expect([a.started, b.started, c.started]).to.deep.equal([true, true, false]);
  });

  it("starts a queued job when a slot is released", () => {
    const semaphore = new Semaphore(2);
    const [a, b, c] = jobs(3);
    [a, b, c].forEach(job => semaphore.run(job.run));

    a.finish();
    expect(c.started).to.equal(true);
    expect(b.started).to.equal(true);
  });

  it("releases the slot of failed work too", () => {
    const semaphore = new Semaphore(1);
    const [a, b] = jobs(2);
    let error: Error | undefined;
    semaphore.run(a.run).catch(err => {
      error = err;
      return "";
    });
    semaphore.run(b.run);

    expect(b.started).to.equal(false);
    a.reject(new Error("boom"));
    expect(error?.message).to.equal("boom");
    expect(b.started).to.equal(true);
  });

  it("releases the slot when work throws synchronously", () => {
    const semaphore = new Semaphore(1);
    const queued = new Job();
    let error: Error | undefined;
    semaphore
      .run((): Computable<string> => {
        throw new Error("no work dir");
      })
      .catch(err => {
        error = err;
        return "";
      });
    semaphore.run(queued.run);

    expect(error?.message).to.equal("no work dir");
    expect(queued.started).to.equal(true);
  });

  it("resolves with the value the work produced", () => {
    const semaphore = new Semaphore(1);
    const job = new Job();
    let result: string | undefined;
    semaphore.run(job.run).then(value => (result = value));

    job.finish("output");
    expect(result).to.equal("output");
  });

  it("runs queued work in demand order", () => {
    const semaphore = new Semaphore(1);
    const [a, b, c] = jobs(3);
    [a, b, c].forEach(job => semaphore.run(job.run));

    a.finish();
    expect([b.started, c.started]).to.deep.equal([true, false]);
    b.finish();
    expect(c.started).to.equal(true);
  });

  it("never runs more than capacity at once across a long queue", () => {
    const semaphore = new Semaphore(3);
    const all = jobs(10);
    all.forEach(job => semaphore.run(job.run));

    const running = (): number => all.filter(job => job.started && !job.done).length;
    let peak = running();
    for (const job of all) {
      job.finish();
      peak = Math.max(peak, running());
    }
    expect(peak).to.equal(3);
  });
});
