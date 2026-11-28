import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { HelpCircle } from 'lucide-react';
import { loadPrefs, TIPS_EVENT, writeTips } from '../../services/prefs';
import { chooseTips, isShown, markFolded, needsNudge, readTips, recordVisit, saveTips, setShowAll, type TipKey, type TipsState } from '../../services/tips';
import { Tooltip } from './Tooltip';

// The page tips (docs/archive/quiet-tips-table.md). The rules are in src/services/tips.ts and the state is saved
// on the account. Each tip on screen registers its key, so the ? in the header knows which tips this screen has.

interface TipsApi {
  ready: boolean;
  showAll: boolean;
  onScreen: string[];
  nudge: boolean;
  justShown: string[];
  shown: (key: string) => boolean;
  register: (key: string) => () => void;
  choose: (keys: string[], on: boolean) => void;
  setAll: (on: boolean) => void;
}

const TipsCtx = createContext<TipsApi | null>(null);

export function TipsProvider({ email, children }: { email: string | null; children: ReactNode }) {
  const [state, setState] = useState<TipsState | null>(null);
  const latest = useRef<TipsState | null>(null);
  const [onScreen, setOnScreen] = useState<string[]>([]);
  const [nudge, setNudge] = useState(false);
  const [justShown, setJustShown] = useState<string[]>([]);
  // Keys already counted while this page is open, so a re-render never counts a visit twice.
  const counted = useRef(new Set<string>());

  useEffect(() => {
    let live = true;
    const read = () =>
      loadPrefs(email)
        .then((p) => {
          if (!live) return;
          latest.current = readTips(p.tips);
          setState(latest.current);
        })
        .catch(() => {
          if (!live || latest.current) return;
          latest.current = readTips(null);
          setState(latest.current);
        });
    read();
    window.addEventListener(TIPS_EVENT, read);
    return () => {
      live = false;
      window.removeEventListener(TIPS_EVENT, read);
    };
  }, [email]);

  // Applies a change to the newest copy, shows it at once and saves it. A failed save shows the account's copy again.
  const update = useCallback((fn: (s: TipsState) => TipsState) => {
    const cur = latest.current;
    if (!cur) return;
    const next = fn(cur);
    if (next === cur) return;
    latest.current = next;
    setState(next);
    void writeTips(saveTips(next));
  }, []);

  const register = useCallback((key: string) => {
    setOnScreen((keys) => (keys.includes(key) ? keys : [...keys, key]));
    return () => {
      counted.current.delete(key);
      setOnScreen((keys) => keys.filter((k) => k !== key));
    };
  }, []);

  // Counts a visit for each tip that arrives on screen, and nudges the ? the first time one folds by itself.
  useEffect(() => {
    const cur = latest.current;
    if (!state || !cur) return;
    const fresh = onScreen.filter((k) => !counted.current.has(k));
    if (!fresh.length) return;
    fresh.forEach((k) => counted.current.add(k));
    let next = cur;
    for (const k of fresh) next = recordVisit(next, k);
    const folding = fresh.filter((k) => needsNudge(next, k));
    if (folding.length) {
      next = markFolded(next, folding);
      setNudge(true);
    }
    update(() => next);
  }, [onScreen, state, update]);

  useEffect(() => {
    if (!nudge) return;
    const t = window.setTimeout(() => setNudge(false), 2600);
    return () => window.clearTimeout(t);
  }, [nudge]);

  useEffect(() => {
    if (!justShown.length) return;
    const t = window.setTimeout(() => setJustShown([]), 1400);
    return () => window.clearTimeout(t);
  }, [justShown]);

  const api = useMemo<TipsApi>(
    () => ({
      ready: state !== null,
      showAll: state?.showAll ?? false,
      onScreen,
      nudge,
      justShown,
      shown: (key) => (state ? isShown(state, key) : false),
      register,
      choose: (keys, on) => {
        update((s) => chooseTips(s, keys, on));
        setJustShown(on ? keys : []);
      },
      setAll: (on) => {
        update((s) => setShowAll(s, on));
        setJustShown(on ? onScreen : []);
      },
    }),
    [state, onScreen, nudge, justShown, register, update],
  );

  return <TipsCtx.Provider value={api}>{children}</TipsCtx.Provider>;
}

const NONE: TipsApi = {
  ready: false,
  showAll: false,
  onScreen: [],
  nudge: false,
  justShown: [],
  shown: () => false,
  register: () => () => undefined,
  choose: () => undefined,
  setAll: () => undefined,
};

// Outside a provider (a share page, a test) tips stay hidden.
export const useTips = (): TipsApi => useContext(TipsCtx) ?? NONE;

// Puts this tip on the screen's list while it is mounted, and says whether it shows.
export function useTip(key: TipKey) {
  const tips = useTips();
  const { register } = tips;
  useEffect(() => register(key), [register, key]);
  return {
    shown: tips.ready && tips.shown(key),
    entering: tips.justShown.includes(key),
    hide: () => tips.choose([key], false),
  };
}

// The ? in the header: shows or hides this screen's tips. Hidden when the screen has none.
export function TipsButton() {
  const tips = useTips();
  if (!tips.ready || !tips.onScreen.length) return null;
  const anyShown = tips.onScreen.some((k) => tips.shown(k));
  const label = anyShown ? 'Hide the tips on this page' : 'Show the tips on this page';
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={anyShown}
        onClick={() => tips.choose(tips.onScreen, !anyShown)}
        className={`relative flex h-11 w-11 items-center justify-center rounded-control border transition-colors motion-reduce:transition-none sm:h-9 sm:w-9 ${
          anyShown ? 'border-accent-tint-line bg-accent-tint text-accent' : 'border-line bg-surface-1 text-text-muted hover:text-text'
        } ${tips.nudge ? 'tips-nudge' : ''}`}
      >
        <HelpCircle className="h-4 w-4" aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
