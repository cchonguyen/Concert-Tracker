import React, { useMemo, useState } from 'react';
import { ClipboardPaste, Loader2 } from 'lucide-react';
import { Button } from './ui/Button';
import { parsePastedSets } from '../server/lineup/pasted';

// Paste set times (docs/specs/pasted-set-times.md): the owner copies a set-times page they can see and pastes it with
// its link. The text is read in code, here for the preview and again on the server; the app never visits the link.

const field =
  'w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-violet-500 focus:outline-none';

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
      <button type="button" className="text-xs text-violet-300 hover:underline" onClick={() => setOpen(true)}>
        Paste set times from a page
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-zinc-800 p-3">
      <p className="text-xs text-zinc-400">
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
          <p className="text-zinc-300">
            Read {read.sets.length} {read.sets.length === 1 ? 'act' : 'acts'}, {timed} with a time.
            {read.sets.length > 0 && !read.sets.some((s) => s.set?.stage) && ' No stages: the text does not say which act played where.'}
          </p>
          {read.sets.length > 0 && (
            <ul className="max-h-40 overflow-y-auto text-zinc-400">
              {read.sets.map((s, i) => (
                <li key={i}>
                  {s.name}
                  {s.set ? ` · ${[s.set.stage, [clock(s.set.start), clock(s.set.end)].filter(Boolean).join('–')].filter(Boolean).join(' · ')}` : ' · no time'}
                </li>
              ))}
            </ul>
          )}
          {read.unread.length > 0 && (
            <details className="text-zinc-500">
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
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardPaste className="h-4 w-4" />}
          Review these acts
        </Button>
      </div>
      {!linkOk && url.trim() && <p className="text-xs text-amber-300/90">The link should start with https://.</p>}
    </div>
  );
}
