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

/**
 * A reader for the XML documents a Maven repository publishes (POMs,
 * `maven-metadata.xml`), over the `sax` parser: elements and their text.
 * Attributes, namespaces and processing instructions are read past and not
 * kept; a DOCTYPE with an internal subset is refused. The XHTML entities
 * (`&nbsp;`) are read, as Maven's own POM reader reads them.
 */

import * as sax from "sax";
import { FabrError } from "@fabr-build/core";

export interface XmlElement {
  /** The element's name, without any namespace prefix. */
  readonly name: string;
  readonly children: readonly XmlElement[];
  /** The element's own text, trimmed (its children's text excluded). */
  readonly text: string;
}

/** An element being read: its children and text so far. */
interface OpenElement {
  readonly name: string;
  readonly children: XmlElement[];
  readonly text: string[];
}

/** Parse an XML document into its root element. Throws, naming `what` and the
 *  line, on a document that is not well formed. */
export function parseXml(text: string, what: string): XmlElement {
  const parser = sax.parser(true, { position: true });
  const fail = (message: string): never => {
    throw new FabrError(`${what} is not well-formed XML (line ${parser.line + 1}): ${message}`);
  };
  const open: OpenElement[] = [];
  let root: XmlElement | undefined;
  parser.onerror = err => fail(err.message.split("\n")[0]);
  parser.ondoctype = doctype => {
    if (doctype.includes("[")) {
      fail("a DOCTYPE with an internal subset is not supported");
    }
  };
  parser.onopentag = tag => {
    if (root !== undefined) {
      fail("content after the root element");
    }
    open.push({ name: tag.name.substring(tag.name.indexOf(":") + 1), children: [], text: [] });
  };
  parser.ontext = data => open[open.length - 1]?.text.push(data);
  parser.oncdata = data => open[open.length - 1]?.text.push(data);
  parser.onclosetag = () => {
    const closed = open.pop()!;
    const element: XmlElement = { name: closed.name, children: closed.children, text: closed.text.join("").trim() };
    if (open.length === 0) {
      root = element;
    } else {
      open[open.length - 1].children.push(element);
    }
  };
  parser.write(text).close();
  return root ?? fail("the document has no root element");
}

/** @return the first child of `element` named `name`, or undefined. */
export function xmlChild(element: XmlElement | undefined, name: string): XmlElement | undefined {
  return element?.children.find(child => child.name === name);
}

/** @return the children of `element` named `name`. */
export function xmlChildren(element: XmlElement | undefined, name: string): XmlElement[] {
  return element?.children.filter(child => child.name === name) ?? [];
}

/** @return the text of the first child of `element` named `name`, or undefined
 *  where there is none or it is empty. */
export function xmlText(element: XmlElement | undefined, name: string): string | undefined {
  const text = xmlChild(element, name)?.text;
  return text === undefined || text === "" ? undefined : text;
}
