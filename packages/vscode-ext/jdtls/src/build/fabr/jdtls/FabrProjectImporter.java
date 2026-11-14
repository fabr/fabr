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

package build.fabr.jdtls;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.io.File;
import java.net.URI;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import org.eclipse.core.resources.WorkspaceJob;
import org.eclipse.core.runtime.CoreException;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.IStatus;
import org.eclipse.core.runtime.OperationCanceledException;
import org.eclipse.core.runtime.Status;
import org.eclipse.jdt.ls.core.internal.AbstractProjectImporter;
import org.eclipse.jdt.ls.core.internal.JavaLanguageServerPlugin;

/**
 * Imports a folder holding a fabr project: each Java package its build server
 * describes as a JDT project (see {@link FabrProjects}), kept current as the
 * server announces changes. The server is the one the VS Code extension runs
 * for the project, shared at a socket the importer names with
 * {@link #CONNECT_COMMAND}: a notification, as the language server cannot read
 * an answer to a request while it imports.
 */
public class FabrProjectImporter extends AbstractProjectImporter {
    /** The file a fabr project's root holds. */
    private static final String PROJECT_FILE = "PROJECT.fabr";
    /** The client command sharing the project's server at a socket, given the project's root URI and the socket's path. */
    private static final String CONNECT_COMMAND = "_fabr.connectBuildServer";
    /** How long the extension is given to share the project's server. */
    private static final Duration CONNECT_TIMEOUT = Duration.ofMinutes(5);
    /** How often a connection is tried meanwhile. */
    private static final Duration CONNECT_INTERVAL = Duration.ofMillis(500);
    /** How long a request is given. */
    private static final long REQUEST_TIMEOUT_MINUTES = 10;

    /** Each project's connection, by its root: one per project for the session. */
    private static final Map<File, BuildServerConnection> CONNECTIONS = new ConcurrentHashMap<>();

    private boolean resolved = true;

    @Override
    public boolean applies(IProgressMonitor monitor) throws OperationCanceledException, CoreException {
        return rootFolder != null && new File(rootFolder, PROJECT_FILE).isFile();
    }

    @Override
    public boolean isResolved(File folder) throws OperationCanceledException, CoreException {
        return resolved;
    }

    @Override
    public void importToWorkspace(IProgressMonitor monitor) throws OperationCanceledException, CoreException {
        try {
            BuildServerConnection server = connection(rootFolder);
            FabrProjects.update(rootFolder, describedTargets(server), monitor);
            resolved = true;
        } catch (Exception e) {
            JavaLanguageServerPlugin.logException("fabr: cannot import " + rootFolder, e);
            resolved = false;
        }
    }

    @Override
    public void reset() {
    }

    /** @return the connection to the server of the project at `root`, made and initialized the first time. */
    private static BuildServerConnection connection(File root) throws Exception {
        BuildServerConnection existing = CONNECTIONS.get(root);
        if (existing != null) {
            return existing;
        }
        String rootUri = root.toURI().toString();
        /* Named for the language server's process and the project: a socket in the
         * temporary directory, as a socket's path is short, or on Windows a named
         * pipe, as the language server's own connection is there. */
        String name = "fabr-jdtls-" + ProcessHandle.current().pid() + "-" + Integer.toHexString(root.getPath().hashCode());
        String socket;
        if (BuildServerConnection.WINDOWS) {
            socket = "\\\\.\\pipe\\" + name;
        } else {
            Path file = Path.of(System.getProperty("java.io.tmpdir"), name + ".sock");
            java.nio.file.Files.deleteIfExists(file);
            socket = file.toString();
        }
        JavaLanguageServerPlugin.getInstance().getClientConnection().sendNotification(CONNECT_COMMAND, rootUri, socket);
        BuildServerConnection server = connectWhenShared(socket);
        JsonObject capabilities = new JsonObject();
        capabilities.add("languageIds", new com.google.gson.JsonArray());
        capabilities.getAsJsonArray("languageIds").add("java");
        await(server.request("build/initialize", Map.of(
            "displayName", "Fabr for jdtls",
            "version", "0.1.0",
            "bspVersion", "2.1.0",
            "rootUri", rootUri,
            "capabilities", capabilities)));
        server.notify("build/initialized", Map.of());
        server.onNotification((method, params) -> {
            if ("buildTarget/didChange".equals(method)) {
                JavaLanguageServerPlugin.logInfo("fabr: " + root + " changed");
                scheduleUpdate(root, server);
            }
        });
        CONNECTIONS.put(root, server);
        return server;
    }

