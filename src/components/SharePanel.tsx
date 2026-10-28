import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, ExternalLink, Loader2, Share2, X } from 'lucide-react';
import { ShareLinkView, shareApi } from '../services/lineupApi';
import type { ShareSettings } from '../server/share/types';

// "Share" in the Stats view: make a read-only link to your history, choose
// what it shows, preview it, and turn it off. The page shows only events that
// are over, and never who you went with, notes, ratings or prices. See
// ARCHITECTURE.md ("Share page").

interface SharePanelProps {
  onClose: () => void;
}

const button =
  'inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:text-zinc-100 disabled:opacity-40';
const primary =
  'inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-40';

// The server keeps only a hash of the link's code, so the full link can be
// shown again only from this browser, which remembers it for the active link.
const SAVED = 'share-link';
const savedUrl = (id?: string): string | null => {
  try {
    const v = JSON.parse(localStorage.getItem(SAVED) ?? 'null') as { id: string; url: string } | null;
    return v && v.id === id ? v.url : null;
  } catch {
    return null;
  }
};
const saveUrl = (id: string, url: string) => {
  try {
    localStorage.setItem(SAVED, JSON.stringify({ id, url }));
  } catch {
    // Private windows may refuse; the link is still on screen.
  }
};

const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

export const SharePanel: React.FC<SharePanelProps> = ({ onClose }) => {
  const [link, setLink] = useState<ShareLinkView | null | undefined>(undefined);
  const [url, setUrl] = useState<string | null>(null);
  const [settings, setSettings] = useState<ShareSettings>({
    displayName: '',
    timeZone: browserTimeZone(),
    showDates: true,
    showVenues: true,
    showFormat: false,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    shareApi
      .status()
      .then((l) => {
        setLink(l);
        if (l) {
          setSettings(l.settings);
          setUrl(savedUrl(l.id));
        }
      })
      .catch((e) => {
        setLink(null);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const create = () =>
    run('create', async () => {
      const r = await shareApi.create({ ...settings, timeZone: browserTimeZone() });
      const full = `${window.location.origin}/s/${r.code}`;
      saveUrl(r.link.id, full);
      setLink(r.link);
      setSettings(r.link.settings);
      setUrl(full);
    });

  const change = (patch: Partial<ShareSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    // Switches apply at once; the name is saved with its own button.
    if (link && !('displayName' in patch)) run('save', async () => setLink(await shareApi.update(next)));
  };

  const turnOff = () =>
    run('off', async () => {
      await shareApi.turnOff();
      setLink(null);
      setUrl(null);
    });

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Copying was blocked; select the link and copy it instead.');
    }
  };

  const toggle = (key: 'showDates' | 'showVenues' | 'showFormat', label: string, hint: string) => (
    <label className="flex items-start gap-3 text-sm">
      <input type="checkbox" checked={settings[key]} onChange={(e) => change({ [key]: e.target.checked })} disabled={!!busy} className="mt-1" />
      <span>
        <span className="text-zinc-200">{label}</span>
        <span className="block text-xs text-zinc-500">{hint}</span>
      </span>
    </label>
  );

  const nameChanged = link && settings.displayName.trim() !== link.settings.displayName;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="flex h-full w-full max-w-xl flex-col border-l border-zinc-900 bg-zinc-950 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-bold">
                <Share2 className="h-4 w-4 text-violet-400" /> Share
              </h2>
              <p className="text-xs text-zinc-500">
                A read-only page of the events you went to, for anyone with the link. It shows events only once they are over, and never who you
                went with, notes, ratings, prices or upcoming plans.
              </p>
            </div>
            <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>

          {error && (
            <p className="flex items-start gap-2 rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 text-sm text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
            </p>
          )}

          {link === undefined ? (
            <p className="flex items-center gap-2 text-sm text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </p>
          ) : (
            <>
              <section className="space-y-2">
                <label className="block text-sm text-zinc-300" htmlFor="share-name">
                  Name on the page
                </label>
                <div className="flex gap-2">
                  <input
                    id="share-name"
                    value={settings.displayName}
                    maxLength={60}
                    onChange={(e) => change({ displayName: e.target.value })}
                    placeholder="Your name"
                    className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
                  />
                  {nameChanged && (
                    <button
                      className={button}
                      disabled={!!busy || !settings.displayName.trim()}
                      onClick={() => run('save', async () => setLink(await shareApi.update(settings)))}
                    >
                      Save
                    </button>
                  )}
                </div>
              </section>

              <section className="space-y-3">
                {toggle('showDates', 'Show exact dates', 'Off: years only, and events in a year listed A to Z.')}
                {toggle('showVenues', 'Show venues', 'Off: city only.')}
                {toggle('showFormat', 'Show format', 'Club night, warehouse party and the like.')}
              </section>

              {link ? (
                <section className="space-y-3 rounded-xl border border-zinc-900 bg-zinc-900/40 p-4">
                  <p className="text-sm text-zinc-300">Link active since {day(link.createdAt)}.</p>
                  {url ? (
                    <div className="flex gap-2">
                      <input readOnly value={url} onFocus={(e) => e.target.select()} className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-300" />
                      <button className={button} onClick={copy}>
                        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  ) : (
                    <p className="text-xs text-zinc-500">
                      For safety only a fingerprint of the link is kept, so it can't be shown again here. Make a new link to copy one (the old one stops
                      working).
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <a className={button} href={shareApi.previewUrl} target="_blank" rel="noreferrer">
                      <ExternalLink className="h-4 w-4" /> Preview
                    </a>
                    <button className={button} disabled={!!busy} onClick={create}>
                      {busy === 'create' && <Loader2 className="h-4 w-4 animate-spin" />} New link
                    </button>
                    <button className={button} disabled={!!busy} onClick={turnOff}>
                      {busy === 'off' && <Loader2 className="h-4 w-4 animate-spin" />} Turn off
                    </button>
                  </div>
                  <p className="text-xs text-zinc-500">New link and Turn off stop the current link at once. Anyone you sent it to sees "This link isn't active".</p>
                </section>
              ) : (
                <button className={primary} disabled={!!busy || !settings.displayName.trim()} onClick={create}>
                  {busy === 'create' && <Loader2 className="h-4 w-4 animate-spin" />} Create link
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
