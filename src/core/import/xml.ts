/** Small helpers for namespace-agnostic XML reading with the DOM. */

export function parseXml(source: string): Document {
  const doc = new DOMParser().parseFromString(source.replace(/^﻿/, ''), 'application/xml');
  const error = doc.getElementsByTagName('parsererror')[0];
  if (error) throw new Error(`Invalid XML: ${error.textContent?.trim().slice(0, 160) ?? ''}`);
  return doc;
}

/** Direct child elements, optionally filtered by local name (prefixes are ignored). */
export function children(parent: Element | Document, name?: string): Element[] {
  const out: Element[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    if (!name || element.localName === name) out.push(element);
  }
  return out;
}

export function child(parent: Element | Document, name: string): Element | undefined {
  return children(parent, name)[0];
}

/** All descendant elements with the given local name. */
export function descendants(parent: Element | Document, name: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS('*', name));
}

export function clean(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** Text of an HTML fragment, as used for labels in draw.io and exported transcripts. */
export function htmlToText(html: string): string {
  if (!/[<&]/.test(html)) return html;
  const withBreaks = html.replace(/<\s*(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n');
  const doc = new DOMParser().parseFromString(`<body>${withBreaks}</body>`, 'text/html');
  return doc.body.textContent ?? '';
}
