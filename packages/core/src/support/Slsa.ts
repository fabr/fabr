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

import { Computable } from "../core/Computable";

/** The DSSE payload type of an in-toto statement. */
export const INTOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";

/** What a provenance statement is about: an artifact named by `name` (a purl,
 *  for a package) with its digests by algorithm. */
export interface IStatementSubject {
  readonly name: string;
  readonly digest: Readonly<Record<string, string>>;
}

/**
 * The build a CI job is, as a SLSA provenance predicate states it, and the
 * source it built.
 */
export interface ISlsaBuild {
  /** The in-toto statement's `_type`. */
  readonly statementType: string;
  readonly predicateType: string;
  /** The SLSA provenance predicate of the job's build. */
  readonly predicate: Readonly<Record<string, unknown>>;
  /** The URL of the source repository the job built. */
  readonly sourceRepository: string;
  /** @return true if the job's identity says its source repository is public, otherwise false. */
  isPublicSource(): Computable<boolean>;
}

/** Make the in-toto statement that `build` built `subject`. */
export function provenanceStatement(subject: IStatementSubject, build: ISlsaBuild): Record<string, unknown> {
  return { _type: build.statementType, subject: [subject], predicateType: build.predicateType, predicate: build.predicate };
}
