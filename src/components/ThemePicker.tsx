import { useEffect, useState } from 'react';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { Tooltip } from './ui/Tooltip';
import { Switch } from './ui/Switch';
import { parseTintOn, TINT_KEY } from '../services/eventTint';
import {
  ACCENT_KEY,
  ACCENTS,
  Accent,
  BAR_COLORS,
  MODE_KEY,
  parseAccent,
  parseMode,
  resolveMode,
  parseStubStyle,
  STUB_STYLE_KEY,
  STUB_STYLE_LABELS,
  STUB_STYLES,
  StubStyle,
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
  tintOn: boolean;
  setTint: (on: boolean) => void;
  stubStyle: StubStyle;
  pickStubStyle: (s: StubStyle) => void;
}

// Mode and accent, saved on this device and applied to <html> (see index.css).
// Called once at the top of the app so the theme applies before any menu opens.
export function useTheme(): Theme {
  const [mode, setMode] = useState<ThemeMode>(() => parseMode(read(MODE_KEY)));
  const [accent, setAccent] = useState<Accent>(() => parseAccent(read(ACCENT_KEY)));
  const [tintOn, setTintOn] = useState<boolean>(() => parseTintOn(read(TINT_KEY)));
  const [stubStyle, setStubStyle] = useState<StubStyle>(() => parseStubStyle(read(STUB_STYLE_KEY)));

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

  // index.css restyles every .ticket-card for this value.
  useEffect(() => {
    document.documentElement.dataset.stub = stubStyle;
  }, [stubStyle]);

  // index.css hides the poster wash and series dots when this is "off".
  useEffect(() => {
    document.documentElement.dataset.eventTint = tintOn ? 'on' : 'off';
  }, [tintOn]);

  const pickMode = (m: ThemeMode) => {
    setMode(m);
    write(MODE_KEY, m);
  };
  const pickAccent = (a: Accent) => {
    setAccent(a);
    write(ACCENT_KEY, a);
  };

  const setTint = (on: boolean) => {
    setTintOn(on);
    write(TINT_KEY, on ? 'on' : 'off');
  };

  const pickStubStyle = (s: StubStyle) => {
    setStubStyle(s);
    write(STUB_STYLE_KEY, s);
  };

  return { mode, accent, pickMode, pickAccent, tintOn, setTint, stubStyle, pickStubStyle };
}

// A 5-swatch picker for ticket stub styles; used both in the global menu and on Share cards.
export function TicketStylePicker({
  value,
  onChange,
  className = '',
}: {
  value: StubStyle;
  onChange: (s: StubStyle) => void;
  className?: string;
}) {
  return (
    <fieldset className={className}>
      <legend className="mb-2 text-xs font-semibold text-text-muted">Ticket style</legend>
      <div className="grid grid-cols-5 gap-1">
        {STUB_STYLES.map((s) => (
          <Tooltip key={s} label={STUB_STYLE_LABELS[s]}>
            <button
              type="button"
              onClick={() => onChange(s)}
              aria-label={`${STUB_STYLE_LABELS[s]} ticket style`}
              aria-pressed={value === s}
              data-stub={s}
              className={`stub-swatch h-9 w-full rounded-md ring-offset-2 ring-offset-surface-1 ${
                value === s ? 'ring-2 ring-accent' : 'hover:ring-2 hover:ring-line-strong'
              }`}
            />
          </Tooltip>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-text-faint">{STUB_STYLE_LABELS[value]}</p>
    </fieldset>
  );
}

// The theme choices, shown inline inside the menu.
export function ThemeControls({ theme }: { theme: Theme }) {
  const { mode, accent, pickMode, pickAccent, tintOn, setTint, stubStyle, pickStubStyle } = theme;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-1">
        {MODES.map(([m, Icon, label]) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => pickMode(m)}
            className={`flex w-full flex-col items-center gap-1 rounded-lg px-1 py-2 text-xs transition-colors ${
              mode === m ? 'bg-accent-fill text-on-accent' : 'text-text-muted hover:bg-surface-2 hover:text-text'
            }`}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
      <div className="flex justify-between border-t border-line pt-3">
        {ACCENTS.map((a) => (
          <Tooltip key={a} label={a[0].toUpperCase() + a.slice(1)}>
            <button
              onClick={() => pickAccent(a)}
              aria-label={`${a} accent`}
              aria-pressed={accent === a}
              data-accent={a}
              style={{ background: 'var(--accent-500)' }}
              className="flex h-7 w-7 items-center justify-center rounded-full ring-offset-2 ring-offset-surface-1 hover:ring-2 hover:ring-line-strong"
            >
              {accent === a && <Check className="h-4 w-4 text-white" />}
            </button>
          </Tooltip>
        ))}
      </div>
      <TicketStylePicker value={stubStyle} onChange={pickStubStyle} className="border-t border-line pt-3" />
      <div className="border-t border-line pt-2">
        <Switch checked={tintOn} onChange={setTint} label="Tint posters by event" helper="A soft color on each poster, the same for every year of a series." />
      </div>
    </div>
  );
}
