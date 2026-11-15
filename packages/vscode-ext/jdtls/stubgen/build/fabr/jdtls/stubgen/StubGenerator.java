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

package build.fabr.jdtls.stubgen;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.net.JarURLConnection;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import java.util.stream.Stream;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.Handle;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.Type;
import org.objectweb.asm.signature.SignatureReader;
import org.objectweb.asm.signature.SignatureVisitor;
import org.objectweb.asm.tree.AbstractInsnNode;
import org.objectweb.asm.tree.ClassNode;
import org.objectweb.asm.tree.FieldInsnNode;
import org.objectweb.asm.tree.FieldNode;
import org.objectweb.asm.tree.InvokeDynamicInsnNode;
import org.objectweb.asm.tree.LdcInsnNode;
import org.objectweb.asm.tree.LocalVariableNode;
import org.objectweb.asm.tree.MethodInsnNode;
import org.objectweb.asm.tree.MethodNode;
import org.objectweb.asm.tree.MultiANewArrayInsnNode;
import org.objectweb.asm.tree.TryCatchBlockNode;
import org.objectweb.asm.tree.TypeInsnNode;

/**
 * Writes the stubs of a library's classes that some code is compiled against:
 * each class of the library the code refers to, holding the members it uses
 * and the ones it overrides, with the library's own signatures.
 *
 * <p>Invoked as {@code StubGenerator <class> <package> <directory>}: the code
 * is every class in the jar holding {@code <class>}, the library is the
 * classes under {@code <package>}, and both are read from the classpath, which
 * must hold the library's real classes and their superclasses. The stubs replace every {@code .java}
 * file under {@code <directory>}.
 */
public final class StubGenerator {
    /** The code's classes, by internal name. */
    private final Map<String, ClassNode> users = new LinkedHashMap<>();
    /** The classes read from the classpath so far, by internal name. */
    private final Map<String, ClassNode> classes = new LinkedHashMap<>();
    /** The internal name every library class's starts with. */
    private final String prefix;
    /** The stubs, by internal name. */
    private final Map<String, StubWriter.Stub> stubs = new LinkedHashMap<>();

    private StubGenerator(String prefix) {
        this.prefix = prefix;
    }

    public static void main(String[] args) throws IOException {
        if (args.length != 3) {
            System.err.println("usage: StubGenerator <class> <package> <directory>");
            System.exit(2);
        }
        StubGenerator generator = new StubGenerator(args[1].replace('.', '/') + "/");
        generator.readUsers(args[0].replace('.', '/') + ".class");
        generator.collect();
        Path directory = Path.of(args[2]);
        removeSources(directory);
        for (StubWriter.Stub stub : generator.stubs.values()) {
            Path file = directory.resolve(stub.node().name + ".java");
            Files.createDirectories(file.getParent());
            Files.writeString(file, StubWriter.render(stub, generator.stubs));
        }
        System.err.println("Wrote " + generator.stubs.size() + " stubs to " + directory);
    }

    /** Read every class in the jar holding the resource `resource`. */
    private void readUsers(String resource) throws IOException {
        URL url = ClassLoader.getSystemResource(resource);
        if (url == null) {
            throw new IllegalArgumentException(resource + " is not on the classpath");
        }
        if (!(url.openConnection() instanceof JarURLConnection connection)) {
            throw new IllegalArgumentException(resource + " is not in a jar: " + url);
        }
        try (JarFile jar = new JarFile(connection.getJarFileURL().getPath())) {
            for (JarEntry entry : jar.stream().toList()) {
                if (entry.getName().endsWith(".class") && !entry.getName().endsWith("module-info.class")) {
                    try (InputStream in = jar.getInputStream(entry)) {
                        ClassNode node = read(in);
                        users.put(node.name, node);
                    }
                }
            }
        }
    }

