import React, { useEffect, useState } from 'react';
import { Archive, ArrowDownUp, FileSpreadsheet, GitMerge, Search, Share2, X } from 'lucide-react';
import type { Page } from '../services/nav';
import type { TipsSaved } from '../server/auth/prefs';
import { DEFAULT_TIPS, loadPrefs, TIPS_EVENT, writeTips } from '../services/prefs';
import { useMe } from './MeContext';
import { Button } from './ui/Button';

// Six feature tiles that each open the page where the feature lives. Shown open for up to 4 events,
// folded at 5 or more. Dismissing is remembered on the account (services/prefs.ts); see ARCHITECTURE.md.
interface Tile {
  key: string;
  icon: typeof Search;
  title: string;
  line: string;
  page: Page;
  linkLabel: string;
  action?: 'import';
}

export const TILES: Tile[] = [
  { key: 'details', icon: Search, title: 'Finds the details for you', line: 'Type “Porter Robinson at the Greek, 2024”. LiveArchive looks up the date, venue and city, and tells you which source said so.', page: 'summary', linkLabel: 'Open Summary' },
  { key: 'lineup', icon: Search, title: 'Finds who played', line: 'One tap pulls the lineup from festival lineup sites and the promoter’s own pages. Every act links back to where it was listed, so nothing is guessed.', page: 'summary', linkLabel: 'Open Summary' },
  { key: 'fill', icon: ArrowDownUp, title: 'Fix many shows at once', line: 'Fill gaps finds every show missing a date, a city or a lineup, and lets you fill them in one pass.', page: 'table', linkLabel: 'Open Table' },
  { key: 'data', icon: FileSpreadsheet, title: 'Your data, your way', line: 'Import a spreadsheet, export everything as CSV, or keep a Google Sheet in sync. Your history is never locked in.', page: 'table', linkLabel: 'Open Import', action: 'import' },
  { key: 'merge', icon: GitMerge, title: 'Tidy as you go', line: 'Two spellings of the same artist or venue? Merge them in a tap, and undo if you change your mind.', page: 'manage', linkLabel: 'Open Manage' },
  { key: 'share', icon: Share2, title: 'Show friends your year', line: 'Make a link to your history that anyone can open without signing in. Turn it off at any time, and it stops working at once.', page: 'share', linkLabel: 'Open Share' },
  { key: 'years', icon: Archive, title: 'See your years', line: 'A timeline, a calendar heatmap, a map of every city and the artists you’ve seen most.', page: 'agenda', linkLabel: 'Open Timeline' },
];

export const FeatureTiles: React.FC<{ eventCount: number; onOpen: (page: Page) => void; onImport: () => void }> = ({ eventCount, onOpen, onImport }) => {
  const me = useMe();
  // null until the account's choice arrives; nothing shows meanwhile, so a dismissed tip never flashes back.
  const [saved, setSaved] = useState<TipsSaved | null>(null);
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);

  // "Show tips again" in the Menu or About saves a new choice, so read it again.
  useEffect(() => {
    let live = true;
    const read = () =>
      loadPrefs(me.email)
        .then((p) => live && setSaved(p.tips ?? DEFAULT_TIPS))
        .catch(() => live && setSaved(DEFAULT_TIPS));
    read();
    window.addEventListener(TIPS_EVENT, read);
    return () => {
      live = false;
      window.removeEventListener(TIPS_EVENT, read);
    };
  }, [me.email]);

  if (saved === null) return null;

  const update = (next: TipsSaved) => {
    setSaved(next);
    void writeTips(next);
  };

  const folded = expandedOverride === null ? eventCount >= 5 : !expandedOverride;
  const visible = TILES.filter((t) => !saved.dismissed.includes(t.key));

  if (saved.allHidden || visible.length === 0) {
    return (
      <div className="flex justify-end">
        <Button variant="ghost" onClick={() => update({ dismissed: [], allHidden: false })}>
          Show tips again
        </Button>
      </div>
    );
  }

  if (folded) {
    return (
      <div className="flex justify-end">
        <Button variant="ghost" onClick={() => setExpandedOverride(true)} aria-expanded={false}>
          Show tips
        </Button>
      </div>
    );
  }

  return (
    <section aria-label="Tips" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-lg font-normal text-text">What LiveArchive can do</h2>
        <Button variant="ghost" onClick={() => update({ ...saved, allHidden: true })}>
          Hide these
        </Button>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((t) => {
          const Icon = t.icon;
          return (
            <li
              key={t.key}
              className="relative rounded-card border border-line-strong bg-surface-1 p-4 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]"
            >
              <button
                aria-label={`Hide tip: ${t.title}`}
                onClick={() => update({ ...saved, dismissed: [...saved.dismissed, t.key] })}
                className="absolute right-1 top-1 flex min-h-10 min-w-10 items-center justify-center rounded-control text-text-muted hover:text-text"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <span className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-control border border-accent-tint-line bg-accent-tint text-accent">
                <Icon className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
              </span>
              <h3 className="pr-8 text-sm font-bold text-text">{t.title}</h3>
              <p className="mt-1 text-sm text-text-muted">{t.line}</p>
              <button
                onClick={() => (t.action === 'import' ? onImport() : onOpen(t.page))}
                className="mt-2 inline-flex min-h-9 items-center text-sm font-medium text-accent hover:underline"
              >
                {t.linkLabel}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
};
