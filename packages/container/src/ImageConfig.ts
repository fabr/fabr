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

import { FabrError, isJsonObject } from "@fabr-build/core";
import { IOciPlatform } from "./OciProtocol";

/** The time stamped on everything fabr writes into an image's config: the epoch, so an image is a function of its inputs. */
export const FIXED_CREATED = "1970-01-01T00:00:00Z";

/** What a `container_image` target sets on its image's config; anything absent is the base's. */
export interface IImageSettings {
  readonly entry?: string;
  readonly args: readonly string[];
  readonly workdir?: string;
  readonly user?: string;
  /** Environment variables, by name, over the base's. */
  readonly env: ReadonlyArray<readonly [string, string]>;
  /** Ports the image exposes: `8080` (TCP), or `53/udp`. */
  readonly ports: readonly string[];
  /** Facts about the image, by key, written as labels over the base's (see {@link labelKey}). */
  readonly metadata: ReadonlyArray<readonly [string, string]>;
  /** A shell command run in the base, whose changes are a layer of their own. */
  readonly build?: string;
}

/** The keys of `metadata` OCI defines a label for, each written as `org.opencontainers.image.<key>`. */
const OCI_LABEL_KEYS: ReadonlySet<string> = new Set(["title", "description", "url", "source", "documentation", "licenses", "vendor", "authors"]);

/** @return the label `metadata`'s `key` is written as: OCI's own for a key it defines, else the key as written. */
export function labelKey(key: string): string {
  return OCI_LABEL_KEYS.has(key) ? `org.opencontainers.image.${key}` : key;
}

/**
 * Make the config of an image built on `base` (a config document; none for an
 * image of only its own layers): `settings` applied over it, a layer whose
 * uncompressed digest is `diffId` added where there is one, and a history
 * entry for it. `entry` and `args` are written together as `Entrypoint`, which
 * clears the base's `Cmd`; where neither is set, both are the base's.
 */
export function imageConfig(
  base: Record<string, unknown> | undefined,
  platform: IOciPlatform,
  settings: IImageSettings,
  diffId: string | undefined,
  createdBy: string
): Record<string, unknown> {
  if (settings.entry === undefined && settings.args.length > 0) {
    throw new FabrError("'args' is set without 'entry'").withHelp("set 'entry' to the program the arguments are given to");
  }
  const document: Record<string, unknown> = base === undefined ? { architecture: platform.architecture, os: platform.os, ...(platform.variant === undefined ? {} : { variant: platform.variant }) } : { ...base };
  const config: Record<string, unknown> = isJsonObject(document.config) ? { ...document.config } : {};
  if (settings.env.length > 0) {
    const env = new Map<string, string>(stringList(config.Env).map(entry => [entry.split("=", 1)[0], entry]));
    for (const [name, value] of settings.env) {
      env.set(name, `${name}=${value}`);
    }
    config.Env = [...env.values()];
  }
  if (settings.entry !== undefined) {
    config.Entrypoint = [settings.entry, ...settings.args];
    delete config.Cmd;
  }
  if (settings.workdir !== undefined) {
    config.WorkingDir = settings.workdir;
  }
  if (settings.user !== undefined) {
    config.User = settings.user;
  }
  if (settings.metadata.length > 0) {
    const labels: Record<string, unknown> = isJsonObject(config.Labels) ? { ...config.Labels } : {};
    for (const [key, value] of settings.metadata) {
      labels[labelKey(key)] = value;
    }
    config.Labels = labels;
  }
  if (settings.ports.length > 0) {
    const exposed: Record<string, unknown> = isJsonObject(config.ExposedPorts) ? { ...config.ExposedPorts } : {};
    for (const port of settings.ports) {
      exposed[portKey(port)] = {};
    }
    config.ExposedPorts = exposed;
  }
  const rootfs = isJsonObject(document.rootfs) ? document.rootfs : {};
  const diffIds = [...stringList(rootfs.diff_ids), ...(diffId === undefined ? [] : [diffId])];
  const history = [...(Array.isArray(document.history) ? document.history : []), { created: FIXED_CREATED, created_by: createdBy, ...(diffId === undefined ? { empty_layer: true } : {}) }];
  return { ...document, created: FIXED_CREATED, config, rootfs: { type: "layers", diff_ids: diffIds }, history };
}

/** Read a port as OCI's `ExposedPorts` keys it: `8080` is `8080/tcp`. */
function portKey(port: string): string {
  const match = /^(\d{1,5})(?:\/(tcp|udp|sctp))?$/.exec(port);
  if (match === null || Number(match[1]) > 65535) {
    throw new FabrError(`'${port}' is not a port`).withHelp("write a port as its number, as in '8080', or with its protocol, as in '53/udp'");
  }
  return `${match[1]}/${match[2] ?? "tcp"}`;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
