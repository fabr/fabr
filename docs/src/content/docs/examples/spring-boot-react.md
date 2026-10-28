---
title: A Spring Boot server with a React front end
description: A worked example of one fabr project that builds a React single-page application and a Spring Boot server that serves it, runs both in development, and packs them into one executable jar.
---

This example builds a small web application in one fabr project: a React single-page application
written in TypeScript, and a Spring Boot server that provides its API and serves its files. One
command builds both, `fabr run -w` restarts the server with a fresh bundle as you edit either half,
and a release build packs the lot into one executable jar for `java -jar`.

It assumes you have read the [Java](/quickstart-java/) and [JavaScript](/quickstart-js/) quick
starts, and installed fabr with the Java plugin:

```sh
npm install -g @fabr-build/cli @fabr-build/java
```

## The project

```
PROJECT.fabr
frontend/
  BUILD.fabr
  public/index.html
  src/main.tsx
  src/App.tsx
  src/main.css
backend/
  BUILD.fabr
  src/main/java/com/example/shop/ShopApplication.java
  src/main/java/com/example/shop/GreetingController.java
  src/main/resources/application.properties
```

`PROJECT.fabr` uses both plugins, sets what the two halves are compiled for, and includes each
half's build file:

```
plugin @fabr-build/java;
plugin @fabr-build/js;

JVM_TARGET = jvm21;
JS_TARGET = es2022-esm-browser;

include ./frontend/BUILD.fabr;
include ./backend/BUILD.fabr;
```

`JVM_TARGET` is the Java release the server's classes are compiled for, and `JS_TARGET` says the
bundle is an ES module for browsers. Each setting is read only by the targets of its own language.

## The front end

`frontend/BUILD.fabr` declares the bundle:

```
js_bundle web {
  entry = src:main.tsx;
  srcs = src:** dom
         @npm:react:19.3.1 @npm:react-dom:19.3.1
         @npm:@types/react:19.3.0 @npm:@types/react-dom:19.3.0;
}
```

`srcs` lists what may go into the bundle: your sources, the `dom` flag, which gives TypeScript the
browser's types, and the packages to build in. The sources are type-checked by the TypeScript
compiler before esbuild bundles them, so a type error fails the build.

`frontend/src/main.tsx` mounts the application:

```tsx
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./main.css";

createRoot(document.getElementById("root")!).render(<App />);
```

`frontend/src/App.tsx` calls the server's API with a path relative to the page, which works
because the same server serves both:

```tsx
import { useState } from "react";

export function App() {
  const [name, setName] = useState("");
  const [greeting, setGreeting] = useState<string>();

  async function greet() {
    const response = await fetch(`/api/greeting?name=${encodeURIComponent(name)}`);
    const body: { message: string } = await response.json();
    setGreeting(body.message);
  }

  return (
    <main>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
      <button onClick={greet}>Greet</button>
      {greeting && <p>{greeting}</p>}
    </main>
  );
}
```

`frontend/src/main.css` is any stylesheet; the bundle collects the CSS the entry imports into
`main.css`:

```css
body { font-family: system-ui, sans-serif; margin: 2rem; }
```

The bundle produces `main.js`, `main.css` and, in a debug build, their source maps, and nothing
writes an HTML page for you. `frontend/public/index.html` is written by hand and loads the two files
from an `assets/` directory beside it:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Greeter</title>
    <link rel="stylesheet" href="assets/main.css">
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="assets/main.js"></script>
  </body>
