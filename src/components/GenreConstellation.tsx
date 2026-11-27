import React, { useEffect, useMemo, useState } from 'react';
import type { LoggedEvent } from '../services/lineupApi';
import type { ArtistGenres, GenreShare } from '../services/genres';
import { countedSets, formatSets } from '../services/genres';
import { OUTSIDE_MIN_WEIGHT } from '../services/genreInsights';
import type { GenreVocabulary, VocabGenre } from '../server/events/genreTypes';
import { genreKey, levelOf, NOT_GROUPED } from '../server/events/genreVocabulary';
import { PALETTE } from './GenreYearsChart';
import { Button } from './ui/Button';

interface GenreConstellationProps {
  events: LoggedEvent[];
  byArtist: Map<string, ArtistGenres>;
  vocabulary?: GenreVocabulary;
  onClose: () => void;
}

// Layout (docs/specs/genre-taxonomy-release-3.md decision 7 and section 9).
const VIEW = 620;
const C = 310;
const R_GENRE = 150; // the ring the genre dots sit on
const R_SPOKE_IN = 40;
const R_SPOKE_OUT = 175;
const R_LABEL = 200;
const DOT_MIN = 3;
const DOT_MAX = 14;
const DOT_FAINT = 1.6;
const DOT_NEIGHBOUR = 5;
const HIT_MIN = 9;
const LIST_MAX = 20;
const UNGROUPED_KEY = 'not-grouped';

interface ShareInfo {
  name: string;
  family?: string;
  macro?: string;
}

interface Listing {
  eventId: string;
  eventName: string;
  date: string;
  acts: string[];
}

interface GenreNode {
  key: string;
  name: string;
  familyName: string;
  macroName: string;
  sets: number;
  seen: boolean;
  neighbour: boolean;
  x: number;
  y: number;
  r: number;
  color: string;
}

interface FamilyGroup {
  key: string;
  name: string;
  ungrouped: boolean;
  genres: GenreNode[];
  angle: number; // start of the family's arc
}

interface MacroGroup {
  key: string;
  name: string;
  ungrouped: boolean;
  color: string;
  families: FamilyGroup[];
  labelAngle: number;
}

interface ConstellationModel {
  macros: MacroGroup[];
  nodes: Map<string, GenreNode>;
  edges: Array<[GenreNode, GenreNode]>;
  listings: Map<string, Listing[]>;
  maxSets: number;
  totalSeen: number;
}

const usable = (row?: ArtistGenres): GenreShare[] =>
  (row?.genres ?? []).filter((x) => genreKey(x.style) && x.weight > 0);

function dateOf(e: LoggedEvent): string {
  if (e.startDate) return e.startDate;
  if (e.year) return `${e.year}-${String(e.month ?? 1).padStart(2, '0')}`;
  return '';
}

function fmtDate(d: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    return new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }
  if (/^\d{4}-\d{2}$/.test(d)) {
    return new Date(`${d}-01T12:00:00Z`).toLocaleDateString(undefined, {
      timeZone: 'UTC',
      month: 'short',
      year: 'numeric',
    });
  }
  return d || 'Date not set';
}

function polar(r: number, angle: number): { x: number; y: number } {
  return { x: C + r * Math.cos(angle), y: C + r * Math.sin(angle) };
}

