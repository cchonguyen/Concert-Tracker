import React from 'react';
import type { ArtistOrbit } from '../server/events/artistOrbits';
import type { LoggedEvent } from '../services/lineupApi';
import { whenLabel } from '../services/format';
import { EventTitle } from './EventTitle';
import { Sheet } from './ui/Sheet';
import { Pill } from './ui/Pill';

// "A · B · C lane", from the anchors' names. The working label is shown as the subtitle.
export const orbitLabel = (orbit: ArtistOrbit, nameOf: (key: string) => string): string =>
  `${orbit.anchorKeys.map((k) => nameOf(k)).join(' · ')} lane`;

const MAX_EVENTS = 10;

// Your events with any act in the orbit: planned first (soonest first), then the rest newest first. Missed shows are left out.
const orbitEvents = (orbit: ArtistOrbit, events: LoggedEvent[]): LoggedEvent[] => {
  const keys = new Set(orbit.members.map((m) => m.artistKey));
  const hits = events.filter((e) => e.seen.some((s) => keys.has(s.key)));
  // Undated events go last in either direction.
  const byDate = (dir: 1 | -1) => (a: LoggedEvent, b: LoggedEvent) => {
    if (!a.startDate && !b.startDate) return 0;
    if (!a.startDate) return 1;
    if (!b.startDate) return -1;
    return dir * a.startDate.localeCompare(b.startDate);
  };
  const planned = hits.filter((e) => e.attendance === 'planned').sort(byDate(1));
  const past = hits.filter((e) => e.attendance !== 'planned' && e.attendance !== 'missed').sort(byDate(-1));
  return [...planned, ...past].slice(0, MAX_EVENTS);
};

const Section: React.FC<{ title: string; keys: string[]; nameOf: (key: string) => string; seen: Set<string> }> = ({ title, keys, nameOf, seen }) => {
  if (!keys.length) return null;
  return (
    <div>
      <h4 className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{title}</h4>
      <ul className="mt-1 divide-y divide-line">
        {keys.map((k) => (
          <li key={k} className="flex items-center justify-between gap-3 py-1.5 text-sm">
            <span className="min-w-0 truncate text-text">{nameOf(k)}</span>
            {seen.has(k) && <span className="shrink-0 text-xs text-good">Seen</span>}
          </li>
        ))}
      </ul>
    </div>
  );
};

interface OrbitSheetProps {
  orbit: ArtistOrbit;
  nameOf: (key: string) => string;
  seen: Set<string>; // the act keys in your seen lists
  events: LoggedEvent[];
  onOpenEvent: (id: string) => void;
  onClose: () => void;
}

// One orbit: its roster, which of its acts you've seen, and your events with them. Escape and the close button dismiss it.
export const OrbitSheet: React.FC<OrbitSheetProps> = ({ orbit, nameOf, seen, events, onOpenEvent, onClose }) => {
  const title = orbitLabel(orbit, nameOf);
  const anchors = new Set(orbit.anchorKeys);
  const core = orbit.members.filter((m) => !anchors.has(m.artistKey) && m.centrality === 0.5).map((m) => m.artistKey);
  const crossover = orbit.members.filter((m) => !anchors.has(m.artistKey) && m.centrality === 0.25).map((m) => m.artistKey);
  const mine = orbitEvents(orbit, events);
  return (
    <Sheet open title={title} onClose={onClose}>
      {orbit.workingLabel && <p className="-mt-2 text-xs text-text-muted">{orbit.workingLabel}</p>}

      <div className="space-y-4">
        <Section title="Anchors" keys={orbit.anchorKeys} nameOf={nameOf} seen={seen} />
        <Section title="Core" keys={core} nameOf={nameOf} seen={seen} />
        <Section title="Crossover" keys={crossover} nameOf={nameOf} seen={seen} />
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-text">Your events with these acts</h3>
        {mine.length === 0 ? (
          <p className="text-sm text-text-muted">None of your events has these acts yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {mine.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => onOpenEvent(e.id)}
                  className="group flex min-h-11 w-full flex-col gap-0.5 rounded-control px-2 py-1.5 text-left text-sm row-hover"
                >
                  <span className="flex flex-wrap items-center gap-2 font-mono text-xs tabular-nums text-text-muted">
                    {whenLabel(e) ?? 'Date unknown'}
                    {e.attendance === 'planned' && <Pill tone="info">Planned</Pill>}
                  </span>
                  <span className="min-w-0 truncate text-text group-hover:text-accent">
                    <EventTitle event={e} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );
};
