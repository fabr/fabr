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

import { BUILD_OVERRIDE, Computable, defineRule, FabrError, RunnableFileSet } from "@fabr-build/core";
import { ImageFileSet } from "../ImageFileSet";
import { imageRunnable } from "../ImageRunnable";

/**
 * The `container_image` rule, under `run`: the image as a program the
 * container engine `CONTAINER_ENGINE` names runs (see {@link imageRunnable}).
 */
export default defineRule({
  requirements(context) {
    return { requirements: { image: context.resolveSelfWithOverrides(BUILD_OVERRIDE) } };
  },
  evaluateMaterialized(context, { image }) {
    const built = image.find((source): source is ImageFileSet => source instanceof ImageFileSet);
    if (built === undefined) {
      throw new FabrError(`internal: ${context.name} built no image`);
    }
    return context
      .getGlobalRunnable("CONTAINER_ENGINE")
      .then((engine: RunnableFileSet): Computable<RunnableFileSet> => imageRunnable(built, context.name, engine, context.execution.processLimit));
  },
});