function buildModel(
  events: LoggedEvent[],
  byArtist: Map<string, ArtistGenres>,
  vocabulary: GenreVocabulary | undefined,
): ConstellationModel {
  const vocabGenres = vocabulary?.genres ?? [];
  const byKey = new Map<string, VocabGenre>();
  for (const g of vocabGenres) byKey.set(g.key, g);

  // Shown names and read-side family and macro from the stored shares, for genres with no vocabulary row.
  const info = new Map<string, ShareInfo>();
  for (const row of byArtist.values()) {
    for (const x of usable(row)) {
      const k = genreKey(x.style);
      if (!info.has(k)) info.set(k, { name: x.style, family: x.family, macro: x.macro });
    }
  }

  // Sets by genre key: attended events only, each set counted via countedSets and split by normalised weight.
  const sets = new Map<string, number>();
  const listings = new Map<string, Map<string, Listing>>();
  for (const e of events) {
    if (e.attendance === 'planned' || e.attendance === 'missed') continue;
    for (const s of countedSets(e, byArtist)) {
      const genres = usable(byArtist.get(s.key));
      if (!genres.length) continue;
      const share = s.sets;
      const total = genres.reduce((t, x) => t + x.weight, 0);
      for (const x of genres) {
        const k = genreKey(x.style);
        sets.set(k, (sets.get(k) ?? 0) + (share * x.weight) / total);
        let byEvent = listings.get(k);
        if (!byEvent) listings.set(k, (byEvent = new Map()));
        let row = byEvent.get(e.id);
        if (!row) byEvent.set(e.id, (row = { eventId: e.id, eventName: e.name, date: dateOf(e), acts: [] }));
        if (!row.acts.includes(s.name)) row.acts.push(s.name);
      }
    }
  }

  const seenKeys = new Set([...sets.entries()].filter(([, n]) => n > 0).map(([k]) => k));
  const genreKeys = new Set<string>(seenKeys);
  for (const g of vocabGenres) if (levelOf(g) === 'genre') genreKeys.add(g.key);

  // Adjacency from the vocabulary's adjacent relations, both directions.
  const adj = new Map<string, Map<string, number>>();
  const link = (a: string, b: string, w: number): void => {
    if (a === b || !(w > 0)) return;
    let row = adj.get(a);
    if (!row) adj.set(a, (row = new Map()));
    if ((row.get(b) ?? 0) < w) row.set(b, w);
  };
  for (const g of vocabGenres) {
    for (const r of g.relations ?? []) {
      if (r.type !== 'adjacent') continue;
      link(g.key, r.target, r.weight);
      link(r.target, g.key, r.weight);
    }
  }

  // Family and macro for each genre: the vocabulary's primaryParent links first, then the stored shares.
  const ungroupedFamily = { key: `family:${UNGROUPED_KEY}`, name: NOT_GROUPED };
  const ungroupedMacro = { key: `macro:${UNGROUPED_KEY}`, name: NOT_GROUPED };
  const familyOf = (key: string): { key: string; name: string; macro: { key: string; name: string; ungrouped: boolean } | null; ungrouped: boolean } => {
    const row = byKey.get(key);
    const shareInfo = info.get(key);
    let fam: { key: string; name: string } | undefined;
    const famRow = row?.primaryParent ? byKey.get(row.primaryParent) : undefined;
    if (famRow && levelOf(famRow) === 'family') fam = { key: famRow.key, name: famRow.name };
    else if (shareInfo?.family) fam = { key: `family:${genreKey(shareInfo.family)}`, name: shareInfo.family };
    if (!fam) return { ...ungroupedFamily, ungrouped: true, macro: null };
    const famVocab = byKey.get(fam.key);
    const macRow = famVocab?.primaryParent ? byKey.get(famVocab.primaryParent) : undefined;
    if (macRow && levelOf(macRow) === 'macro') {
      return { ...fam, ungrouped: false, macro: { key: macRow.key, name: macRow.name, ungrouped: false } };
    }
    if (shareInfo?.macro) {
      return {
        ...fam,
        ungrouped: false,
        macro: { key: `macro:${genreKey(shareInfo.macro)}`, name: shareInfo.macro, ungrouped: false },
      };
    }
    return { ...fam, ungrouped: false, macro: { ...ungroupedMacro, ungrouped: true } };
  };

  // Build the nodes, grouped by macro then family.
  const nodes = new Map<string, GenreNode>();
  const macroMap = new Map<string, { key: string; name: string; ungrouped: boolean; families: Map<string, { key: string; name: string; ungrouped: boolean; genres: GenreNode[] }> }>();
  let maxSets = 0;
  for (const s of sets.values()) if (s > maxSets) maxSets = s;
  for (const key of genreKeys) {
    const row = byKey.get(key);
    const shareInfo = info.get(key);
    const name = row?.name ?? shareInfo?.name ?? key;
    const fam = familyOf(key);
    const macro = fam.macro ?? { ...ungroupedMacro, ungrouped: true };
    const n = sets.get(key) ?? 0;
    const seen = seenKeys.has(key);
    const node: GenreNode = {
      key,
      name,
      familyName: fam.name,
      macroName: macro.name,
      sets: n,
      seen,
      neighbour: false,
      x: 0,
      y: 0,
      r: 0,
      color: '',
    };
    nodes.set(key, node);
    let m = macroMap.get(macro.key);
    if (!m) macroMap.set(macro.key, (m = { key: macro.key, name: macro.name, ungrouped: macro.ungrouped, families: new Map() }));
    let f = m.families.get(fam.key);
    if (!f) m.families.set(fam.key, (f = { key: fam.key, name: fam.name, ungrouped: fam.ungrouped, genres: [] }));
    f.genres.push(node);
  }

  // Unseen neighbours one step from a seen genre, by adjacent links of OUTSIDE_MIN_WEIGHT or more.
  for (const a of seenKeys) {
    for (const [b, w] of adj.get(a) ?? new Map<string, number>()) {
      if (w < OUTSIDE_MIN_WEIGHT || seenKeys.has(b)) continue;
      const node = nodes.get(b);
      if (node) node.neighbour = true;
    }
  }

  // Sort: macros by name, Not grouped last; families likewise; genres by name.
  const byName = (a: { name: string; ungrouped: boolean }, b: { name: string; ungrouped: boolean }): number =>
    Number(a.ungrouped) - Number(b.ungrouped) || a.name.localeCompare(b.name);
  const sortedMacros = [...macroMap.values()].sort(byName);
  const macros: MacroGroup[] = sortedMacros.map((m, mi) => {
    const families = [...m.families.values()]
      .sort(byName)
      .map((f) => ({
        key: f.key,
        name: f.name,
        ungrouped: f.ungrouped,
        genres: f.genres.sort((a, b) => a.name.localeCompare(b.name)),
        angle: 0,
      }));
    return { key: m.key, name: m.name, ungrouped: m.ungrouped, color: PALETTE[mi % PALETTE.length], families, labelAngle: 0 };
  });

  // Radial layout: macros as equal sectors, families as equal sub-arcs, genres evenly on the ring.
  const macroSpan = macros.length ? (2 * Math.PI) / macros.length : 0;
  macros.forEach((m, mi) => {
    const mStart = -Math.PI / 2 + mi * macroSpan;
    m.labelAngle = mStart + macroSpan / 2;
    const fSpan = m.families.length ? macroSpan / m.families.length : 0;
    m.families.forEach((f, fi) => {
      const fStart = mStart + fi * fSpan;
      f.angle = fStart;
      const count = f.genres.length;
      f.genres.forEach((g, gi) => {
        const angle = fStart + ((gi + 0.5) * fSpan) / count;
        const pos = polar(R_GENRE, angle);
        g.x = pos.x;
        g.y = pos.y;
        g.color = m.color;
        if (g.seen) g.r = Math.min(DOT_MAX, Math.max(DOT_MIN, DOT_MAX * Math.sqrt(g.sets / maxSets)));
        else g.r = g.neighbour ? DOT_NEIGHBOUR : DOT_FAINT;
      });
    });
  });

  // Faint lines between seen genres only, for adjacent links.
  const edges: Array<[GenreNode, GenreNode]> = [];
  for (const a of seenKeys) {
    for (const b of adj.get(a)?.keys() ?? []) {
      if (a < b && seenKeys.has(b)) {
        const na = nodes.get(a);
        const nb = nodes.get(b);
        if (na && nb) edges.push([na, nb]);
      }
    }
  }

  // Each seen genre's events, newest first, with the acts that carry the genre.
  const listingsOut = new Map<string, Listing[]>();
  for (const [k, byEvent] of listings) {
    listingsOut.set(
      k,
      [...byEvent.values()].sort((a, b) => b.date.localeCompare(a.date) || a.eventName.localeCompare(b.eventName)),
    );
  }

  return {
    macros,
    nodes,
    edges,
    listings: listingsOut,
    maxSets,
    totalSeen: seenKeys.size,
  };
}

