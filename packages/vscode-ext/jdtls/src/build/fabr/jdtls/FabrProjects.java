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

import java.io.File;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.eclipse.core.resources.IFolder;
import org.eclipse.core.resources.IProject;
import org.eclipse.core.resources.IProjectDescription;
import org.eclipse.core.resources.IResource;
import org.eclipse.core.resources.IWorkspace;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.core.runtime.CoreException;
import org.eclipse.core.runtime.IPath;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.QualifiedName;
import org.eclipse.jdt.core.IClasspathAttribute;
import org.eclipse.jdt.core.IClasspathEntry;
import org.eclipse.jdt.core.IJavaProject;
import org.eclipse.jdt.core.JavaCore;
import org.eclipse.jdt.core.ICompilationUnit;
import org.eclipse.jdt.launching.JavaRuntime;
import org.eclipse.jdt.ls.core.internal.JDTUtils;
import org.eclipse.jdt.ls.core.internal.JavaLanguageServerPlugin;
import org.eclipse.jdt.ls.core.internal.handlers.JDTLanguageServer;
import org.eclipse.jdt.ls.core.internal.lsp.ValidateDocumentParams;
import org.eclipse.lsp4j.TextDocumentIdentifier;

/**
 * The JDT projects of a fabr project: one per package, made from the build
 * server's targets. A package's build target gives the project its source
 * folders, classpath and Java release, and its test target the test source
 * folders and the jars only the tests use, marked as JDT marks tests. A target
 * the package depends on, directly or not, is a project it requires. The
 * projects lie in the language server's own workspace, the source folders
 * linked in, so nothing is written into the project's tree.
 */
final class FabrProjects {
    /** A described JVM target, as the server answers for it. */
    record Target(String uri, List<String> dependencies, List<Path> roots, List<Path> classpath, List<String> options) {
    }

    /** The project property naming the fabr project a JDT project was made for. */
    private static final QualifiedName FABR_ROOT = new QualifiedName("build.fabr.jdtls", "root");
    /** Where a project's classes and its tests' are written, within it. */
    private static final String OUTPUT = "bin/main";
    private static final String TEST_OUTPUT = "bin/test";

    private FabrProjects() {
    }

    /** Make the JDT projects of the fabr project at `root` those `targets` describe, removing any it no longer describes. */
    static void update(File root, List<Target> targets, IProgressMonitor monitor) throws CoreException {
        IWorkspace workspace = ResourcesPlugin.getWorkspace();
        Map<String, Target> byUri = new HashMap<>();
        Map<String, List<Target>> byPackage = new LinkedHashMap<>();
        for (Target target : targets) {
            byUri.put(target.uri(), target);
            byPackage.computeIfAbsent(packageOf(target.uri()), key -> new ArrayList<>()).add(target);
        }
        Map<String, IProject> projects = new LinkedHashMap<>();
        for (String pkg : byPackage.keySet()) {
            projects.put(pkg, open(workspace, projectName(pkg), root, monitor));
        }
        for (Map.Entry<String, List<Target>> entry : byPackage.entrySet()) {
            configure(projects.get(entry.getKey()), entry.getKey(), entry.getValue(), byUri, monitor);
        }
        for (IProject project : workspace.getRoot().getProjects()) {
            if (project.isOpen() && root.getPath().equals(project.getPersistentProperty(FABR_ROOT)) && !projects.containsValue(project)) {
                project.delete(false, true, monitor);
            }
        }
        revalidateOpenDocuments(projects.values());
    }

    /** Check each open document of `projects` again, against their classpaths as they now are. */
    private static void revalidateOpenDocuments(java.util.Collection<IProject> projects) {
        if (!(JavaLanguageServerPlugin.getInstance().getProtocol() instanceof JDTLanguageServer server)) {
            return;
        }
        for (ICompilationUnit unit : JavaCore.getWorkingCopies(null)) {
            if (projects.contains(unit.getJavaProject().getProject())) {
                server.validateDocument(new ValidateDocumentParams(new TextDocumentIdentifier(JDTUtils.toURI(unit))));
            }
        }
    }

    /** @return the identifier of the package `uri`'s target builds or tests: `fabr:<name>`, without the operation. */
    private static String packageOf(String uri) {
        int query = uri.indexOf('?');
        return query < 0 ? uri : uri.substring(0, query);
    }

    /** @return the name of the JDT project of package `pkg`: its name, less what a project name cannot hold. */
    private static String projectName(String pkg) {
        return "fabr-" + pkg.substring(pkg.indexOf(':') + 1).replaceAll("[\\\\/:*?\"<>|]", "_");
    }

    private static IProject open(IWorkspace workspace, String name, File root, IProgressMonitor monitor) throws CoreException {
        IProject project = workspace.getRoot().getProject(name);
        if (!project.exists()) {
            IProjectDescription description = workspace.newProjectDescription(name);
            description.setNatureIds(new String[] { JavaCore.NATURE_ID });
            project.create(description, monitor);
        }
        project.open(monitor);
        project.setPersistentProperty(FABR_ROOT, root.getPath());
        return project;
    }

