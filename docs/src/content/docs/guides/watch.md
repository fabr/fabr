---
title: Watch mode & dev servers
description: Rebuild, retest, restart and serve automatically as your sources change, with fabr's -w option.
---

Add `-w` to `fabr build`, `fabr test` or `fabr run` and fabr keeps running: it watches the files
your targets are built from and redoes the affected work when one changes, until you stop it with
Ctrl-C.

Fabr already knows exactly which files each step of a build reads, so only the steps whose inputs
changed run again, and there is nothing to configure: no list of directories to watch or ignore.
Changes that arrive close together, as when an editor saves several files or a branch is switched,
are handled as one.

| Command | On a change |
|---|---|
| `fabr build -w <target>` | Rebuilds. |
| `fabr test -w <target>` | Rebuilds and re-runs the tests. |
| `fabr run -w <program>` | Rebuilds and restarts the program. |
| `fabr run -w <serve target>` | Updates the files being served, or restarts the server if the server itself changed. |

## Rebuild and retest on change

```sh
fabr build -w mylib     # recompile when a source changes
fabr test -w mylib      # recompile and re-run the tests
```

Each round prints what it rebuilt, and `fabr test -w` prints the test summary again, so the
terminal shows whether the tests pass as you edit. A change that affects nothing, such as an edit
to a file no target uses, prints nothing.

Editing a build file takes effect in the same way as editing a source.

## Restart a program on change

```sh
fabr run -w mytool --flag arg
```

When something the program is built from changes, fabr rebuilds it, stops the running process and
starts the new one with the same arguments. Stopping includes any processes the program started
itself.

## Dev servers with `serve`

A [`serve`](/reference/standard-rules/#serve) target describes a long-running server together
with the files it serves. Any program fabr can run will do as the server:

```
serve site {
  tool  = @npm:http-server:14.1.1;   # the server: a package, a script or a js_script
  files = mysite;                    # what to serve: here, the output of the mysite target
  args  = -c-1 .;                    # http-server options: no caching, serve this directory
}
```

```sh
fabr run -w site
```

The server starts in a directory that contains `files`, which is why `.` is the right path to
serve. This differs from other programs, which `fabr run` starts in your current directory.

Under `-w`, fabr treats the two parts of the target differently:

- **When the served files change**, fabr updates them in the directory the server is running in,
  and prints `Updating site content (N files)`. The server isn't restarted. Each file is replaced
  in one step, so the server never reads half of one, and a server that watches its directory
  sees the change as it would any other.
- **When the server changes**, meaning its `tool`, `deps`, `args` or `env`, fabr restarts it.

### Environment variables

A server starts with the environment you ran `fabr` in. Give the target an `env` map to add
variables or replace ones your shell sets:

```
serve site {
  tool  = site_server;
  files = mysite;
  env   = { NODE_ENV = development; PORT = 8080; }
}
```

A [`generate`](/reference/standard-rules/#generate) target has `env` too, with a difference: its
commands are build steps and start with no environment, so the variables in `env` are the only
ones they have.

### An example

Fabr's own documentation site is built and previewed this way. A `generate` target runs the site
generator to produce the static site, and a `serve` target runs `http-server` over the result:

```
generate docs_site {
  srcs = ./src/** ./public/** ./astro.config.mjs;
  run = astro build;
  output = dist:**;
}

serve docs_serve {
  tool = @npm:http-server:14.1.1;
  files = docs_site;
  args = -c-1 .;
}
```

With `fabr run -w docs_serve` running, saving a page rebuilds the site and updates the served
files.

## Stopping

Ctrl-C stops fabr and the program it is running. If fabr itself is killed with `SIGKILL`, the
program is left running; see
[Known limitations](/known-limitations/#watch-mode-can-leave-a-program-running-if-fabr-is-force-killed).