    /** @return a connection to the server shared at `socket`, tried until the extension shares it. */
    private static BuildServerConnection connectWhenShared(String socket) throws Exception {
        long deadline = System.nanoTime() + CONNECT_TIMEOUT.toNanos();
        for (;;) {
            try {
                return BuildServerConnection.connect(socket);
            } catch (java.io.IOException e) {
                if (System.nanoTime() > deadline) {
                    throw new java.io.IOException("the fabr extension did not share the build server at " + socket, e);
                }
                Thread.sleep(CONNECT_INTERVAL.toMillis());
            }
        }
    }

    /** Re-import the project at `root` from `server`'s current descriptions. */
    private static void scheduleUpdate(File root, BuildServerConnection server) {
        WorkspaceJob job = new WorkspaceJob("fabr: updating the Java projects") {
            @Override
            public IStatus runInWorkspace(IProgressMonitor monitor) {
                try {
                    FabrProjects.update(root, describedTargets(server), monitor);
                    JavaLanguageServerPlugin.logInfo("fabr: updated the Java projects of " + root);
                    return Status.OK_STATUS;
                } catch (Exception e) {
                    JavaLanguageServerPlugin.logException("fabr: cannot update " + root, e);
                    return Status.OK_STATUS;
                }
            }
        };
        job.setRule(org.eclipse.core.resources.ResourcesPlugin.getWorkspace().getRoot());
        job.schedule();
    }

    /** @return `server`'s JVM targets, each with its sources and javac options. */
    private static List<FabrProjects.Target> describedTargets(BuildServerConnection server) throws Exception {
        JsonObject answer = await(server.request("workspace/buildTargets", Map.of())).getAsJsonObject();
        List<JsonObject> targets = answer.getAsJsonArray("targets").asList().stream()
            .map(JsonElement::getAsJsonObject)
            .filter(target -> target.has("dataKind") && "jvm".equals(target.get("dataKind").getAsString()))
            .toList();
        List<Map<String, String>> ids = targets.stream().map(target -> Map.of("uri", target.getAsJsonObject("id").get("uri").getAsString())).toList();
        Map<String, JsonObject> sources = byTarget(await(server.request("buildTarget/sources", Map.of("targets", ids))));
        Map<String, JsonObject> javac = byTarget(await(server.request("buildTarget/javacOptions", Map.of("targets", ids))));
        return targets.stream().map(target -> {
            String uri = target.getAsJsonObject("id").get("uri").getAsString();
            return new FabrProjects.Target(
                uri,
                target.getAsJsonArray("dependencies").asList().stream().map(dep -> dep.getAsJsonObject().get("uri").getAsString()).toList(),
                paths(sources.get(uri), "roots"),
                paths(javac.get(uri), "classpath"),
                javac.containsKey(uri) ? strings(javac.get(uri), "options") : List.of());
        }).toList();
    }

    private static Map<String, JsonObject> byTarget(JsonElement answer) {
        Map<String, JsonObject> items = new java.util.HashMap<>();
        for (JsonElement item : answer.getAsJsonObject().getAsJsonArray("items")) {
            items.put(item.getAsJsonObject().getAsJsonObject("target").get("uri").getAsString(), item.getAsJsonObject());
        }
        return items;
    }

    private static List<Path> paths(JsonObject item, String field) {
        return item == null || !item.has(field) ? List.of() : strings(item, field).stream().map(uri -> Path.of(URI.create(uri))).toList();
    }

    private static List<String> strings(JsonObject item, String field) {
        return item.getAsJsonArray(field).asList().stream().map(JsonElement::getAsString).toList();
    }

    private static JsonElement await(java.util.concurrent.CompletableFuture<JsonElement> answer) throws Exception {
        return answer.get(REQUEST_TIMEOUT_MINUTES, TimeUnit.MINUTES);
    }
}
