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
import java.nio.ByteBuffer;
import java.nio.channels.AsynchronousFileChannel;
import java.nio.channels.Channels;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BiConsumer;

/**
 * A Build Server Protocol connection: JSON-RPC over a Unix socket, or on
 * Windows a named pipe, framed as LSP frames it. Requests are answered by future; every notification the
 * server sends is passed to the listener.
 */
final class BuildServerConnection {
    private static final Gson GSON = new Gson();

    /** Whether this is Windows, where the server is reached through a named pipe. */
    static final boolean WINDOWS = System.getProperty("os.name", "").toLowerCase().startsWith("windows");

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

    /**
     * Connect to the server at `socket`: a Unix socket, or on Windows a named
     * pipe, opened for overlapped I/O (as the language server opens its own) so
     * that a read waiting for the server does not hold up a write to it.
     */
    static BuildServerConnection connect(String socket) throws IOException {
        if (WINDOWS) {
            AsynchronousFileChannel pipe = AsynchronousFileChannel.open(Path.of(socket), StandardOpenOption.READ, StandardOpenOption.WRITE);
            return new BuildServerConnection(new PipeInputStream(pipe), new PipeOutputStream(pipe));
        }
        SocketChannel channel = SocketChannel.open(UnixDomainSocketAddress.of(socket));
        return new BuildServerConnection(Channels.newInputStream(channel), Channels.newOutputStream(channel));
    }

    /** The bytes read from a named pipe, a read at a time. */
    private static final class PipeInputStream extends InputStream {
        private final AsynchronousFileChannel pipe;
        private final ByteBuffer buffer = ByteBuffer.allocate(8192);

        PipeInputStream(AsynchronousFileChannel pipe) {
            this.pipe = pipe;
            buffer.flip();
        }

        @Override
        public int read() throws IOException {
            if (!buffer.hasRemaining()) {
                buffer.clear();
                /* A pipe has no position: the offset is ignored. */
                int read = await(pipe.read(buffer, 0));
                buffer.flip();
                if (read <= 0) {
                    return -1;
                }
            }
            return buffer.get() & 0xff;
        }
    }

    /** The bytes written to a named pipe, each write whole before it returns. */
    private static final class PipeOutputStream extends OutputStream {
        private final AsynchronousFileChannel pipe;

        PipeOutputStream(AsynchronousFileChannel pipe) {
            this.pipe = pipe;
        }

        @Override
        public void write(int b) throws IOException {
            write(new byte[] { (byte) b }, 0, 1);
        }

        @Override
        public void write(byte[] bytes, int offset, int length) throws IOException {
            ByteBuffer data = ByteBuffer.wrap(bytes, offset, length);
            while (data.hasRemaining()) {
                await(pipe.write(data, 0));
            }
        }
    }

    /** @return what `operation` completes with, its failure an IOException. */
    private static int await(java.util.concurrent.Future<Integer> operation) throws IOException {
        try {
            return operation.get();
        } catch (ExecutionException e) {
            throw e.getCause() instanceof IOException io ? io : new IOException(e.getCause());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException(e);
        }
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
