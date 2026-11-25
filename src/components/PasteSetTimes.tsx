import React, { useMemo, useState } from 'react';
import { ClipboardPaste } from 'lucide-react';
import { Equalizer } from './ui/Equalizer';
import { Button } from './ui/Button';
import { parsePastedSets } from '../server/lineup/pasted';

// Paste set times (docs/specs/pasted-set-times.md): the owner copies a set-times page they can see and pastes it with
// its link. The text is read in code, here for the preview and again on the server; the app never visits the link.

const field =
  'w-full rounded-control border border-line bg-surface-1 px-3 py-2 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none';

const clock = (stamp?: string) => stamp?.slice(11, 16);

export function PasteSetTimes({
  startDate,
  endDate,
  busy,
  onSubmit,
}: {
  startDate: string;
  endDate?: string;
  busy: boolean;
  onSubmit: (url: string, text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const read = useMemo(() => (text.trim() ? parsePastedSets(text, { startDate, endDate }) : null), [text, startDate, endDate]);
  const linkOk = /^https?:\/\/\S+$/i.test(url.trim());
  const timed = read?.sets.filter((s) => s.set).length ?? 0;

  if (!open) {
    return (
      <button type="button" className="inline-flex min-h-11 items-center sm:min-h-9 text-xs text-accent hover:underline" onClick={() => setOpen(true)}>
        Paste set times from a page
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-control border border-line p-3">
      <p className="text-xs text-text-muted">
        Copy the set times from a page you can open (for example Festival Dust) and paste them here with the page's link. The app reads each name and time and never visits the link.
      </p>
      <input className={field} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Link of the page you copied from" aria-label="Page link" />
      <textarea
        className={`${field} h-40 font-mono text-xs`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste the set times here"
        aria-label="Pasted set times"
      />
      {read && (
        <div className="space-y-1 text-xs">
          <p className="text-text-muted">
            Read {read.sets.length} {read.sets.length === 1 ? 'act' : 'acts'}, {timed} with a time.
            {read.sets.length > 0 && !read.sets.some((s) => s.set?.stage) && ' No stages: the text does not say which act played where.'}
          </p>
          {read.sets.length > 0 && (
            <ul className="max-h-40 overflow-y-auto text-text-muted">
              {read.sets.map((s, i) => (
                <li key={i}>
                  {s.name}
                  {s.set ? ` · ${[s.set.stage, [clock(s.set.start), clock(s.set.end)].filter(Boolean).join('–')].filter(Boolean).join(' · ')}` : ' · no time'}
                </li>
              ))}
            </ul>
          )}
          {read.unread.length > 0 && (
            <details className="text-text-muted">
              <summary className="cursor-pointer">{read.unread.length} lines not read</summary>
              <ul className="max-h-32 overflow-y-auto">
                {read.unread.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => onSubmit(url.trim(), text)} disabled={busy || !linkOk || !read || read.sets.length === 0}>
          {busy ? <Equalizer /> : <ClipboardPaste className="h-4 w-4" />}
          Review these acts
        </Button>
      </div>
      {!linkOk && url.trim() && <p className="text-xs text-warn">The link should start with https://.</p>}
    </div>
  );
}
