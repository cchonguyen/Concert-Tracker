// The Privacy and Terms side panels read the public pages (public/privacy.html,
// public/terms.html), so their wording lives in one place. Pure code: the
// caller fetches the page and passes its HTML in.

export type LegalKind = 'privacy' | 'terms';

export interface LegalSection {
  heading: string;
  html: string; // the section's own markup from the page (paragraphs and lists)
}

export interface LegalPage {
  title: string;
  updated: string | null; // the "Last updated ..." line under the title
  sections: LegalSection[];
}

// The public address of each page, and the file the panel reads (both are on PUBLIC_EXACT_PATHS).
export const LEGAL_PATH: Record<LegalKind, string> = { privacy: '/privacy', terms: '/terms' };
export const LEGAL_FILE: Record<LegalKind, string> = { privacy: '/privacy.html', terms: '/terms.html' };

const text = (html: string) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

// The title, the date line and each h2 section of a page's <main>, leaving out
// its top links and its footer. Null when the page is not one of ours.
export function parseLegalPage(page: string): LegalPage | null {
  const main = /<main>([\s\S]*?)<\/main>/i.exec(page)?.[1];
  if (!main) return null;
  const title = /<h1>([\s\S]*?)<\/h1>/i.exec(main);
  if (!title) return null;
  const body = main.slice(title.index + title[0].length).replace(/<footer>[\s\S]*?<\/footer>/i, '');
  const updated = /^\s*<p class="muted">([\s\S]*?)<\/p>/i.exec(body);
  const parts = body.split(/<h2>/i).slice(1);
  const sections = parts.map((part) => {
    const end = part.search(/<\/h2>/i);
    return { heading: text(part.slice(0, end)), html: part.slice(end + 5).trim() };
  });
  if (sections.length === 0) return null;
  return { title: text(title[1]), updated: updated ? text(updated[1]) : null, sections };
}
