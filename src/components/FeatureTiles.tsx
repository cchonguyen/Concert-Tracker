import React, { useEffect, useState } from 'react';
import { Archive, ArrowDownUp, FileSpreadsheet, GitMerge, Search, X } from 'lucide-react';
import type { Page } from '../services/nav';
import { readTips, tipsKey, TIPS_EVENT, writeTips, type TipsSaved } from '../services/tips';
import { useMe } from './MeContext';
import { Button } from './ui/Button';

// Six feature tiles that each open the page where the feature lives. Shown open for up to 4 events,
// folded at 5 or more. Dismissing is remembered per account on this browser (services/tips.ts); see ARCHITECTURE.md.
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
  { key: 'years', icon: Archive, title: 'See your years', line: 'A timeline, a calendar heatmap, a map of every city and the artists you’ve seen most.', page: 'agenda', linkLabel: 'Open Timeline' },
];

export const FeatureTiles: React.FC<{ eventCount: number; onOpen: (page: Page) => void; onImport: () => void }> = ({ eventCount, onOpen, onImport }) => {
  const me = useMe();
  const key = tipsKey(me.email);
  const [saved, setSaved] = useState<TipsSaved>(() => readTips(key));
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);

  // "Show tips again" in the Menu or About changes the same store, so re-read it.
  useEffect(() => {
    const reread = () => setSaved(readTips(key));
    window.addEventListener(TIPS_EVENT, reread);
    return () => window.removeEventListener(TIPS_EVENT, reread);
  }, [key]);

  const update = (next: TipsSaved) => {
    setSaved(next);
    writeTips(key, next);
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
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">What LiveArchive can do</h2>
        <Button variant="ghost" onClick={() => update({ ...saved, allHidden: true })}>
          Hide these
        </Button>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((t) => {
          const Icon = t.icon;
          return (
            <li key={t.key} className="relative rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <button
                aria-label={`Hide tip: ${t.title}`}
                onClick={() => update({ ...saved, dismissed: [...saved.dismissed, t.key] })}
                className="absolute right-2 top-2 rounded-md p-1 text-zinc-400 hover:text-zinc-100"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <Icon className="mb-2 h-5 w-5 text-violet-300" aria-hidden="true" />
              <h3 className="pr-6 text-sm font-bold text-zinc-100">{t.title}</h3>
              <p className="mt-1 text-sm text-zinc-400">{t.line}</p>
              <button
                onClick={() => (t.action === 'import' ? onImport() : onOpen(t.page))}
                className="mt-2 text-sm text-violet-300 hover:text-violet-200"
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
