/*
 * A small, strict XML reader and writer, for BPMN 2.0 files (design §6.10). It resolves
 * namespaces, and it refuses a DOCTYPE and any entity but XML's own five and character
 * references: a BPMN file needs neither, and refusing them rules out entity expansion and
 * external entities by construction.
 */

export interface XmlAttribute {
  readonly ns: string | null;
  readonly local: string;
  readonly value: string;
}

export interface XmlElement {
  /** The namespace URI, or null for none. */
  readonly ns: string | null;
  readonly local: string;
  readonly attributes: readonly XmlAttribute[];
  readonly children: readonly XmlNode[];
}

export type XmlNode = XmlElement | string;

export class XmlError extends Error {}

export const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const MAX_LENGTH = 5_000_000;
const MAX_DEPTH = 100;
const MAX_ELEMENTS = 100_000;
const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;

const ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(text: string, where: number): string {
  return text.replace(/&([^;\s&]{1,10});/g, (_, entity: string) => {
    if (entity.startsWith('#x')) return codePoint(parseInt(entity.slice(2), 16), where);
    if (entity.startsWith('#')) return codePoint(parseInt(entity.slice(1), 10), where);
    const known = ENTITIES[entity];
    if (known === undefined) throw new XmlError(`Unknown entity &${entity}; at character ${where}`);
    return known;
  });
}

function codePoint(value: number, where: number): string {
  if (!Number.isInteger(value) || value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) throw new XmlError(`Not a character reference at character ${where}`);
  return String.fromCodePoint(value);
}

interface Open {
  readonly qname: string;
  readonly scope: ReadonlyMap<string, string>;
  readonly ns: string | null;
  readonly local: string;
  readonly attributes: XmlAttribute[];
  readonly children: XmlNode[];
}

function split(qname: string): [string | null, string] {
  const colon = qname.indexOf(':');
  return colon === -1 ? [null, qname] : [qname.slice(0, colon), qname.slice(colon + 1)];
}

