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

/**
 * The judgments a migration could not make, and what it did in their place,
 * as lines grouped under headings.
 */
export class Report {
  private readonly sections = new Map<string, Set<string>>();

  /** Add `line` under `heading`; a line already there is not added again. */
  public add(heading: string, line: string): void {
    const lines = this.sections.get(heading) ?? new Set();
    this.sections.set(heading, lines.add(line));
  }

  /** Add every line of `other`, under its heading. */
  public addAll(other: Report): void {
    other.sections.forEach((lines, heading) => lines.forEach(line => this.add(heading, line)));
  }

  /** @return true if nothing has been added, otherwise false. */
  public get isEmpty(): boolean {
    return this.sections.size === 0;
  }

  /** Render the report as lines: each heading, then its lines, sorted, indented. */
  public render(): string[] {
    return [...this.sections].flatMap(([heading, lines], at) => [
      ...(at > 0 ? [""] : []),
      `${heading}:`,
      ...[...lines].sort().map(line => `  ${line}`),
    ]);
  }
}
