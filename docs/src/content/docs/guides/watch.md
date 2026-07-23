---
title: Watch mode & dev servers
description: Rebuild, retest, relaunch, and serve automatically as your sources change with fabr's -w flag.
---

Add **`-w`** to a command and fabr keeps running: it watches the files your targets actually depend
on and reacts whenever they change, until you stop it with Ctrl-C. Because fabr already knows the
exact input set of every target, watch mode is precise — only the work whose inputs changed re-runs;
everything else stays a cache hit.

`-w` applies to the graph-building verbs (`build`, `test`) and to `run`. A burst of edits (an editor
saving several files at once) is coalesced before fabr reacts, so a multi-file save triggers one
rebuild, not several.

## Rebuild and retest on change

```sh
fabr build -w mylib     # recompile whenever a source changes
fabr test -w mylib      # recompile and re-run the tests on every change
```

Each cycle reports what it rebuilt; an unchanged run reports nothing new. `fabr test -w` reprints the
per-target report summary each time, so you get a live red/green as you edit.

## Relaunch a program on change

For a runnable target, `-w` **restages and relaunches** the program when its inputs change:

```sh
fabr run -w mytool --flag arg
```

Fabr rebuilds the install, stops the old process, and starts the new one with the same arguments and
inherited stdio. This is the basic dev loop for a CLI or a long-running program you're editing.

## Dev servers with `serve`

A [`serve`](/reference/standard-rules/#serve) target describes a **long-lived server plus the content
it serves** — the shape that gets the most out of `-w`. It decorates any runnable (`tool`) with the
files it should serve (`files`) and any extra support files (`deps`):

```
serve site {
  tool  = @npm:http-server:14.1.1;   # any runnable: a script, a js_script, or an external bin
  files = mysite;                    # the built content to serve
  args  = -c-1 .;                    # http-server: disable caching so edits show on reload
}
```

```sh
fabr run -w site
```

Under `-w`, fabr distinguishes two kinds of change and reacts to each as cheaply as it can:

- **A content-only change** (something in `files`) is **synced into the running server's directory in
  place** — no restart. Fabr reports `Updating site content (N files)`, and the server's own file
  watcher picks up the change. This keeps a live-reload dev server fast: editing served content never
  bounces the process.
- **A change to the program itself** — `tool`, `deps`, or `args` — **restarts** the server, since the
  running install is no longer the right one.

Unlike a plain `fabr run` (which launches in *your* current directory), a `serve` target launches
with its working directory at its own staged install, so a stock static file server serves `files`
with no path wrangling.

Fabr's own documentation site is built and previewed exactly this way — a [`generate`](/reference/standard-rules/#generate)
target produces the static site, and a `serve` target runs `http-server` over it under `fabr run -w`.
