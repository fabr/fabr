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

import { BUILD_OVERRIDE, Computable, defineRule, FabrError, Property, PropertyMap, RunnableFileSet } from "@fabr-build/core";
import { stringEntries } from "../ImageConfig";
import { ImageFileSet } from "../ImageFileSet";
import { IContainerRun, imageRunnable } from "../ImageRunnable";

/**
 * The `container_program` rule, under `run`: the target's `image` as a
 * program the container engine `CONTAINER_ENGINE` runs, with the target's
 * environment, ports, network, host names and arguments (see
 * {@link imageRunnable}).
 */
export default defineRule({
  requirements(context) {
    return { run: { image: context.getPackageProperty("image", BUILD_OVERRIDE) } };
  },
  evaluateMaterialized(context, { image }) {
    const images = image.filter((source): source is ImageFileSet => source instanceof ImageFileSet);
    if (images.length !== 1 || images.length !== image.length) {
      throw new FabrError(`${context.name}'s image is not one image`).withHelp(
        "name a 'container_image' target, or an image reference such as '@docker:redis:7-alpine'"
      );
    }
    const value = (name: string): Computable<Property | undefined> => context.getProperty(name);
    return Computable.forAll(
      [
        value("ports"),
        context.getMap("env"),
        value("network"),
        context.getMap("hosts"),
        value("args"),
        context.getGlobalRunnable("CONTAINER_ENGINE"),
      ] as const,
      (ports, env: PropertyMap, network, hosts: PropertyMap, args, engine: RunnableFileSet): Computable<RunnableFileSet> => {
        const run: IContainerRun = {
          ...(ports === undefined ? {} : { ports: ports.getValues() }),
          env: stringEntries(context.name, "env", env),
          ...(network === undefined ? {} : { network: network.toString() }),
          hosts: stringEntries(context.name, "hosts", hosts),
          args: args?.getValues() ?? [],
        };
        return imageRunnable(images[0], context.name, engine, context, run);
      }
    );
  },
});
