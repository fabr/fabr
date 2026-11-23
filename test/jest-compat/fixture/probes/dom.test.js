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

const { probe, attempt } = require("./lib/probe");

it("runs an inline script", () => {
  const script = document.createElement("script");
  script.textContent = "window.__inline = 42;";
  document.body.appendChild(script);
  probe("dom.inline-script", { ran: window.__inline === 42, eval: attempt(() => window.eval("1 + 1")) });
});

it("describes the window", () => {
  probe("dom.window", {
    href: location.href, userAgent: navigator.userAgent.replace(/jsdom\/[\d.]+/, "jsdom/X").replace(/\((darwin|linux|win32)\)/, "(os)"),
    language: navigator.language, innerWidth, innerHeight, devicePixelRatio,
    globalIsWindow: globalThis === window, selfIsWindow: self === window, defaultView: document.defaultView === window,
    topIsWindow: window.top === window, doctype: document.doctype && document.doctype.name, html: document.documentElement.outerHTML,
    matchMedia: typeof window.matchMedia, IntersectionObserver: typeof IntersectionObserver, ResizeObserver: typeof ResizeObserver,
    scrollIntoView: typeof HTMLElement.prototype.scrollIntoView, crypto: typeof crypto, randomUUID: typeof (crypto && crypto.randomUUID),
    getRandomValues: typeof (crypto && crypto.getRandomValues), performanceMark: typeof performance.mark, timeOrigin: typeof performance.timeOrigin,
  });
});

it("stores and navigates", () => {
  localStorage.setItem("k", "v");
  document.cookie = "a=1";
  history.pushState({}, "", "/next?q=1#h");
  probe("dom.state", { storage: localStorage.getItem("k"), cookie: document.cookie, href: location.href, length: history.length });
});

it("redefines location", () => {
  probe("dom.location", attempt(() => { Object.defineProperty(window, "location", { value: { href: "http://x/" }, writable: true }); return window.location.href; }));
});

it("computes styles", () => {
  const el = document.createElement("div");
  el.style.color = "red";
  document.body.appendChild(el);
  probe("dom.style", { color: getComputedStyle(el).color, display: getComputedStyle(el).display });
});

it("crosses realms", () => {
  probe("dom.realms", {
    bufferIsUint8Array: Buffer.from("a") instanceof Uint8Array,
    utilEncoderIsUint8Array: new (require("util").TextEncoder)().encode("a") instanceof Uint8Array,
    jsonArray: JSON.parse("[]") instanceof Array,
    nodeError: (() => { try { require("fs").readFileSync("/no/such/file"); } catch (e) { return e instanceof Error; } })(),
    domError: (() => { try { document.querySelector("!!"); } catch (e) { return e instanceof Error && e.constructor.name; } })(),
    promiseIsPromise: Promise.resolve() instanceof Promise,
    asyncReturns: (async () => {})() instanceof Promise,
    eventIsEvent: new Event("x") instanceof Event,
    customEvent: new CustomEvent("x", { detail: 1 }).detail,
  });
});

it("describes the process", () => {
  probe("dom.process", {
    NODE_ENV: process.env.NODE_ENV, JEST_WORKER_ID: process.env.JEST_WORKER_ID, isRealProcess: process === require("process"),
    on: typeof process.on, platform: typeof process.platform, title: typeof process.title, browser: process.browser,
    moduleThis: this === module.exports, filename: typeof __filename, requireMain: require.main === module,
    globalGlobal: global === globalThis,
  });
});

it("reads and writes the document", () => {
  document.body.innerHTML = "<button id='b'>Go</button>";
  const clicks = [];
  document.getElementById("b").addEventListener("click", e => clicks.push([e.isTrusted, e.view === window, e.target.id]));
  document.getElementById("b").click();
  probe("dom.events", clicks);
});

it("shares globals between the test and a page script", () => {
  window.fromTest = { n: 1 };
  const script = document.createElement("script");
  script.textContent = "window.fromScript = fromTest.n + 1; fromTest.n = 5; function declared() { return 'declared'; }";
  document.body.appendChild(script);
  probe("dom.script-globals", { fromScript: window.fromScript, mutated: window.fromTest.n, declared: typeof declared === "function" ? declared() : typeof declared });
});

it("runs an inline event handler attribute", () => {
  document.body.innerHTML = "<button id='h' onclick='window.handled = (window.handled || 0) + 1'>x</button>";
  document.getElementById("h").click();
  probe("dom.handler-attribute", window.handled);
});
