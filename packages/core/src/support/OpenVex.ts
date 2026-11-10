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

import { FabrError } from "../core/Errors";
import { isJsonObject } from "./Json";

/** The statuses an OpenVEX statement may give a vulnerability in a product. */
const VEX_STATUSES = ["not_affected", "affected", "fixed", "under_investigation"] as const;

export type VexStatus = (typeof VEX_STATUSES)[number];

/** One statement of an OpenVEX document (https://github.com/openvex/spec),
 * the fields an audit reads. */
export interface VexStatement {
  /** The vulnerability's name, then its aliases. */
  readonly vulnerability: ReadonlyArray<string>;
  /** The purls of the products the statement is about and of their
   * subcomponents, each applying to every version where it names none. */
  readonly products: ReadonlyArray<string>;
  readonly status: VexStatus;
  readonly justification?: string;
  readonly impact?: string;
  /** When the statement was made, in milliseconds since the epoch: its own
   * timestamp, else its document's; none where neither states one. */
  readonly timestamp?: number;
  /** The document the statement is read from, as its reader names it. */
  readonly document: string;
}

/** @return the purls naming `component`, a product or subcomponent: its `@id`
 * and its `identifiers.purl` where they are purls, or the component itself
 * where it is written as a bare string. */
function componentPurls(component: unknown): string[] {
  const ids =
    typeof component === "string"
      ? [component]
      : isJsonObject(component)
        ? [component["@id"], isJsonObject(component.identifiers) ? component.identifiers.purl : undefined]
        : [];
  return ids.filter((id): id is string => typeof id === "string" && id.startsWith("pkg:"));
}

/** @return `value` as a list where it is an array, otherwise empty. */
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** @return `text` as milliseconds since the epoch where it is a date, otherwise undefined. */
function timeOf(text: unknown): number | undefined {
  const time = typeof text === "string" ? Date.parse(text) : NaN;
  return Number.isNaN(time) ? undefined : time;
}

/**
 * Make a converter of an OpenVEX document, named `document` in what is read
 * from it, to its statements, in the order it states them. A statement's
 * vulnerability is either a name or an object with a `name` and `aliases`
 * (the 0.0 and 0.2 forms), and a product either a purl or an object
 * identifying one, with subcomponents of either form.
 */
export function toVexStatements(document: string): (json: unknown) => VexStatement[] {
  return json => {
    if (!isJsonObject(json) || !Array.isArray(json.statements)) {
      throw new FabrError("expected an OpenVEX document with statements");
    }
    const documentTime = timeOf(json.timestamp);
    return json.statements.map((statement, at): VexStatement => {
      const where = `statement ${at + 1}`;
      if (!isJsonObject(statement)) {
        throw new FabrError(`${where} is not an object`);
      }
      const status = VEX_STATUSES.find(each => each === statement.status);
      if (status === undefined) {
        throw new FabrError(`${where} has no status OpenVEX defines (${VEX_STATUSES.join(", ")})`);
      }
      const vuln = statement.vulnerability;
      const vulnerability = [
        ...(typeof vuln === "string" ? [vuln] : isJsonObject(vuln) && typeof vuln.name === "string" ? [vuln.name] : []),
        ...(isJsonObject(vuln) ? list(vuln.aliases).filter((alias): alias is string => typeof alias === "string") : []),
      ];
      if (vulnerability.length === 0) {
        throw new FabrError(`${where} names no vulnerability`);
      }
      const products = list(statement.products).flatMap(product => [
        ...componentPurls(product),
        ...(isJsonObject(product) ? list(product.subcomponents).flatMap(componentPurls) : []),
        ...list(statement.subcomponents).flatMap(componentPurls),
      ]);
      const timestamp = timeOf(statement.timestamp) ?? documentTime;
      return {
        vulnerability,
        products: [...new Set(products)],
        status,
        ...(typeof statement.justification === "string" ? { justification: statement.justification } : {}),
        ...(typeof statement.impact_statement === "string" ? { impact: statement.impact_statement } : {}),
        ...(timestamp === undefined ? {} : { timestamp }),
        document,
      };
    });
  };
}

/** @return `purl`'s type, namespace and name, decoded, and its version where it has one. */
function purlParts(purl: string): { name: string; version?: string } {
  const bare = purl.replace(/[?#].*$/, "");
  const at = bare.lastIndexOf("@");
  /* An `@` in the path is a scope only where it is percent-encoded, so one
   * after the last `/` starts the version. */
  const hasVersion = at > bare.lastIndexOf("/");
  const path = hasVersion ? bare.substring(0, at) : bare;
  return {
    name: path.split("/").map(decodeURIComponent).join("/").toLowerCase(),
    ...(hasVersion ? { version: decodeURIComponent(bare.substring(at + 1)) } : {}),
  };
}

/** @return true if the purl `identifier` a statement names applies to the
 * package `purl` (type, namespace and name alike, and the version where the
 * identifier states one; qualifiers and subpath aside), otherwise false. */
export function purlApplies(identifier: string, purl: string): boolean {
  const named = purlParts(identifier);
  const pkg = purlParts(purl);
  return named.name === pkg.name && (named.version === undefined || named.version === pkg.version);
}

/**
 * Find the statement among `statements` that decides the status of the
 * vulnerability known by any of `ids` in the package `purl`: the latest of
 * those naming both by timestamp (one stating none the earliest), the last
 * stated among equals; none where no statement names both.
 */
export function decidingStatement(
  statements: ReadonlyArray<VexStatement>,
  ids: ReadonlyArray<string>,
  purl: string
): VexStatement | undefined {
  let decided: VexStatement | undefined;
  for (const statement of statements) {
    if (
      statement.vulnerability.some(name => ids.includes(name)) &&
      statement.products.some(product => purlApplies(product, purl)) &&
      (decided === undefined || (statement.timestamp ?? -Infinity) >= (decided.timestamp ?? -Infinity))
    ) {
      decided = statement;
    }
  }
  return decided;
}

/** @return true if `statement` says its vulnerability does not affect its products, otherwise false. */
export function suppresses(statement: VexStatement): boolean {
  return statement.status === "not_affected" || statement.status === "fixed";
}