export const GenreConstellation: React.FC<GenreConstellationProps> = ({ events, byArtist, vocabulary, onClose }) => {
  const [selected, setSelected] = useState<string | null>(null);
  const hasTaxonomy = (vocabulary?.genres ?? []).some((g) => levelOf(g) === 'macro');
  const model = useMemo(
    () => (hasTaxonomy ? buildModel(events, byArtist, vocabulary) : null),
    [events, byArtist, vocabulary, hasTaxonomy],
  );

  // Escape closes the list if it is open, otherwise the Constellation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (selected !== null) setSelected(null);
      else onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected, onClose]);

  const toggle = (key: string): void => setSelected((cur) => (cur === key ? null : key));

  const header = (
    <div className="flex items-center justify-between gap-2">
      <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-text-muted">The Constellation</h3>
      <Button variant="ghost" onClick={onClose}>
        Close
      </Button>
    </div>
  );

  if (!hasTaxonomy || !model) {
    return (
      <div className="space-y-3">
        {header}
        <p className="text-sm text-text-muted">The Constellation needs the genre tree.</p>
      </div>
    );
  }

  const selectedNode = selected !== null ? model.nodes.get(selected) ?? null : null;
  const selectedListing = selected !== null ? model.listings.get(selected) ?? [] : [];
  const seenNodes = [...model.nodes.values()]
    .filter((n) => n.seen)
    .sort((a, b) => b.sets - a.sets || a.name.localeCompare(b.name));
  const interactive = (n: GenreNode): boolean => n.seen || n.neighbour;

  return (
    <div className="space-y-3">
      {header}

      {model.totalSeen === 0 && (
        <p className="text-sm text-text-muted">No genres yet. The map lights up as your sets get genres.</p>
      )}

      <svg
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        role="group"
        aria-label="Genre constellation"
        className="mx-auto block h-auto w-full max-w-[36rem] text-text-muted"
      >
        {/* Sector spokes at every family boundary */}
        {model.macros.flatMap((m) =>
          m.families.map((f) => {
            const a = polar(R_SPOKE_IN, f.angle);
            const b = polar(R_SPOKE_OUT, f.angle);
            return (
              <line
                key={`spoke-${f.key}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="currentColor"
                strokeOpacity={0.15}
                strokeWidth={0.8}
              />
            );
          }),
        )}

        {/* Faint links between seen genres */}
        {model.edges.map(([a, b]) => (
          <line
            key={`edge-${a.key}-${b.key}`}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke="currentColor"
            strokeOpacity={0.3}
            strokeWidth={0.8}
          />
        ))}

        {/* Macro labels on the outer ring */}
        {model.macros.map((m) => {
          const p = polar(R_LABEL, m.labelAngle);
          const cos = Math.cos(m.labelAngle);
          const anchor = cos > 0.3 ? 'start' : cos < -0.3 ? 'end' : 'middle';
          return (
            <text
              key={`macro-${m.key}`}
              x={p.x}
              y={p.y}
              textAnchor={anchor}
              dominantBaseline="middle"
              fontSize={12}
              fontWeight={600}
              style={{ fill: m.color }}
            >
              {m.name}
            </text>
          );
        })}

        {/* Genre dots */}
        {[...model.nodes.values()].map((n) => {
          if (!interactive(n)) {
            return <circle key={n.key} cx={n.x} cy={n.y} r={n.r} fill={n.color} opacity={0.45} aria-hidden="true" />;
          }
          const isSelected = selected === n.key;
          const label = `${n.name}: ${formatSets(n.sets)} ${Math.round(n.sets) === 1 ? 'set' : 'sets'}`;
          return (
            <g key={n.key}>
              <circle
                cx={n.x}
                cy={n.y}
                r={Math.max(n.r, HIT_MIN)}
                fill="transparent"
                role="button"
                tabIndex={0}
                aria-label={label}
                aria-pressed={isSelected}
                className="cursor-pointer focus:outline-none"
                onClick={() => toggle(n.key)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggle(n.key);
                  }
                }}
              >
                <title>{label}</title>
              </circle>
              {n.seen ? (
                <circle cx={n.x} cy={n.y} r={n.r} fill={n.color} pointerEvents="none" />
              ) : (
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={n.r}
                  fill="none"
                  stroke={n.color}
                  strokeWidth={1.5}
                  pointerEvents="none"
                  className="motion-safe:animate-pulse"
                />
              )}
              {isSelected && (
                <circle cx={n.x} cy={n.y} r={n.r + 3} fill="none" stroke="currentColor" strokeWidth={1} pointerEvents="none" />
              )}
            </g>
          );
        })}
      </svg>

      {selectedNode && (
        <div
          role="region"
          aria-label={`Your sets in ${selectedNode.name}`}
          className="space-y-2 rounded-control border border-line bg-surface-2 p-3 text-sm"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-semibold text-text">{selectedNode.name}</p>
              <p className="text-xs text-text-muted">
                {selectedNode.familyName} · {selectedNode.macroName} · {formatSets(selectedNode.sets)}{' '}
                {Math.round(selectedNode.sets) === 1 ? 'set' : 'sets'}
              </p>
            </div>
            <Button variant="ghost" onClick={() => setSelected(null)}>
              Close list
            </Button>
          </div>
          {selectedListing.length === 0 ? (
            <p className="text-xs text-text-muted">No sets in this genre yet.</p>
          ) : (
            <>
              <ul className="space-y-1.5">
                {selectedListing.slice(0, LIST_MAX).map((row) => (
                  <li key={row.eventId} className="text-xs">
                    <span className="font-medium text-text">{row.eventName}</span>{' '}
                    <span className="text-text-muted">{fmtDate(row.date)}</span>
                    <p className="text-text-muted">{row.acts.join(', ')}</p>
                  </li>
                ))}
              </ul>
              {selectedListing.length > LIST_MAX && (
                <p className="text-[11px] text-text-faint">Newest {LIST_MAX} of {selectedListing.length} sets.</p>
              )}
            </>
          )}
        </div>
      )}

      <table className="sr-only">
        <caption>Your genres: family, macro and sets</caption>
        <thead>
          <tr>
            <th scope="col">Genre</th>
            <th scope="col">Family</th>
            <th scope="col">Macro</th>
            <th scope="col">Sets</th>
          </tr>
        </thead>
        <tbody>
          {seenNodes.map((n) => (
            <tr key={n.key}>
              <td>{n.name}</td>
              <td>{n.familyName}</td>
              <td>{n.macroName}</td>
              <td>{formatSets(n.sets)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
