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

import {
  batchName,
  Computable,
  Diagnostic,
  ExecutionContext,
  FabrError,
  PublishableFileSet,
  publishBatches,
  publishBatchTo,
  toError,
} from "@fabr-build/core";

const DIAG_ALREADY_SYNCED = Diagnostic.Info<{ destination: string }>("{destination} is already synced");
const DIAG_STAGED = Diagnostic.Info<{ destination: string }>("{destination} is staged");
const DIAG_PUBLISH_FAILED = Diagnostic.Error<{ destination: string; reason: string }>("Failed to publish {destination}: {reason}");
const DIAG_PUBLISH_SKIPPED = Diagnostic.Warn<{ destination: string; blockedBy: string }>(
  "Skipped {destination}: its release dependency {blockedBy} was not published"
);

/**
 * Publish a release's members in the batches {@link publishBatches} groups
 * them into, one batch at a time, each through its destination as a task of
 * its own ({@link publishBatchTo}).
 *
 * A failed upload is logged and the rest go on; a failed batch fails every
 * member it held. A batch with a member whose `dependsOn` names a token
 * `provides`d by a member that failed or was skipped is skipped, with a
 * warning. Settles once every batch has been tried, rejecting with a
 * FabrError counting the members not published where any was not.
 */
export function publishSync(execution: ExecutionContext, members: ReadonlyArray<PublishableFileSet>): Computable<void> {
  const unavailable = new Set<string>(); /* The tokens provided by members that failed or were skipped. */
  let failures = 0;
  const markUnavailable = (batch: readonly PublishableFileSet[]): void => {
    failures += batch.length;
    batch.forEach(member => member.provides !== undefined && unavailable.add(member.provides));
  };
  let chain: Computable<void> = Computable.resolve(undefined);
  for (const batch of publishBatches(members)) {
    chain = chain.then(() => {
      const provided = new Set(batch.flatMap(member => (member.provides === undefined ? [] : [member.provides])));
      const blocked = batch.flatMap(member => member.dependsOn).find(dep => !provided.has(dep) && unavailable.has(dep));
      const destination = batchName(batch);
      if (blocked !== undefined) {
        markUnavailable(batch);
        execution.log.log(DIAG_PUBLISH_SKIPPED, { destination, blockedBy: blocked });
        return;
      }
      return execution
        .runTask({ kind: "publish", destination }, report => publishBatchTo(batch, report))
        .then(
          statuses =>
            statuses.forEach((status, index) => {
              if (status === "already-synced") {
                execution.log.log(DIAG_ALREADY_SYNCED, { destination: batch[index].destination.toString() });
              } else if (status === "staged") {
                execution.log.log(DIAG_STAGED, { destination: batch[index].destination.toString() });
              }
            }),
          err => {
            markUnavailable(batch);
            execution.log.log(DIAG_PUBLISH_FAILED, { destination, reason: toError(err).message });
          }
        );
    });
  }
  return chain.then(() => {
    if (failures > 0) {
      throw new FabrError(`sync failed: ${failures} of ${members.length} member(s) not published`);
    }
  });
}
