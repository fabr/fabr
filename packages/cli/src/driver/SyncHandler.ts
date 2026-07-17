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

import { Computable, Diagnostic, ExecutionContext, PublishableFileSet, toError } from "@fabr-build/core";

const DIAG_PUBLISHED = Diagnostic.Info<{ destination: string }>("Published {destination}");
const DIAG_ALREADY_SYNCED = Diagnostic.Info<{ destination: string }>("{destination} is already synced");
const DIAG_PUBLISH_FAILED = Diagnostic.Error<{ destination: string; reason: string }>("Failed to publish {destination}: {reason}");
const DIAG_PUBLISH_SKIPPED = Diagnostic.Warn<{ destination: string; blockedBy: string }>(
  "Skipped {destination}: its release dependency {blockedBy} was not published"
);

/**
 * Publish a release's members — a plain walk, in the given order: the sync rule
 * already yields its carriers deps-first (BuildSync's publishOrder), so each
 * member uploads (`destination.source.publish`, the destination's own
 * mechanics) only after every member it depends on. Best-effort: a member whose
 * upload fails does not abort the rest, but its dependants are skipped rather
 * than published dangling (matched via the carriers' `provides`/`dependsOn`
 * tokens), and any member that didn't land makes the overall sync a failure so
 * the process exits non-zero. Uploads run sequentially — a registry is happier
 * not being hammered with concurrent writes.
 */
export function publishSync(execution: ExecutionContext, members: ReadonlyArray<PublishableFileSet>): Computable<void> {
  const unavailable = new Set<string>(); /* tokens provided by members that failed or were skipped */
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
      return member.destination.source.publish(member).then(
        status => {
          execution.log.log(status === "published" ? DIAG_PUBLISHED : DIAG_ALREADY_SYNCED, {
            destination: member.destination.toString(),
          });
        },
        err => {
          markUnavailable(member);
          execution.log.log(DIAG_PUBLISH_FAILED, { destination: member.destination.toString(), reason: toError(err).message });
        }
      );
    });
  }
  return chain.then(() => {
    if (failures > 0) {
      throw new Error(`sync failed: ${failures} of ${members.length} member(s) not published`);
    }
  });
}
