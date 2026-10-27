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

import java.io.IOException;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

import org.junit.platform.engine.TestExecutionResult;
import org.junit.platform.engine.TestSource;
import org.junit.platform.engine.discovery.DiscoverySelectors;
import org.junit.platform.engine.support.descriptor.ClassSource;
import org.junit.platform.engine.support.descriptor.MethodSource;
import org.junit.platform.launcher.Launcher;
import org.junit.platform.launcher.LauncherDiscoveryRequest;
import org.junit.platform.launcher.TestExecutionListener;
import org.junit.platform.launcher.TestIdentifier;
import org.junit.platform.launcher.TestPlan;
import org.junit.platform.launcher.core.LauncherDiscoveryRequestBuilder;
import org.junit.platform.launcher.core.LauncherFactory;

/**
 * Run the tests in directories of classes on the JUnit Platform and write
 * what happened as a CTRF report, as fabr's test runners do:
 *
 *     Runner --report=<file> [--sources=<file>] --scan=<directory>...
 *
 * Each directory is searched for test classes, and must be on the classpath.
 * The sources file has a line per class, its name and its source path
 * separated by a tab; a result is named by the source path of its class. The
 * exit status is 1 where a test failed, or where no test was found.
 */
public final class Runner {
    private Runner() {}

    public static void main(String[] args) throws IOException {
        String report = null;
        Map<String, String> sources = new HashMap<>();
        Set<Path> roots = new HashSet<>();
        for (String arg : args) {
            if (arg.startsWith("--report=")) {
                report = arg.substring("--report=".length());
            } else if (arg.startsWith("--sources=")) {
                for (String line : Files.readAllLines(Paths.get(arg.substring("--sources=".length())), StandardCharsets.UTF_8)) {
                    int tab = line.indexOf('\t');
                    if (tab > 0) {
                        sources.put(line.substring(0, tab), line.substring(tab + 1));
                    }
                }
            } else if (arg.startsWith("--scan=")) {
                roots.add(Paths.get(arg.substring("--scan=".length())).toAbsolutePath());
            } else {
                System.err.println("fabr-junit-runner: unknown argument " + arg);
                System.exit(2);
            }
        }
        if (report == null) {
            System.err.println("fabr-junit-runner: --report=<file> is required");
            System.exit(2);
        }
        Results results = null;
        long start = System.currentTimeMillis();
        try {
            results = new Results(sources);
            LauncherDiscoveryRequest request = LauncherDiscoveryRequestBuilder.request().selectors(DiscoverySelectors.selectClasspathRoots(roots)).build();
            Launcher launcher = LauncherFactory.create();
            launcher.execute(request, results);
        } catch (NoClassDefFoundError missing) {
            System.err.println("fabr-junit-runner: the JUnit Platform launcher is not on the classpath (" + missing.getMessage()
                + "): add org.junit.platform:junit-platform-launcher, of the tests' JUnit release, to test_deps");
            System.exit(2);
        }
        long stop = System.currentTimeMillis();
        Files.write(Paths.get(report), results.toCtrf(start, stop).getBytes(StandardCharsets.UTF_8));
        if (results.tests.isEmpty()) {
            /* The tests compiled, so finding none means no engine could run them. */
            System.err.println("fabr-junit-runner: no tests were found: no test engine on the classpath found a test among the classes in " + roots);
            System.exit(1);
        }
        System.exit(results.failed > 0 ? 1 : 0);
    }

    /** The outcome of each test the run reached, in the order they finished. */
    private static final class Results implements TestExecutionListener {
        private final Map<String, String> sources;
        private final Map<String, Long> started = new HashMap<>();
        private final List<String> tests = new ArrayList<>();
        private TestPlan plan;
        int passed;
        int failed;
        int skipped;

        Results(Map<String, String> sources) {
            this.sources = sources;
        }

        @Override
        public void testPlanExecutionStarted(TestPlan testPlan) {
            plan = testPlan;
        }

        @Override
        public void executionStarted(TestIdentifier id) {
            started.put(id.getUniqueId(), System.currentTimeMillis());
        }

