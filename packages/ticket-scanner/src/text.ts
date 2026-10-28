// An email as the lines you see when you open it. Markup, styles and comments
// are dropped and each block or table cell becomes one line. Readers quote
// these lines, so a quote matches what the mail client shows.

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—',
  ndash: '–',
  middot: '·',
  bull: '•',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  times: '×',
  copy: '©',
  reg: '®',
  trade: '™',
};

const BLOCK = /<\/?(?:p|div|tr|table|tbody|thead|caption|header|footer|section|article|h[1-6]|li|ul|ol|center)\b[^>]*>|<br\s*\/?>/gi;
// Zero-width and preheader padding characters some senders use.
const INVISIBLE = /[­͏​-‍⁠﻿]/g;

export function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

export function htmlToLines(html: string): string[] {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(BLOCK, '\n')
    .replace(/<\/t[dh]>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return toLines(decodeEntities(text));
}

export function textToLines(text: string): string[] {
  return toLines(text);
}

function toLines(text: string): string[] {
  return text
    .replace(INVISIBLE, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// The HTML part is what you see; the plain part is often a stub, so it is
// the fallback.
export function emailLines(email: { html?: string; text?: string }): string[] {
  const html = email.html ? htmlToLines(email.html) : [];
  return html.length ? html : textToLines(email.text ?? '');
}

// The address inside "Name <address>".
export function senderAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

export function fromDomain(from: string, domain: string): boolean {
  const host = senderAddress(from).split('@')[1] ?? '';
  return host === domain || host.endsWith(`.${domain}`);
}