</html>
```

You can build the bundle on its own and look at it:

```sh
fabr build web
fabr ls web        # main.css, main.css.map, main.js, main.js.map
```

## The server

`backend/BUILD.fabr` declares the server as a `jar_package`:

```
jar_package server {
  srcs = src/main/java:**/*.java;
  resources = src/main/resources:**
              ../frontend/public:** -> static/**
              web:** -> static/assets/**;
  deps = @mvn:org.springframework.boot:spring-boot-dependencies:4.1.2
         @mvn:org.springframework.boot:spring-boot-starter-webmvc
         java21;
  main_class = com.example.shop.ShopApplication;
}
```

`deps` starts with Spring Boot's bill of materials, which gives the version of the starter after
it; see [BOMs](/reference/java/dependencies/#boms). `java21` says the sources are written for Java 21.

The `resources` are where the two halves meet. Spring Boot serves the files it finds under
`static/` on the classpath, and serves `static/index.html` at `/`. So the resources put:

| In the jar | From |
|---|---|
| `application.properties` | `src/main/resources:**`, the usual Spring Boot resources. |
| `static/index.html` | `../frontend/public:** -> static/**`: the page, renamed under `static/`. |
| `static/assets/main.js`, `main.css`, … | `web:** -> static/assets/**`: every file the `web` bundle produces. |

`web` is the bundle's target name, so building the server builds the bundle first, and a change to
the front end's sources changes the jar. Each `-> static/**` is a
[rename](/reference/syntax/#projection-and-renaming): the files the left side selects, each placed
under the new prefix.

The Java sources are an ordinary Spring Boot application. `ShopApplication.java`:

```java
package com.example.shop;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class ShopApplication {
    public static void main(String[] args) {
        SpringApplication.run(ShopApplication.class, args);
    }
}
```

and `GreetingController.java`:

```java
package com.example.shop;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class GreetingController {
    public record Greeting(String message) {}

    @GetMapping("/api/greeting")
    public Greeting greeting(@RequestParam(defaultValue = "world") String name) {
        return new Greeting("Hello, " + name + "!");
    }
}
```

`@RequestParam` finds the `name` query parameter by the Java parameter's name, which works because
fabr compiles with `javac -parameters`; see
[Parameter names](/reference/java/compiling/#parameter-names).

`src/main/resources/application.properties` holds the application's settings:

```
spring.application.name=shop
```

## Running it during development

```sh
fabr run -w server
```

fabr builds the bundle and the server and starts `ShopApplication` with the jar and its
dependencies on the classpath. Open `http://localhost:8080/`, type a name and press **Greet**.

Arguments after the target name go to the application, so Spring Boot's own options work as
usual: `fabr run -w server --server.port=9090`.

With `-w`, fabr keeps watching the sources of both halves. When you save a change to `App.tsx`, it
recompiles and rebundles the front end, rebuilds the jar and restarts the server; a change to a
Java source recompiles the server and restarts it. Reload the page to see the change: nothing
tells the browser. A build error is reported and the running server is left as it was until the
change that fixes it. [Watch mode & dev servers](/guides/watch/#restart-a-program-on-change)
describes the restart.

Each change to the front end restarts the JVM, since the files are inside the jar. That costs the
application's start-up time, about a second for this one; for a larger application, you can work
on the front end against a server you leave running with a separate
[`serve`](/reference/js/bundling/#serving-a-bundle-during-development) target, which replaces the
files it serves without a restart.

## Building for deployment

`fabr run` starts the server from its jar and its dependencies' jars, which suits development. To
deploy, you usually want Spring Boot's executable jar: one file holding the application and every
jar it needs, started with `java -jar`. With Maven or Gradle, Spring Boot's own plugin
(`spring-boot-maven-plugin`, or the `bootJar` task) builds it. fabr has no built-in rule for that
layout, so the declarations below take the plugin's place: a rule, written in your build file out of
a `java_installation` and a `jar_package`, that builds the layout for any target of a new
`boot_jar` type.
[A layout of your own](/reference/java/packaging/#a-layout-of-your-own-spring-boot) explains the
layout; this version takes the `server` jar as it is, so that the deployable jar is built from
exactly what you run in development. Add to `backend/BUILD.fabr`:

```
targetdef boot_jar {
    # The application: a jar_package, with everything it requires.
    app = PACKAGES;
    # The application's main class.
    main_class = REQUIRED STRING;
    # The Spring Boot loader: `spring-boot-loader`, of the application's Spring Boot release.
    loader = PACKAGES;
}

rule boot_jar b<BUILD_OPERATION=build> = jar {
    java_installation libs {
        deps = b.app;
    }
    jar_package jar {
        resources = libs:** -> BOOT-INF/lib/** b.loader:*.jar:org/**;
        manifest = {
            Main-Class = org.springframework.boot.loader.launch.JarLauncher;
            Start-Class = ${b.main_class};
            Spring-Boot-Lib = BOOT-INF/lib/;
        };
    }
}

boot_jar shop {
    app = server;
    main_class = com.example.shop.ShopApplication;
    loader = @mvn:org.springframework.boot:spring-boot-loader:4.1.2;
}
```

- `java_installation libs` is `server.jar` and the jar of everything it requires, which the rename
  places under `BOOT-INF/lib/`, stored uncompressed so that Spring Boot can read them in place. The
  application's classes and static files are in `BOOT-INF/lib/server.jar`, where Spring Boot finds
  them as it would under `BOOT-INF/classes/`.
- `b.loader:*.jar:org/**` reads inside the loader's jar and puts its classes at the root of the
  executable jar, where the manifest's `JarLauncher` starts them.

Build it as a release build, which minifies the bundle and leaves out its source maps:

```sh
fabr build -DBUILD_TYPE=release shop
fabr cp -DBUILD_TYPE=release shop ./dist      # writes ./dist/shop/shop.jar
java -jar dist/shop/shop.jar
```

`-DBUILD_TYPE=release` applies to everything `shop` is built from, the bundle included. The jar
runs on any Java 21 or later.

## Next steps

- [Bundling](/reference/js/bundling/): assets, constants with `defines`, and what a bundle doesn't
  support, such as code splitting.
- [Testing](/reference/java/testing/) and [JavaScript testing](/reference/js/testing/): add `tests`
  to the server and a `js_test` for the front end, and run both with `fabr test`.
- [Projects with several packages](/guides/multi-package/): sharing versions and settings as the
  project grows.
- [Writing your own rules](/guides/rules/): how the `boot_jar` rule works.
