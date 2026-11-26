import { useEffect, useState } from 'react';
import { Dialog } from './ui/Dialog';
import { copy } from '../services/copy';
import { LEGAL_FILE, LEGAL_PATH, parseLegalPage, type LegalKind, type LegalPage } from '../services/legalPage';

// Privacy and Terms in the same side panel and type as About (AboutDialog.tsx).
// The wording is read from the public page, so there is only one copy of it.
const BODY =
  'space-y-2 text-sm text-text-muted [&_a]:text-accent [&_a]:underline [&_li]:mt-1 [&_p+p]:mt-2 [&_strong]:font-semibold [&_strong]:text-text [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5';

export function LegalDialog({ kind, onClose }: { kind: LegalKind; onClose: () => void }) {
  const [page, setPage] = useState<LegalPage | null>(null);
  const [failed, setFailed] = useState(false);
  const fallbackTitle = kind === 'privacy' ? 'Privacy' : 'Terms';

  useEffect(() => {
    let live = true;
    setPage(null);
    setFailed(false);
    fetch(LEGAL_FILE[kind], { headers: { Accept: 'text/html' } })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((html) => {
        if (!live) return;
        const parsed = parseLegalPage(html);
        if (parsed) setPage(parsed);
        else setFailed(true);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [kind]);

  const title = page?.title ?? fallbackTitle;

  return (
    <Dialog title={`${title} · ${copy.appName}`} onClose={onClose} panelClassName="h-full w-full max-w-xl space-y-6 overflow-y-auto border-l border-line bg-page p-5 shadow-2xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-normal text-text">{title}</h2>
          {page?.updated && <p className="text-xs text-text-muted">{page.updated}</p>}
        </div>
        <button onClick={onClose} className="inline-flex min-h-11 items-center rounded-control px-2 py-1 text-sm text-text-muted hover:bg-surface-2 hover:text-text sm:min-h-10">
          Close
        </button>
      </div>

      {!page && !failed && <p className="text-sm text-text-muted">Loading…</p>}
      {failed && (
        <p className="text-sm text-text-muted">
          This page did not load here.{' '}
          <a href={LEGAL_PATH[kind]} className="text-accent underline">
            Open {fallbackTitle}
          </a>
        </p>
      )}

      {page?.sections.map((s) => (
        <section key={s.heading} className={BODY}>
          <h3 className="font-display text-base font-normal text-text">{s.heading}</h3>
          {/* Our own public page, served from this site (public/privacy.html, public/terms.html). */}
          <div className="space-y-2" dangerouslySetInnerHTML={{ __html: s.html }} />
        </section>
      ))}

      {page && (
        <p className="text-xs text-text-muted">
          <a href={LEGAL_PATH[kind]} className="text-accent underline">
            Open as a page
          </a>
        </p>
      )}
    </Dialog>
  );
}
