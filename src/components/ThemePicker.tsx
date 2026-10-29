import { useEffect, useState } from 'react';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { IconButton } from './ui/IconButton';
import { Tooltip } from './ui/Tooltip';
import {
  ACCENT_KEY,
  ACCENTS,
  Accent,
  BAR_COLORS,
  MODE_KEY,
  parseAccent,
  parseMode,
  resolveMode,
  ThemeMode,
} from '../services/theme';

const read = (key: string) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private windows can refuse storage; the choice then lasts until reload.
  }
};

const MODES: [ThemeMode, typeof Sun, string][] = [
  ['dark', Moon, 'Dark'],
  ['light', Sun, 'Light'],
  ['system', Monitor, 'System'],
];

export interface Theme {
  mode: ThemeMode;
  accent: Accent;
  pickMode: (m: ThemeMode) => void;
  pickAccent: (a: Accent) => void;
}

// Mode and accent, saved on this device and applied to <html> (see index.css).
// Called once at the top of the app so the theme applies before any menu opens.
export function useTheme(): Theme {
  const [mode, setMode] = useState<ThemeMode>(() => parseMode(read(MODE_KEY)));
  const [accent, setAccent] = useState<Accent>(() => parseAccent(read(ACCENT_KEY)));

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      const resolved = resolveMode(mode, media.matches);
      document.documentElement.dataset.theme = resolved;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BAR_COLORS[resolved]);
    };
    apply();
    if (mode !== 'system') return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [mode]);

  useEffect(() => {
    document.documentElement.dataset.accent = accent;
  }, [accent]);

  const pickMode = (m: ThemeMode) => {
    setMode(m);
    write(MODE_KEY, m);
  };
  const pickAccent = (a: Accent) => {
    setAccent(a);
    write(ACCENT_KEY, a);
  };

  return { mode, accent, pickMode, pickAccent };
}

// The theme choices, shown inline inside the menu.
export function ThemeControls({ theme }: { theme: Theme }) {
  const { mode, accent, pickMode, pickAccent } = theme;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1">
        {MODES.map(([m, Icon, label]) => (
          <IconButton
            key={m}
            icon={Icon}
            label={label}
            aria-pressed={mode === m}
            onClick={() => pickMode(m)}
            className={mode === m ? 'bg-violet-600 text-white hover:text-white' : ''}
          />
        ))}
      </div>
      <div className="flex justify-between border-t border-zinc-800 pt-3">
        {ACCENTS.map((a) => (
          <Tooltip key={a} label={a[0].toUpperCase() + a.slice(1)}>
            <button
              onClick={() => pickAccent(a)}
              aria-label={`${a} accent`}
              aria-pressed={accent === a}
              data-accent={a}
              style={{ background: 'var(--accent-500)' }}
              className="flex h-7 w-7 items-center justify-center rounded-full ring-offset-2 ring-offset-zinc-900 hover:ring-2 hover:ring-zinc-600"
            >
              {accent === a && <Check className="h-4 w-4 text-white" />}
            </button>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