    /** Configure `project` as package `pkg`'s, from `targets`, its build target first where it has one. */
    private static void configure(IProject project, String pkg, List<Target> targets, Map<String, Target> byUri, IProgressMonitor monitor) throws CoreException {
        Target build = byUri.get(pkg);
        List<Target> tests = targets.stream().filter(target -> !target.uri().equals(pkg)).toList();
        List<IClasspathEntry> entries = new ArrayList<>();
        Map<Path, IFolder> linked = new LinkedHashMap<>();
        for (Target target : build == null ? tests : concat(List.of(build), tests)) {
            boolean test = target != build;
            for (Path dir : target.roots()) {
                if (linked.containsKey(dir)) {
                    continue;
                }
                IFolder folder = project.getFolder("src" + linked.size());
                folder.createLink(org.eclipse.core.runtime.Path.fromOSString(dir.toString()), IResource.REPLACE | IResource.ALLOW_MISSING_LOCAL, monitor);
                linked.put(dir, folder);
                entries.add(test
                    ? JavaCore.newSourceEntry(folder.getFullPath(), new IPath[0], new IPath[0], project.getFullPath().append(TEST_OUTPUT), testAttribute())
                    : JavaCore.newSourceEntry(folder.getFullPath()));
            }
        }
        for (IResource member : project.members()) {
            if (member instanceof IFolder folder && folder.isLinked() && !linked.containsValue(folder)) {
                folder.delete(true, monitor);
            }
        }
        entries.add(JavaRuntime.getDefaultJREContainerEntry());
        Set<Path> buildJars = new HashSet<>(build == null ? List.of() : build.classpath());
        for (Path jar : buildJars.stream().sorted().toList()) {
            entries.add(JavaCore.newLibraryEntry(org.eclipse.core.runtime.Path.fromOSString(jar.toString()), null, null));
        }
        Set<Path> testJars = new HashSet<>();
        tests.forEach(test -> testJars.addAll(test.classpath()));
        testJars.removeAll(buildJars);
        for (Path jar : testJars.stream().sorted().toList()) {
            entries.add(JavaCore.newLibraryEntry(org.eclipse.core.runtime.Path.fromOSString(jar.toString()), null, null, null, testAttribute(), false));
        }
        Set<String> required = reached(build == null ? List.of() : build.dependencies(), byUri);
        Set<String> testRequired = new HashSet<>();
        tests.forEach(test -> testRequired.addAll(reached(test.dependencies(), byUri)));
        testRequired.removeAll(required);
        required.remove(pkg);
        testRequired.remove(pkg);
        for (String dependency : required.stream().sorted().toList()) {
            entries.add(JavaCore.newProjectEntry(projectPath(dependency)));
        }
        for (String dependency : testRequired.stream().sorted().toList()) {
            entries.add(JavaCore.newProjectEntry(projectPath(dependency), null, true, testAttribute(), false));
        }
        IJavaProject javaProject = JavaCore.create(project);
        javaProject.setRawClasspath(entries.toArray(new IClasspathEntry[0]), project.getFullPath().append(OUTPUT), monitor);
        String release = releaseOf(build != null ? build.options() : tests.isEmpty() ? List.of() : tests.get(0).options());
        if (release != null) {
            Map<String, String> options = javaProject.getOptions(false);
            JavaCore.setComplianceOptions(release, options);
            options.put(JavaCore.COMPILER_RELEASE, JavaCore.ENABLED);
            javaProject.setOptions(options);
        }
    }

    /** @return the packages whose build targets `dependencies` reach, directly or through each other. */
    private static Set<String> reached(List<String> dependencies, Map<String, Target> byUri) {
        Set<String> reached = new HashSet<>();
        Deque<String> queue = new ArrayDeque<>(dependencies);
        while (!queue.isEmpty()) {
            String pkg = packageOf(queue.pop());
            Target target = byUri.get(pkg);
            if (target != null && reached.add(pkg)) {
                queue.addAll(target.dependencies());
            }
        }
        return reached;
    }

    private static IPath projectPath(String pkg) {
        return org.eclipse.core.runtime.Path.ROOT.append(projectName(pkg));
    }

    /** @return the release a compile's `--release` option gives, or null where it gives none. */
    private static String releaseOf(List<String> options) {
        int at = options.indexOf("--release");
        return at < 0 || at + 1 >= options.size() ? null : options.get(at + 1);
    }

    private static IClasspathAttribute[] testAttribute() {
        return new IClasspathAttribute[] { JavaCore.newClasspathAttribute(IClasspathAttribute.TEST, "true") };
    }

    private static <T> List<T> concat(List<T> first, List<T> second) {
        List<T> all = new ArrayList<>(first);
        all.addAll(second);
        return all;
    }
}
