import React, { useEffect, useRef, useState } from 'react';
import { Check, Monitor, Moon, Palette, Sun } from 'lucide-react';
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
  ['system', Monitor, 'Match system'],
];

// Mode and accent, saved on this device and applied to <html> (see index.css).
export function ThemePicker() {
  const [mode, setMode] = useState<ThemeMode>(() => parseMode(read(MODE_KEY)));
  const [accent, setAccent] = useState<Accent>(() => parseAccent(read(ACCENT_KEY)));
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const pickMode = (m: ThemeMode) => {
    setMode(m);
    write(MODE_KEY, m);
  };
  const pickAccent = (a: Accent) => {
    setAccent(a);
    write(ACCENT_KEY, a);
  };

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Theme"
        aria-label="Theme"
        aria-expanded={open}
        className={`flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 transition-colors ${
          open ? 'text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
        }`}
      >
        <Palette className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-40 w-56 space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-3 shadow-xl shadow-black/30">
          <div className="space-y-1">
            {MODES.map(([m, Icon, label]) => (
              <button
                key={m}
                onClick={() => pickMode(m)}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm ${
                  mode === m ? 'bg-violet-600 text-white' : 'text-zinc-300 hover:bg-zinc-800'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
          <div className="flex justify-between border-t border-zinc-800 pt-3">
            {ACCENTS.map((a) => (
              <button
                key={a}
                onClick={() => pickAccent(a)}
                title={a[0].toUpperCase() + a.slice(1)}
                aria-label={`${a} accent`}
                aria-pressed={accent === a}
                data-accent={a}
                style={{ background: 'var(--accent-500)' }}
                className="flex h-7 w-7 items-center justify-center rounded-full ring-offset-2 ring-offset-zinc-900 hover:ring-2 hover:ring-zinc-600"
              >
                {accent === a && <Check className="h-4 w-4 text-white" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
