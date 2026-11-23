---
title: The fabr socket
description: The channel from a build step's processes back to the fabr that started them, and the process slots they take through it — how a client connects, identifies itself, asks for slots and gives them back, and how it compares with GNU make's jobserver.
---

Every process fabr starts as a build step (a compiler, a test runner, a `generate` command) can talk
back to the fabr that started it, through the **fabr socket**: a local socket, named in the
process's environment as `FABR_SOCKET`, that speaks JSON-RPC 2.0 framed as the Language Server
Protocol frames it. Today it serves one thing, **process slots**: a way for a process to ask for
more of fabr's limit on how many processes run at once.

You need this page only if you write a tool that fabr runs and that starts worker
processes of its own. Fabr's runner for Playwright uses it already: each Playwright worker takes two slots while it
runs tests.

## Process slots

Fabr runs as many processes at once as the machine has processors, and each build step holds one of
those **slots** while its process runs. A process fabr starts owns one slot, from when it starts
until it exits, without asking for it. A tool that starts worker processes of its own is still one
step holding that one slot, however many workers it starts. Through the socket, a worker asks for
a further slot while it works, so the tool's workers and every other step share the one limit.

### Compared with GNU make's jobserver

Process slots do the same job as GNU make's
[jobserver](https://www.gnu.org/software/make/manual/html_node/Job-Slots.html), with the request
and release made explicit, as in the extended protocol proposed for opam
([Spec for GNU make jobserver support](https://github.com/ocaml/opam/wiki/Spec-for-GNU-make-jobserver-support)):

|                                   | GNU make's jobserver                             | The fabr socket                                                        |
| --------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------- |
| How a client finds it             | `MAKEFLAGS=--jobserver-auth=…`: a pipe or a FIFO | `FABR_SOCKET=<path>#<token>`: a Unix-domain socket, or a named pipe on Windows |
| Take a slot                       | Read a token byte from the pipe                  | Send a `slots/acquire` request, answered when the slot is granted      |
| Give it back                      | Write the token byte back                        | Send `slots/release`, or close the connection                          |
| A client that dies holding a slot | Its token is lost for the rest of the run        | Its connection closes, which gives its slots back                      |
| The slot a job already has        | Each job has one implicit token                  | The process fabr started owns one slot; the first request is lent it   |

Every slot is granted on a connection, so whatever ends the client, including a crash or a kill,
also gives back its slots.

## Connecting

### Finding the socket

Fabr sets `FABR_SOCKET` in the environment of every process it starts as a build step, as
`<path>#<token>`:

- **`<path>`** is the socket: a Unix-domain socket in a directory only your user can open, or a
  named pipe (`\\.\pipe\fabr-…`) on Windows. There is one per fabr process, for as long as it
  runs.
- **`<token>`** identifies the process fabr started, the build step. It is what files a
  connection under that step, so the step's owned slot can be lent to it, and fabr refuses a
  connection whose token it didn't give out.

The variable is passed on to whatever that process starts, so its workers find it in their own
environment. A program fabr runs outside a build step, under `fabr run` or `fabr shell`, has no
`FABR_SOCKET`, and a process that finds it unset or empty takes no slots and runs as it would
anywhere else.

Each process that wants slots opens a connection of its own. A process doesn't pass its connection
to the processes it starts; each that wants slots opens its own.

### Framing

The socket uses the framing and message format of the
[Build Server Protocol](https://build-server-protocol.github.io/docs/specification) (BSP), which
fabr already speaks to editors: every message is a
[JSON-RPC 2.0](https://www.jsonrpc.org/specification) message, framed as in the
[Language Server Protocol's base protocol](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#baseProtocol),
which BSP adopts: a `Content-Length` header giving the length of the body in bytes, a blank line,
then the body as UTF-8 JSON.

Fabr carries several protocols over one stream this way, a frame naming the protocol it belongs
to in a `Fabr-Protocol` header. On the socket, a frame with no `Fabr-Protocol` header belongs to the
socket's own protocol, the one this page describes, so a client sends none; it is the only
protocol the socket serves today.

```
Content-Length: 49\r\n
\r\n
{"jsonrpc":"2.0","id":1,"method":"slots/acquire"}
```

A request carries an `id` the client chooses, a string or a number, and is answered by a response
with the same `id`, which may come at once or much later; a notification (without one) isn't
answered. A connection may not reuse an `id` while a request with it is still in progress, or
while a `slots/acquire` with it still holds its slots: such a request is answered with error
`-32600`. A body that isn't JSON is answered with error `-32700`, and one that isn't a JSON-RPC
message, such as a batch (an array of messages), with error `-32600`, both with a `null` `id`. A
frame whose headers run past 8 KB, or whose body is over 1 MB, closes the connection.

### Initializing

The first request on a connection is `fabr/initialize`, giving the token:

```json
→ {"jsonrpc":"2.0","id":0,"method":"fabr/initialize","params":{"token":"3f9c…"}}
← {"jsonrpc":"2.0","id":0,"result":{"server":{"name":"fabr"},"protocol":1,"capabilities":{"slots":{}}}}
```

`protocol` is the version of this protocol the fabr speaks, `1` as this page describes it, and
`capabilities` lists the method families it serves: `slots`, today. Fabr ignores params it doesn't
know, so a client may send more, such as its own name.

A token fabr didn't give out, or one whose build step has finished, is answered with error
`-32602` (`unknown token`), and the connection stays uninitialized. Any other request before `fabr/initialize` is
answered with error `-32002`, and a second `fabr/initialize` on one connection with error
`-32600`.

## Methods

| Method            | Kind         | Params           | Meaning                                                                                  |
| ----------------- | ------------ | ---------------- | ---------------------------------------------------------------------------------------- |
| `slots/acquire`   | request      | `{"count": <n>}`, optional | Ask for `count` slots (1 by default), granted together. Answered with an empty result, `{}`, when they are granted. |
| `slots/release`   | notification | `{"id": <id>}`   | End the `slots/acquire` request the client sent with that `id`: give back its slots where it was granted, or withdraw it where it is still waiting, which answers it with error `-32800`. |
| `$/cancelRequest` | notification | `{"id": <id>}`   | Cancel a request still waiting. See [Cancelling a request](#cancelling-a-request). |

`count` is the number of slots the work about to start needs, such as 2 for a worker that drives a
browser, which is more than one process's work; a count is taken as at most one less than fabr's
limit, since the process already holds one slot, and one that isn't a whole number of 1 or more is answered with error `-32602`. A client may
send several `slots/acquire` requests without waiting for answers. Closing the
connection gives back every slot granted on it and withdraws every request not yet answered, so a
client that has finished doesn't need to release its slots first, and a client that crashes gives
them back the same way. A `slots/release` naming no request of the connection changes nothing. A request for a method fabr doesn't serve is answered
with error `-32601`.

### Cancelling a request

`$/cancelRequest` isn't fabr's own: it is the notification LSP defines for cancelling any request
still in progress
([Cancellation Support](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#cancelRequest)),
and fabr follows LSP's rules for it. Like every notification it gets no answer of its own; instead
the request it names is answered, with error `-32800` (LSP's `RequestCancelled`), so every request
still gets exactly one response. Fabr cancels only a `slots/acquire` still waiting; for one
already granted, or already answered, the notification changes nothing. `slots/release` withdraws
a waiting request the same way, so a client giving up on a slot can send `slots/release` whether
or not the grant has arrived.

### How slots are granted

- **The process's own slot first.** The process fabr started owns one slot already, and doesn't ask
  for it. A tool that hands all its work to workers would leave that slot idle, so fabr lends it to
  the first `slots/acquire` on any of the step's connections, before it takes any slot from its
  limit, and to the oldest waiting request whenever it is given back. So a tool's workers always
  have one slot to work with, and never wait on other steps to start. The stages of a `generate`
  command's pipeline are one build step, and share its one slot.
- **Further slots from fabr's limit.** Each further request waits for its `count` of slots of
  fabr's limit, beside every other step's work, and is granted once that many are free, taking
  them together. The process's own slot, lent to a request, counts as all the slots it asked
  for.
- **Oldest first.** A request waiting for several slots holds back those made after it, so it isn't
  passed over by smaller ones. A step's requests are granted in the order they were made, across all of its
  connections.
- **The end of the step.** When the process fabr started exits, fabr closes every connection made
  with its token and takes back every slot they hold. A client whose connection fabr closes should
  stop work.

### What a client should do

The rule that keeps every build progressing: **a client must be able to finish its work with the
slots it already has.** A further slot is extra capacity, never something a client waits for before
it can go on; fabr's lending of the process's own slot depends on it.

- **Hold a slot only while there's work for it.** Ask before starting work and give the slot back
  as soon as there's none left: a client waiting idle while holding a slot keeps it from every
  other step.
- **Have the workers ask, and not the process that waits for them.** A process that starts
  workers and then waits on them doesn't ask for a slot itself: if it were lent the process's own
  slot, its workers could wait on fabr's limit for one that never comes free. The process's own
  slot goes to the first worker to ask instead.
- **Ask for what each piece of work needs in one request.** A worker that needs two slots asks for
  `count: 2` and starts once it has them. A client that asks for them one request at a time, and
  waits for all before starting, can deadlock when another client does the same, since each holds
  some of what the other is waiting for.
- **Wait as long as the grant takes.** A grant may wait for other steps to finish, so don't time
  the wait out.
- **Run without a slot where there's none to take.** If the socket can't be reached, or refuses the
  connection, carry on without one, as a GNU make job does without a jobserver.

## Example client

A Node.js worker that takes a slot before it starts and gives it back by exiting:

```js
const net = require("node:net");

/** Write a JSON-RPC message, framed with its Content-Length. */
function send(socket, message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
  socket.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
}

/** Take a process slot where fabr offers its socket: resolve with the connection once it is granted, or with nothing where it can't be had. */
function takeSlot() {
  const variable = process.env.FABR_SOCKET;
  if (!variable) {
    return Promise.resolve(undefined); // not run by fabr as a build step
  }
  const hash = variable.lastIndexOf("#");
  return new Promise(resolve => {
    const socket = net.connect(variable.slice(0, hash), () => {
      send(socket, { id: 0, method: "fabr/initialize", params: { token: variable.slice(hash + 1) } });
      send(socket, { id: 1, method: "slots/acquire" });
    });
    let buffered = Buffer.alloc(0);
    socket.on("data", bytes => {
      buffered = Buffer.concat([buffered, bytes]);
      for (;;) {
        const end = buffered.indexOf("\r\n\r\n");
        const length = end < 0 ? NaN : Number(/content-length:\s*(\d+)/i.exec(buffered.subarray(0, end))?.[1]);
        if (end < 0 || buffered.length < end + 4 + length) return;
        const message = JSON.parse(buffered.subarray(end + 4, end + 4 + length));
        buffered = buffered.subarray(end + 4 + length);
        if (message.error) socket.destroy(); // refused: run without a slot
        else if (message.id === 1) resolve(socket); // the slot is granted
      }
    });
    socket.on("close", () => resolve(undefined)); // no slot to be had: run without one
    socket.on("error", () => {}); // reported by "close"
  });
}

async function main() {
  const slot = await takeSlot();
  try {
    await doTheWork();
  } finally {
    slot?.end(); // closing gives the slot back
  }
}
```

## Known issues

- **A process that is alive but stuck keeps its slots.** A slot is held while its connection is
  open, not while work is done, so a hung worker holds its slot until it exits or fabr's step ends.
- **On Windows, any user of the machine can connect to the named pipe.** Only a process holding
  one of fabr's tokens can take slots, but another user's process can connect and be refused.
- **The environment of a build step includes `FABR_SOCKET`.** A tool that writes its whole
  environment into its output produces different output on each run, since the token is new each
  time.