        @Override
        public void executionSkipped(TestIdentifier id, String reason) {
            /* A skipped container's tests are not reported one by one: each is skipped with it. */
            List<TestIdentifier> skippedTests = id.isTest()
                ? List.of(id)
                : plan.getDescendants(id).stream().filter(TestIdentifier::isTest).collect(Collectors.toList());
            for (TestIdentifier test : skippedTests) {
                add(test, "skipped", 0, null, null);
                skipped++;
            }
        }

        @Override
        public void executionFinished(TestIdentifier id, TestExecutionResult result) {
            long duration = System.currentTimeMillis() - started.getOrDefault(id.getUniqueId(), System.currentTimeMillis());
            Optional<Throwable> thrown = result.getThrowable();
            switch (result.getStatus()) {
                case SUCCESSFUL:
                    if (id.isTest()) {
                        add(id, "passed", duration, null, null);
                        passed++;
                    }
                    break;
                case ABORTED:
                    if (id.isTest()) {
                        add(id, "skipped", duration, thrown.map(Runner::summary).orElse(null), null);
                        skipped++;
                    }
                    break;
                case FAILED:
                    /* A container that failed (a class that would not load, a failing
                     * @BeforeAll) is reported as a failure of its own: its tests may
                     * never have run. */
                    add(id, "failed", duration, thrown.map(Runner::summary).orElse("failed"), thrown.map(Runner::trace).orElse(null));
                    failed++;
                    break;
                default:
                    break;
            }
        }

        private void add(TestIdentifier id, String status, long duration, String message, String trace) {
            StringBuilder json = new StringBuilder("{");
            field(json, "name", id.getDisplayName()).append(',');
            field(json, "status", status).append(',');
            json.append("\"duration\":").append(duration);
            String file = sourceOf(id);
            if (file != null) {
                field(json.append(','), "filePath", file);
            }
            if (message != null) {
                field(json.append(','), "message", message);
            }
            if (trace != null) {
                field(json.append(','), "trace", trace);
            }
            tests.add(json.append('}').toString());
        }

        /** @return the source path of the class `id` is in, or null where none is known. */
        private String sourceOf(TestIdentifier id) {
            TestSource source = id.getSource().orElse(null);
            String className = source instanceof MethodSource ? ((MethodSource) source).getClassName()
                : source instanceof ClassSource ? ((ClassSource) source).getClassName()
                : null;
            if (className == null) {
                return null;
            }
            int nested = className.indexOf('$');
            return sources.get(nested < 0 ? className : className.substring(0, nested));
        }

        String toCtrf(long start, long stop) {
            StringBuilder json = new StringBuilder("{\"results\":{\"tool\":{\"name\":\"fabr-junit-runner\"},\"summary\":{");
            json.append("\"tests\":").append(tests.size());
            json.append(",\"passed\":").append(passed);
            json.append(",\"failed\":").append(failed);
            json.append(",\"pending\":0");
            json.append(",\"skipped\":").append(skipped);
            json.append(",\"other\":0");
            json.append(",\"start\":").append(start);
            json.append(",\"stop\":").append(stop);
            json.append("},\"tests\":[").append(String.join(",", tests)).append("]}}\n");
            return json.toString();
        }
    }

    /** @return the one line saying what `thrown` is. */
    private static String summary(Throwable thrown) {
        String text = thrown.toString();
        int newline = text.indexOf('\n');
        return newline < 0 ? text : text.substring(0, newline);
    }

    private static String trace(Throwable thrown) {
        StringWriter out = new StringWriter();
        thrown.printStackTrace(new PrintWriter(out));
        return out.toString();
    }

    /** Append `"name":"value"` to `json`, the value escaped as a JSON string. */
    private static StringBuilder field(StringBuilder json, String name, String value) {
        json.append('"').append(name).append("\":\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"':
                    json.append("\\\"");
                    break;
                case '\\':
                    json.append("\\\\");
                    break;
                case '\n':
                    json.append("\\n");
                    break;
                case '\r':
                    json.append("\\r");
                    break;
                case '\t':
                    json.append("\\t");
                    break;
                default:
                    if (c < 0x20) {
                        json.append(String.format("\\u%04x", (int) c));
                    } else {
                        json.append(c);
                    }
            }
        }
        return json.append('"');
    }
}