    /** Collect the stubs the code needs, and the classes between a stub and a stubbed ancestor. */
    private void collect() {
        for (ClassNode user : users.values()) {
            requireType(user.superName);
            user.interfaces.forEach(this::requireType);
            requireSignature(user.signature);
            for (FieldNode field : user.fields) {
                requireSignature(field.signature != null ? field.signature : field.desc);
            }
            for (MethodNode method : user.methods) {
                requireSignature(method.signature != null ? method.signature : method.desc);
                if (method.exceptions != null) {
                    method.exceptions.forEach(this::requireType);
                }
                if ((method.access & (Opcodes.ACC_STATIC | Opcodes.ACC_PRIVATE | Opcodes.ACC_SYNTHETIC)) == 0 && !method.name.startsWith("<")) {
                    requireOverridden(user, method);
                }
                collectInstructions(method);
            }
        }
        /* A stub extends its class's real superclass where that is the library's, so the superclass is stubbed too. */
        for (int done = 0; done < stubs.size(); done++) {
            ClassNode node = List.copyOf(stubs.values()).get(done).node();
            if ((node.access & Opcodes.ACC_INTERFACE) == 0) {
                requireType(node.superName);
            }
        }
        for (StubWriter.Stub stub : stubs.values()) {
            ClassNode node = stub.node();
            stub.supertypes().addAll(node.interfaces.stream().filter(stubs::containsKey).toList());
            if ((node.access & Opcodes.ACC_INTERFACE) == 0 && (stubs.containsKey(node.superName) || isExtensible(node.superName))) {
                stub.supertypes().add(0, node.superName);
            }
        }
    }

    /**
     * @return true if a stub may extend `type`, a class outside the library: it has a no-argument
     * constructor a subclass can call, and neither it nor a superclass declares an abstract method,
     * otherwise false.
     */
    private boolean isExtensible(String type) {
        boolean first = true;
        for (String name = type; name != null; first = false) {
            ClassNode node = loadAny(name);
            if (node == null) {
                throw new IllegalStateException(name.replace('/', '.') + " is not on the classpath");
            }
            if ((node.access & (Opcodes.ACC_FINAL | Opcodes.ACC_INTERFACE)) != 0) {
                return false;
            }
            if (node.methods.stream().anyMatch(m -> (m.access & Opcodes.ACC_ABSTRACT) != 0)) {
                return false;
            }
            if (first && node.methods.stream().noneMatch(m -> m.name.equals("<init>") && m.desc.equals("()V") && (m.access & Opcodes.ACC_PRIVATE) == 0)) {
                return false;
            }
            name = node.superName;
        }
        return true;
    }

    private void collectInstructions(MethodNode method) {
        for (AbstractInsnNode insn : method.instructions) {
            if (insn instanceof MethodInsnNode call) {
                requireMember(call.owner, call.name, call.desc, false);
            } else if (insn instanceof FieldInsnNode field) {
                requireMember(field.owner, field.name, field.desc, true);
            } else if (insn instanceof TypeInsnNode type) {
                requireSignature(type.desc.startsWith("[") ? type.desc : "L" + type.desc + ";");
            } else if (insn instanceof MultiANewArrayInsnNode array) {
                requireSignature(array.desc);
            } else if (insn instanceof LdcInsnNode ldc && ldc.cst instanceof Type type) {
                requireSignature(type.getDescriptor());
            } else if (insn instanceof InvokeDynamicInsnNode indy) {
                requireSignature(indy.desc);
                for (Object arg : indy.bsmArgs) {
                    if (arg instanceof Handle handle) {
                        requireMember(handle.getOwner(), handle.getName(), handle.getDesc(), handle.getTag() <= Opcodes.H_PUTSTATIC);
                    } else if (arg instanceof Type type) {
                        requireSignature(type.getDescriptor());
                    }
                }
            }
        }
        for (TryCatchBlockNode block : method.tryCatchBlocks) {
            requireType(block.type);
        }
        if (method.localVariables != null) {
            for (LocalVariableNode local : method.localVariables) {
                requireSignature(local.signature != null ? local.signature : local.desc);
            }
        }
    }

    /** Stub the library's declaration of a member used as `owner`'s, found in `owner` or its supertypes. */
    private void requireMember(String owner, String name, String desc, boolean field) {
        if (owner.startsWith("[")) {
            return;
        }
        Deque<String> pending = new ArrayDeque<>(List.of(owner));
        Set<String> seen = new LinkedHashSet<>();
        while (!pending.isEmpty()) {
            String type = pending.removeFirst();
            ClassNode node = users.containsKey(type) ? users.get(type) : isLibrary(type) ? load(type) : null;
            if (node == null || !seen.add(type)) {
                continue;
            }
            if (field ? node.fields.stream().anyMatch(f -> f.name.equals(name) && f.desc.equals(desc))
                      : node.methods.stream().anyMatch(m -> m.name.equals(name) && m.desc.equals(desc))) {
                if (isLibrary(type)) {
                    StubWriter.Stub stub = requireType(type);
                    if (field) {
                        FieldNode member = node.fields.stream().filter(f -> f.name.equals(name) && f.desc.equals(desc)).findFirst().orElseThrow();
                        stub.fields().add(member);
                        requireSignature(member.signature != null ? member.signature : member.desc);
                    } else {
                        MethodNode member = node.methods.stream().filter(m -> m.name.equals(name) && m.desc.equals(desc)).findFirst().orElseThrow();
                        stub.methods().add(member);
                        requireSignature(member.signature != null ? member.signature : member.desc);
                        if (member.exceptions != null) {
                            member.exceptions.forEach(this::requireType);
                        }
                    }
                }
                return;
            }
            if (node.superName != null) {
                pending.addLast(node.superName);
            }
            pending.addAll(node.interfaces);
        }
    }

