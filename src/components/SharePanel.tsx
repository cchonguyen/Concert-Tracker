import React, { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { Equalizer } from './ui/Equalizer';
import { Notice } from './ui/Notice';
import { ShareLinkView, shareApi } from '../services/lineupApi';
import type { ShareSettings } from '../server/share/types';

// "Your link" on the Share page: make a read-only link to your history, choose
// what it shows, preview it, and turn it off. The page shows only events that
// are over, and never who you went with, notes, ratings or prices. See
// ARCHITECTURE.md ("Share page").
//
// In sample mode (`sample` set) nothing reaches the server: every action calls
// `sample` instead, which opens the sample explainer.

interface SharePanelProps {
  sample?: () => void;
}

const button =
  'inline-flex min-h-11 sm:min-h-9 items-center gap-1.5 rounded-control border border-line-strong px-3 py-2 text-sm text-text-muted hover:text-text disabled:opacity-40';
const primary =
  'inline-flex min-h-11 sm:min-h-9 items-center gap-1.5 rounded-control bg-accent-fill px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-fill disabled:opacity-40';

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

export const SharePanel: React.FC<SharePanelProps> = ({ sample }) => {
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
    // The sample never asks the server for a link.
    if (sample) {
      setLink(null);
      return;
    }
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
    if (sample) return sample();
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
    if (sample) return sample();
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
        <span className="text-text">{label}</span>
        <span className="block text-xs text-text-muted">{hint}</span>
      </span>
    </label>
  );

  const nameChanged = link && settings.displayName.trim() !== link.settings.displayName;

  return (
    <div className="space-y-5" role="region" aria-label="Your link">
      <p className="text-xs text-text-muted">
        A read-only page of the events you went to, for anyone with the link. It shows events only once they are over, and never who you went
        with, notes, ratings, prices or upcoming plans.
      </p>

      {error && (
        <Notice tone="warning">{error}</Notice>
      )}

      {link === undefined ? (
        <p className="flex items-center gap-2 text-sm text-text-muted">
          <Equalizer /> Loading…
        </p>
      ) : (
        <>
          <section className="space-y-2">
            <label className="block text-sm text-text-muted" htmlFor="share-name">
              Name on the page
            </label>
            <div className="flex gap-2">
              <input
                id="share-name"
                value={settings.displayName}
                maxLength={60}
                onChange={(e) => change({ displayName: e.target.value })}
                placeholder="Your name"
                className="min-h-11 min-w-0 flex-1 rounded-control border border-line-strong bg-surface-1 px-3 py-2 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none sm:min-h-9"
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
            <section className="space-y-3 rounded-card border border-line bg-surface-1 p-4">
              <p className="text-sm text-text-muted">Link active since <span className="font-mono tabular-nums text-text">{day(link.createdAt)}</span>.</p>
              {url ? (
                <div className="flex gap-2">
                  <input readOnly value={url} onFocus={(e) => e.target.select()} className="min-h-11 min-w-0 flex-1 rounded-control border border-line-strong bg-page px-3 py-2 font-mono text-xs text-text sm:min-h-9" />
                  <button className={button} onClick={copy}>
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              ) : (
                <p className="text-xs text-text-muted">
                  For safety only a fingerprint of the link is kept, so it can't be shown again here. Make a new link to copy one (the old one stops
                  working).
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <a className={button} href={shareApi.previewUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" /> Preview
                </a>
                <button className={button} disabled={!!busy} onClick={create}>
                  {busy === 'create' && <Equalizer size="sm" />} New link
                </button>
                <button className={button} disabled={!!busy} onClick={turnOff}>
                  {busy === 'off' && <Equalizer size="sm" />} Turn off
                </button>
              </div>
              <p className="text-xs text-text-muted">New link and Turn off stop the current link at once. Anyone you sent it to sees "This link isn't active".</p>
            </section>
          ) : (
            <button className={primary} disabled={!!busy || !settings.displayName.trim()} onClick={create}>
              {busy === 'create' && <Equalizer size="sm" />} Create link
            </button>
          )}
        </>
      )}
    </div>
  );
};
