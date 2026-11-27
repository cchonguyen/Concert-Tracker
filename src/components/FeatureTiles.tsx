import React from 'react';
import { Archive, ArrowDownUp, FileSpreadsheet, GitMerge, Search, Share2 } from 'lucide-react';
import type { Page } from '../services/nav';
import { Button } from './ui/Button';
import { PosterHeading } from './ui/PosterHeading';
import { PostIt } from './ui/PostIt';
import { useTip } from './ui/TipsContext';

// The feature tiles, each opening the page where the feature lives. They are Home's tip (`home`): shown on the
// first visits, then folded into the ? in the header, which brings them back (docs/specs/quiet-tips-table.md).
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

// Post-it tilts and paper tones repeat in this order (docs/specs/landing-look.md).
const TILTS = [-1.5, 1, -0.5, 1.5, -1, 0.5];
const TONES = ['paper', 'second', 'paper', 'accent', 'paper', 'second'] as const;

export const FeatureTiles: React.FC<{ onOpen: (page: Page) => void; onImport: () => void }> = ({ onOpen, onImport }) => {
  const { shown, entering, hide } = useTip('home');
  if (!shown) return null;

  return (
    <section aria-label="Tips" className={`space-y-3 ${entering ? 'tip-enter' : ''}`}>
      <div className="flex items-center justify-between gap-3">
        <PosterHeading size="md" second="can do">What LiveArchive</PosterHeading>
        <Button variant="ghost" onClick={hide}>
          Hide these
        </Button>
      </div>
      <ul className="grid gap-6 pt-2 sm:grid-cols-2 lg:grid-cols-3">
        {TILES.map((t, i) => {
          const Icon = t.icon;
          return (
            <li key={t.key}>
              <PostIt
                tilt={TILTS[i % TILTS.length]}
                tone={TONES[i % TONES.length]}
                icon={<Icon className="h-6 w-6" strokeWidth={2} />}
                title={t.title}
                className="h-full"
              >
                <p>{t.line}</p>
                <button
                  onClick={() => (t.action === 'import' ? onImport() : onOpen(t.page))}
                  className="mt-2 inline-flex min-h-9 items-center font-semibold underline decoration-2 underline-offset-4 hover:decoration-[3px]"
                >
                  {t.linkLabel}
                </button>
              </PostIt>
            </li>
          );
        })}
      </ul>
    </section>
  );
};