    /** Stub the library method `method` of `user` overrides, where there is one. */
    private void requireOverridden(ClassNode user, MethodNode method) {
        Deque<String> pending = new ArrayDeque<>();
        if (user.superName != null) {
            pending.add(user.superName);
        }
        pending.addAll(user.interfaces);
        Set<String> seen = new LinkedHashSet<>();
        while (!pending.isEmpty()) {
            String type = pending.removeFirst();
            ClassNode node = users.containsKey(type) ? users.get(type) : isLibrary(type) ? load(type) : null;
            if (node == null || !seen.add(type)) {
                continue;
            }
            if (isLibrary(type) && node.methods.stream().anyMatch(m -> m.name.equals(method.name) && m.desc.equals(method.desc)
                    && (m.access & (Opcodes.ACC_PRIVATE | Opcodes.ACC_STATIC | Opcodes.ACC_SYNTHETIC)) == 0)) {
                requireMember(type, method.name, method.desc, false);
                return;
            }
            if (node.superName != null) {
                pending.addLast(node.superName);
            }
            pending.addAll(node.interfaces);
        }
    }

    /** Stub each library class a type signature or descriptor names. */
    private void requireSignature(String signature) {
        if (signature == null) {
            return;
        }
        new SignatureReader(signature).accept(new SignatureVisitor(Opcodes.ASM9) {
            @Override
            public void visitClassType(String name) {
                requireType(name);
            }
        });
    }

    /** @return the stub of `type`, made the first time, where it is the library's, otherwise null. */
    private StubWriter.Stub requireType(String type) {
        if (type == null || !isLibrary(type)) {
            return null;
        }
        StubWriter.Stub existing = stubs.get(type);
        if (existing != null) {
            return existing;
        }
        ClassNode node = load(type);
        if (node == null) {
            throw new IllegalStateException(type.replace('/', '.') + " is not on the classpath");
        }
        if (node.outerClass != null || node.nestHostClass != null || type.contains("$")) {
            throw new IllegalStateException("cannot stub " + type.replace('/', '.') + ": a nested class");
        }
        if ((node.access & (Opcodes.ACC_ENUM | Opcodes.ACC_ANNOTATION | Opcodes.ACC_RECORD)) != 0) {
            throw new IllegalStateException("cannot stub " + type.replace('/', '.') + ": an enum, record or annotation");
        }
        StubWriter.Stub stub = new StubWriter.Stub(node, new ArrayList<>(), new LinkedHashSet<>(), new LinkedHashSet<>());
        stubs.put(type, stub);
        return stub;
    }

    private boolean isLibrary(String type) {
        return type.startsWith(prefix);
    }

    /** @return the library's class `type` read from the classpath, or null where there is none. */
    private ClassNode load(String type) {
        return loadAny(type);
    }

    /** @return the class `type` read from the classpath, or null where there is none. */
    private ClassNode loadAny(String type) {
        return classes.computeIfAbsent(type, name -> {
            try (InputStream in = ClassLoader.getSystemResourceAsStream(name + ".class")) {
                return in == null ? null : read(in);
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
        });
    }

    private static ClassNode read(InputStream in) throws IOException {
        ClassNode node = new ClassNode();
        new ClassReader(in).accept(node, ClassReader.SKIP_FRAMES);
        return node;
    }

    /** Delete every `.java` file under `directory`, and the directories left empty. */
    private static void removeSources(Path directory) throws IOException {
        if (!Files.isDirectory(directory)) {
            return;
        }
        try (Stream<Path> walk = Files.walk(directory)) {
            for (Path path : walk.sorted(Comparator.reverseOrder()).toList()) {
                if (Files.isDirectory(path)) {
                    try (Stream<Path> entries = Files.list(path)) {
                        if (entries.findAny().isEmpty() && !path.equals(directory)) {
                            Files.delete(path);
                        }
                    }
                } else if (path.toString().endsWith(".java")) {
                    Files.delete(path);
                }
            }
        }
    }
}
