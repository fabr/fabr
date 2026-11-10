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

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.UnixDomainSocketAddress;
import java.nio.channels.Channels;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BiConsumer;

/**
 * A Build Server Protocol connection: JSON-RPC over a Unix socket, framed as
 * LSP frames it. Requests are answered by future; every notification the
 * server sends is passed to the listener.
 */
final class BuildServerConnection {
    private static final Gson GSON = new Gson();

    private final OutputStream output;
    private final AtomicInteger ids = new AtomicInteger();
    private final Map<Integer, CompletableFuture<JsonElement>> pending = new ConcurrentHashMap<>();
    private volatile BiConsumer<String, JsonElement> listener = (method, params) -> {};

    private BuildServerConnection(InputStream input, OutputStream output) {
        this.output = output;
        Thread reader = new Thread(() -> read(input), "fabr build server");
        reader.setDaemon(true);
        reader.start();
    }

    /** Connect to the server at the Unix socket `socket`. */
    static BuildServerConnection connect(String socket) throws IOException {
        SocketChannel channel = SocketChannel.open(UnixDomainSocketAddress.of(socket));
        return new BuildServerConnection(Channels.newInputStream(channel), Channels.newOutputStream(channel));
    }

    /** Send request `method`, answering with its result. */
    CompletableFuture<JsonElement> request(String method, Object params) {
        int id = ids.incrementAndGet();
        CompletableFuture<JsonElement> answer = new CompletableFuture<>();
        pending.put(id, answer);
        JsonObject message = new JsonObject();
        message.addProperty("jsonrpc", "2.0");
        message.addProperty("id", id);
        message.addProperty("method", method);
        message.add("params", GSON.toJsonTree(params));
        try {
            send(message);
        } catch (IOException e) {
            pending.remove(id);
            answer.completeExceptionally(e);
        }
        return answer;
    }

    /** Send notification `method`. */
    void notify(String method, Object params) throws IOException {
        JsonObject message = new JsonObject();
        message.addProperty("jsonrpc", "2.0");
        message.addProperty("method", method);
        message.add("params", GSON.toJsonTree(params));
        send(message);
    }

    /** Call `listener` with each notification the server sends. */
    void onNotification(BiConsumer<String, JsonElement> listener) {
        this.listener = listener;
    }

    private synchronized void send(JsonObject message) throws IOException {
        byte[] body = GSON.toJson(message).getBytes(StandardCharsets.UTF_8);
        output.write(("Content-Length: " + body.length + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        output.write(body);
        output.flush();
    }

    private void read(InputStream input) {
        try {
            for (;;) {
                int length = -1;
                for (String line = readLine(input); !line.isEmpty(); line = readLine(input)) {
                    int colon = line.indexOf(':');
                    if (colon > 0 && line.substring(0, colon).trim().equalsIgnoreCase("Content-Length")) {
                        length = Integer.parseInt(line.substring(colon + 1).trim());
                    }
                }
                if (length < 0) {
                    break;
                }
                byte[] body = input.readNBytes(length);
                if (body.length < length) {
                    break;
                }
                receive(GSON.fromJson(new String(body, StandardCharsets.UTF_8), JsonObject.class));
            }
        } catch (IOException e) {
            // The connection ended: whatever is pending fails below.
        }
        IOException closed = new IOException("the fabr build server closed the connection");
        pending.values().forEach(answer -> answer.completeExceptionally(closed));
        pending.clear();
    }

    private void receive(JsonObject message) {
        if (message.has("method")) {
            listener.accept(message.get("method").getAsString(), message.get("params"));
            return;
        }
        CompletableFuture<JsonElement> answer = message.has("id") ? pending.remove(message.get("id").getAsInt()) : null;
        if (answer == null) {
            return;
        }
        if (message.has("error")) {
            answer.completeExceptionally(new IOException(message.getAsJsonObject("error").get("message").getAsString()));
        } else {
            answer.complete(message.get("result"));
        }
    }

    /** @return the next header line of `input`, without its line ending; "" for the blank line ending the headers. */
    private static String readLine(InputStream input) throws IOException {
        StringBuilder line = new StringBuilder();
        for (int c = input.read(); c != '\n'; c = input.read()) {
            if (c < 0) {
                throw new IOException("end of input");
            }
            if (c != '\r') {
                line.append((char) c);
            }
        }
        return line.toString();
    }
}
