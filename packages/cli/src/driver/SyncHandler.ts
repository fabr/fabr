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

import { Computable, Diagnostic, ExecutionContext, FabrError, PublishableFileSet, toError } from "@fabr-build/core";

const DIAG_ALREADY_SYNCED = Diagnostic.Info<{ destination: string }>("{destination} is already synced");
const DIAG_PUBLISH_FAILED = Diagnostic.Error<{ destination: string; reason: string }>("Failed to publish {destination}: {reason}");
const DIAG_PUBLISH_SKIPPED = Diagnostic.Warn<{ destination: string; blockedBy: string }>(
  "Skipped {destination}: its release dependency {blockedBy} was not published"
);

/**
 * Publish a release's members one at a time, in the order given, each through
 * its destination (`destination.source.publish`) as a task of its own. The
 * order must put each member after the members it depends on, as the sync
 * rule's carriers come.
 *
 * A failed upload is logged and the rest go on. A member whose `dependsOn`
 * names a token `provides`d by a member that failed or was skipped is skipped,
 * with a warning. Settles once every member has been tried, rejecting with a
 * FabrError counting the members not published where any was not.
 */
export function publishSync(execution: ExecutionContext, members: ReadonlyArray<PublishableFileSet>): Computable<void> {
  const unavailable = new Set<string>(); /* The tokens provided by members that failed or were skipped. */
  let failures = 0;
  const markUnavailable = (member: PublishableFileSet): void => {
    failures++;
    if (member.provides !== undefined) {
      unavailable.add(member.provides);
    }
  };
  let chain: Computable<void> = Computable.resolve(undefined);
  for (const member of members) {
    chain = chain.then(() => {
      const blocked = member.dependsOn.find(dep => unavailable.has(dep));
      if (blocked !== undefined) {
        markUnavailable(member);
        execution.log.log(DIAG_PUBLISH_SKIPPED, { destination: member.destination.toString(), blockedBy: blocked });
        return;
      }
      const destination = member.destination.toString();
      return execution
        .runTask({ kind: "publish", destination }, report => member.destination.source.publish(member, report))
        .then(
          status => {
            if (status === "already-synced") {
              execution.log.log(DIAG_ALREADY_SYNCED, { destination });
            }
          },
          err => {
            markUnavailable(member);
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
