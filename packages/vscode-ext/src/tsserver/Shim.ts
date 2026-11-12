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

/**
 * The one plugin tsserver loads: for each tsserver project, the plugin
 * implementation of the fabr project it lies in, from that project's own fabr.
 */

import type { ITypeScriptUnit } from "@fabr-build/js-tools";
import * as path from "path";
import { type IProjectDocument, projectOf, registeredProjects } from "./Registry";

/** The name the shim is loaded under, from the wrapper's probe location. */
export const SHIM_NAME = "fabr-tsserver-shim";

/** What tsserver hands a plugin's `create`: the parts the shim reads. */
interface IPluginInfo {
  project: {
    getProjectName(): string;
    readonly projectKind?: number;
    getCurrentDirectory?(): string;
    projectService: { logger: { info(text: string): void } };
  };
  languageService: unknown;
}

/** What a project's plugin implementation exports. */
interface IPluginImplementation {
  createLanguageService(ts: unknown, info: IPluginInfo, units: readonly ITypeScriptUnit[]): unknown;
}

/** Each plugin implementation loaded, or the error loading it, by module path. */
const implementations = new Map<string, IPluginImplementation | Error>();

/** tsserver's `ProjectKind` of a project no config names, as the syntax server's are. */
const INFERRED_PROJECT = 0;

/**
 * @return the tsserver plugin module: its `create` hands a project to the
 * plugin implementation of the fabr project its config lies in, and an
 * inferred project to the implementations of the fabr projects within or
 * around the directory it is inferred for, each wrapping the language service
 * the one before made; any other project keeps its own service.
 */
export function shim(modules: { typescript: unknown }): { create(info: IPluginInfo): unknown } {
  return {
    create(info) {
      const owner = projectOf(info.project.getProjectName());
      const directory = info.project.projectKind === INFERRED_PROJECT ? info.project.getCurrentDirectory?.() : undefined;
      const projects =
        owner !== undefined
          ? [owner]
          : directory === undefined
            ? []
            : registeredProjects().filter(
                project =>
                  project.root === directory ||
                  project.root.startsWith(directory + path.sep) ||
                  directory.startsWith(project.root + path.sep)
              );
      let service = info.languageService;
      for (const project of projects) {
        const implementation = implementationOf(project, info);
        if (implementation !== undefined) {
          service = implementation.createLanguageService(modules.typescript, { ...info, languageService: service }, project.units);
        }
      }
      return service;
    },
  };
}

/** @return `project`'s plugin implementation, loaded once, or undefined (logged) if it cannot be. */
function implementationOf(project: IProjectDocument, info: IPluginInfo): IPluginImplementation | undefined {
  let implementation = implementations.get(project.plugin);
  if (implementation === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      implementation = require(project.plugin) as IPluginImplementation;
      if (typeof implementation.createLanguageService !== "function") {
        throw new Error("it exports no createLanguageService");
      }
    } catch (err) {
      implementation = err instanceof Error ? err : new Error(String(err));
    }
    implementations.set(project.plugin, implementation);
  }
  if (implementation instanceof Error) {
    info.project.projectService.logger.info(
      `fabr: cannot load the plugin for ${project.root} (${project.plugin}): ${implementation.message}`
    );
    return undefined;
  }
  return implementation;
}
