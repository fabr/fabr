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

package build.fabr.junit;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

import org.jacoco.core.analysis.Analyzer;
import org.jacoco.core.analysis.CoverageBuilder;
import org.jacoco.core.analysis.IClassCoverage;
import org.jacoco.core.analysis.ICounter;
import org.jacoco.core.analysis.ILine;
import org.jacoco.core.analysis.IMethodCoverage;
import org.jacoco.core.analysis.ISourceFileCoverage;
import org.jacoco.core.analysis.ISourceNode;
import org.jacoco.core.data.ExecutionDataReader;
import org.jacoco.core.data.ExecutionDataStore;
import org.jacoco.core.data.SessionInfoStore;

/**
 * Convert what JaCoCo's agent recorded into an lcov document over the measured
 * jars' sources. Loaded by a class loader of its own, beside JaCoCo's analysis
 * libraries, so that neither they nor their asm share a classpath with the
 * tests.
 *
 * JaCoCo records whether code ran, not how often, so every count is 0 or 1.
 * A line's branches are numbered in JaCoCo's order, covered ones first.
 */
public final class Lcov {
    private Lcov() {}

    /**
     * Write the lcov document for `executionData` (the agent's session, in
     * its own format) over the classes of `measured` (jar paths) to `output`.
     * A source is named by `sources` (`com/x/Foo.java` → its source path);
     * one it does not name is left out.
     */
    public static void write(byte[] executionData, String[] measured, Map<String, String> sources, String output) throws IOException {
        ExecutionDataStore store = new ExecutionDataStore();
        ExecutionDataReader reader = new ExecutionDataReader(new ByteArrayInputStream(executionData));
        reader.setExecutionDataVisitor(store);
        reader.setSessionInfoVisitor(new SessionInfoStore());
        reader.read();
        CoverageBuilder coverage = new CoverageBuilder();
        Analyzer analyzer = new Analyzer(store, coverage);
        for (String jar : measured) {
            analyzer.analyzeAll(new File(jar));
        }
        List<ISourceFileCoverage> files = new ArrayList<>(coverage.getSourceFiles());
        files.sort(Comparator.comparing(Lcov::keyOf));
        StringBuilder out = new StringBuilder();
        for (ISourceFileCoverage file : files) {
            String source = sources.get(keyOf(file));
            if (source != null) {
                record(out, source, file, methodsOf(coverage, file));
            }
        }
        Files.write(Paths.get(output), out.toString().getBytes(StandardCharsets.UTF_8));
    }

    /** @return the source file's path within its package tree, `com/x/Foo.java`. */
    private static String keyOf(ISourceFileCoverage file) {
        return file.getPackageName().isEmpty() ? file.getName() : file.getPackageName() + "/" + file.getName();
    }

    /** One method of a source file, named `Class.method(descriptor)` so that overloads stay apart. */
    private static final class Method {
        final String name;
        final int line;
        final boolean ran;

        Method(String name, int line, boolean ran) {
            this.name = name;
            this.line = line;
            this.ran = ran;
        }
    }

    private static List<Method> methodsOf(CoverageBuilder coverage, ISourceFileCoverage file) {
        List<Method> methods = new ArrayList<>();
        for (IClassCoverage cls : coverage.getClasses()) {
            if (cls.getPackageName().equals(file.getPackageName()) && file.getName().equals(cls.getSourceFileName())) {
                String className = cls.getName().substring(cls.getName().lastIndexOf('/') + 1);
                for (IMethodCoverage method : cls.getMethods()) {
                    if (method.getFirstLine() != ISourceNode.UNKNOWN_LINE) {
                        methods.add(new Method(className + "." + method.getName() + method.getDesc(), method.getFirstLine(),
                            method.getMethodCounter().getCoveredCount() > 0));
                    }
                }
            }
        }
        methods.sort(Comparator.<Method>comparingInt(method -> method.line).thenComparing(method -> method.name));
        return methods;
    }

    private static void record(StringBuilder out, String source, ISourceFileCoverage file, List<Method> methods) {
        out.append("TN:\nSF:./").append(source).append('\n');
        int methodsHit = 0;
        for (Method method : methods) {
            out.append("FN:").append(method.line).append(',').append(method.name).append('\n');
        }
        for (Method method : methods) {
            out.append("FNDA:").append(method.ran ? 1 : 0).append(',').append(method.name).append('\n');
            methodsHit += method.ran ? 1 : 0;
        }
        out.append("FNF:").append(methods.size()).append("\nFNH:").append(methodsHit).append('\n');
        int lines = 0;
        int linesHit = 0;
        int branches = 0;
        int branchesHit = 0;
        StringBuilder lineRecords = new StringBuilder();
        for (int number = file.getFirstLine(); number != ISourceNode.UNKNOWN_LINE && number <= file.getLastLine(); number++) {
            ILine line = file.getLine(number);
            if (line.getStatus() == ICounter.EMPTY) {
                continue;
            }
            boolean ran = line.getInstructionCounter().getCoveredCount() > 0;
            ICounter arms = line.getBranchCounter();
            for (int arm = 0; arm < arms.getTotalCount(); arm++) {
                boolean taken = arm < arms.getCoveredCount();
                out.append("BRDA:").append(number).append(",0,").append(arm).append(',').append(ran ? (taken ? "1" : "0") : "-").append('\n');
                branches++;
                branchesHit += taken ? 1 : 0;
            }
            lineRecords.append("DA:").append(number).append(',').append(ran ? 1 : 0).append('\n');
            lines++;
            linesHit += ran ? 1 : 0;
        }
        out.append("BRF:").append(branches).append("\nBRH:").append(branchesHit).append('\n');
        out.append(lineRecords);
        out.append("LF:").append(lines).append("\nLH:").append(linesHit).append("\nend_of_record\n");
    }
}