/** Read an XML document into its root element, with namespaces resolved. */
export function parseXml(text: string): XmlElement {
  if (text.length > MAX_LENGTH) throw new XmlError('The file is too large');
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack: Open[] = [];
  let root: XmlElement | null = null;
  let elements = 0;

  const fail = (message: string): never => {
    throw new XmlError(`${message} at character ${at}`);
  };
  const skipUntil = (end: string, what: string) => {
    const found = text.indexOf(end, at);
    if (found === -1) fail(`An unclosed ${what}`);
    const inner = text.slice(at, found);
    at = found + end.length;
    return inner;
  };

  while (at < text.length) {
    const lt = text.indexOf('<', at);
    if (lt === -1 || lt > at) {
      const chunk = text.slice(at, lt === -1 ? text.length : lt);
      if (stack.length) stack.at(-1)!.children.push(decode(chunk, at));
      else if (chunk.trim()) fail('Text outside the root element');
      if (lt === -1) break;
      at = lt;
      continue;
    }
    if (text.startsWith('<!--', at)) {
      at += 4;
      skipUntil('-->', 'comment');
    } else if (text.startsWith('<![CDATA[', at)) {
      at += 9;
      const data = skipUntil(']]>', 'CDATA section');
      if (!stack.length) fail('Text outside the root element');
      stack.at(-1)!.children.push(data);
    } else if (text.startsWith('<?', at)) {
      at += 2;
      skipUntil('?>', 'processing instruction');
    } else if (text.startsWith('<!', at)) {
      fail('A DOCTYPE or declaration is not allowed');
    } else if (text.startsWith('</', at)) {
      at += 2;
      const close = text.indexOf('>', at);
      if (close === -1) fail('An unclosed end tag');
      const qname = text.slice(at, close).trim();
      const open = stack.pop();
      if (!open || open.qname !== qname) fail(`</${qname}> closes ${open ? `<${open.qname}>` : 'nothing'}`);
      at = close + 1;
      const element: XmlElement = { ns: open!.ns, local: open!.local, attributes: open!.attributes, children: open!.children };
      if (stack.length) stack.at(-1)!.children.push(element);
      else if (root) fail('A second root element');
      else root = element;
    } else {
      at += 1;
      const tag = /^([^\s/>]+)/.exec(text.slice(at, at + 300));
      if (!tag || !NAME.test(tag[1]!)) fail('A tag without a valid name');
      const qname = tag![1]!;
      at += qname.length;
      const raw: Array<[string, string]> = [];
      for (;;) {
        const space = /^\s*/.exec(text.slice(at, at + 1000))![0];
        at += space.length;
        if (text.startsWith('/>', at) || text.startsWith('>', at)) break;
        const attribute = /^([^\s=/>]+)\s*=\s*(["'])/.exec(text.slice(at, at + 400));
        if (!attribute || !NAME.test(attribute[1]!)) fail(`An attribute of <${qname}> without a valid name or value`);
        at += attribute![0].length;
        const quote = attribute![2]!;
        const end = text.indexOf(quote, at);
        if (end === -1) fail('An unclosed attribute value');
        const value = text.slice(at, end);
        if (value.includes('<')) fail('A < inside an attribute value');
        raw.push([attribute![1]!, decode(value.replace(/[\t\n\r]/g, ' '), at)]);
        at = end + 1;
      }
      const selfClosing = text.startsWith('/>', at);
      at += selfClosing ? 2 : 1;
      if (++elements > MAX_ELEMENTS) fail('Too many elements');
      if (stack.length >= MAX_DEPTH) fail('Elements nest too deep');

      const scope = new Map(stack.at(-1)?.scope ?? []);
      for (const [name, value] of raw) {
        if (name === 'xmlns') scope.set('', value);
        else if (name.startsWith('xmlns:')) scope.set(name.slice(6), value);
      }
      const resolve = (prefix: string | null, isAttribute: boolean): string | null => {
        if (prefix === null) return isAttribute ? null : (scope.get('') || null);
        if (prefix === 'xml') return XML_NAMESPACE;
        const uri = scope.get(prefix);
        if (uri === undefined) fail(`The prefix ${prefix} is not declared`);
        return uri!;
      };
      const [prefix, local] = split(qname);
      const attributes: XmlAttribute[] = [];
      const seen = new Set<string>();
      for (const [name, value] of raw) {
        if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
        const [attributePrefix, attributeLocal] = split(name);
        const ns = resolve(attributePrefix, true);
        const key = `${ns ?? ''} ${attributeLocal}`;
        if (seen.has(key)) fail(`<${qname}> repeats the attribute ${name}`);
        seen.add(key);
        attributes.push({ ns, local: attributeLocal, value });
      }
      const open: Open = { qname, scope, ns: resolve(prefix, false), local, attributes, children: [] };
      if (selfClosing) {
        const element: XmlElement = { ns: open.ns, local, attributes, children: [] };
        if (stack.length) stack.at(-1)!.children.push(element);
        else if (root) fail('A second root element');
        else root = element;
      } else {
        if (!stack.length && root) fail('A second root element');
        stack.push(open);
      }
    }
  }
  if (stack.length) throw new XmlError(`<${stack.at(-1)!.qname}> is never closed`);
  if (!root) throw new XmlError('The file holds no XML element');
  return root;
}

/** The value of an attribute, by namespace and local name. */
export function attribute(element: XmlElement, local: string, ns: string | null = null): string | undefined {
  return element.attributes.find((a) => a.local === local && a.ns === ns)?.value;
}

/** The child elements, optionally of one namespace and name. */
export function childElements(element: XmlElement, ns?: string, local?: string): XmlElement[] {
  return element.children.filter((child): child is XmlElement => typeof child !== 'string' && (ns === undefined || child.ns === ns) && (local === undefined || child.local === local));
}

/** An element's text, its children's included. */
export function textOf(element: XmlElement): string {
  return element.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
}

/** Escape text for an element's content. */
export function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
}

/** Escape text for an attribute value in double quotes, where whitespace must survive as references. */
export function escapeAttribute(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
}

/** Something to write: an element by its qualified name, its attributes, and its children or text. */
export interface XmlOut {
  readonly name: string;
  readonly attributes?: Readonly<Record<string, string | number | undefined>>;
  readonly children?: readonly XmlOut[];
  readonly text?: string;
}

/** Write elements as indented XML, with the declaration. */
export function writeXml(root: XmlOut): string {
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const write = (element: XmlOut, depth: number) => {
    const indent = '  '.repeat(depth);
    const attributes = Object.entries(element.attributes ?? {})
      .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
      .map(([name, value]) => ` ${name}="${escapeAttribute(String(value))}"`)
      .join('');
    if (element.text !== undefined) {
      lines.push(`${indent}<${element.name}${attributes}>${escapeText(element.text)}</${element.name}>`);
    } else if (!element.children?.length) {
      lines.push(`${indent}<${element.name}${attributes} />`);
    } else {
      lines.push(`${indent}<${element.name}${attributes}>`);
      for (const child of element.children) write(child, depth + 1);
      lines.push(`${indent}</${element.name}>`);
    }
  };
  write(root, 0);
  return `${lines.join('\n')}\n`;
}
