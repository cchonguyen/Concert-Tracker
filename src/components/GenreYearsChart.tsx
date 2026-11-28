import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { LoggedEvent } from '../services/lineupApi';
import { formatSets, type ArtistGenres } from '../services/genres';
import {
  DRIFT_MIN_SETS,
  DRIFT_MIN_YEARS,
  driftDrivers,
  soundDrift,
  type SoundDriftResult,
  type SoundDriftYear,
} from '../services/genreInsights';
import type { GenreVocabulary } from '../server/events/genreTypes';
import { IconButton } from './ui/IconButton';
import { Segmented } from './ui/Segmented';

// Sound Drift: a stacked 100% area chart of genre shares by calendar year (docs/archive/genre-taxonomy-release-1.md section 5).
interface GenreYearsChartProps {
  events: LoggedEvent[];
  byArtist: Map<string, ArtistGenres>;
  vocabulary?: GenreVocabulary;
  today: string;
}

type Level = 'family' | 'macro';

// The chosen year and band. Tapping the same one again, or pressing Escape, clears it.
interface Selection {
  year: number;
  band: string;
}

export const PALETTE = [
  'var(--accent, #e11d48)',
  '#38bdf8',
  '#34d399',
  '#f59e0b',
  '#a78bfa',
  '#94a3b8',
];
const OTHER_COLOR = '#64748b';

const W = 600;
const H = 180;
const PAD_X = 16;
const PAD_Y = 14;

const LEVEL_OPTIONS: Array<{ value: Level; label: string }> = [
  { value: 'family', label: 'Family' },
  { value: 'macro', label: 'Macro' },
];

function bandColor(band: string, index: number): string {
  return band === 'Other' ? OTHER_COLOR : PALETTE[index % PALETTE.length];
}

// The band under a height v (0 at the bottom, 1 at the top) in one year's stack.
function bandAt(yr: SoundDriftYear, bands: string[], v: number): string | null {
  let base = 0;
  let last: string | null = null;
  for (const b of bands) {
    const s = yr.shares[b] ?? 0;
    if (s <= 0) continue;
    last = b;
    if (v < base + s) return b;
    base += s;
  }
  return last;
}

function largestBand(yr: SoundDriftYear, bands: string[]): string | null {
  let best: string | null = null;
  let bestShare = 0;
  for (const b of bands) {
    const s = yr.shares[b] ?? 0;
    if (s > bestShare) {
      best = b;
      bestShare = s;
    }
  }
  return best;
}

// The latest counted year where a band shows, or the latest year where it shows at all.
function yearForBand(drift: SoundDriftResult, band: string): number | null {
  const withBand = drift.years.filter((y) => (y.shares[band] ?? 0) > 0);
  const counted = withBand.filter((y) => y.counted);
  const pick = counted.length ? counted[counted.length - 1] : withBand[withBand.length - 1];
  return pick ? pick.year : null;
}

export const GenreYearsChart: React.FC<GenreYearsChartProps> = ({ events, byArtist, vocabulary, today }) => {
  const [level, setLevel] = useState<Level>('family');
  const [sel, setSel] = useState<Selection | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const drift = useMemo(
    () => soundDrift(events, byArtist, vocabulary, level, today),
    [events, byArtist, vocabulary, level, today],
  );
  const drivers = useMemo(
    () => (sel ? driftDrivers(events, byArtist, vocabulary, level, today, sel.year, sel.band) : null),
    [events, byArtist, vocabulary, level, today, sel],
  );

  useEffect(() => {
    if (!sel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSel(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sel]);

  if (!drift.enough) {
    return (
      <div className="space-y-3 rounded-card border border-line bg-surface-1 p-4 sm:p-5">
        <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-text-muted">Sound Drift</h3>
        <p className="text-sm text-text-muted">
          Sound Drift needs {DRIFT_MIN_YEARS} years with at least {DRIFT_MIN_SETS} sets that have a genre. You have{' '}
          {drift.countedYears}.
        </p>
      </div>
    );
  }

  const bands = drift.bands;
  const years = drift.years;
  const n = years.length;
  const innerW = W - PAD_X * 2;
  const innerH = H - PAD_Y * 2;
  const colW = n > 1 ? innerW / (n - 1) : innerW;
  const xAt = (i: number) => PAD_X + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yAt = (share: number) => PAD_Y + (1 - Math.max(0, Math.min(1, share))) * innerH;

  // Cumulative stacked bands, bottom band first.
  const paths = bands.map((name, bIdx) => {
    const topPoints: Array<[number, number]> = [];
    const botPoints: Array<[number, number]> = [];
    years.forEach((yr, i) => {
      let base = 0;
      for (let k = 0; k < bIdx; k++) base += yr.shares[bands[k]] ?? 0;
      const top = Math.min(1, base + (yr.shares[name] ?? 0));
      const x = xAt(i);
      topPoints.push([x, yAt(top)]);
      botPoints.push([x, yAt(base)]);
    });
    const d = [
      `M ${topPoints[0][0]} ${topPoints[0][1]}`,
      ...topPoints.slice(1).map(([x, y]) => `L ${x} ${y}`),
      ...botPoints.reverse().map(([x, y]) => `L ${x} ${y}`),
      'Z',
    ].join(' ');
    return { name, color: bandColor(name, bIdx), d };
  });

  const selYear = sel ? years.find((y) => y.year === sel.year) : undefined;
  const panelBands = selYear ? bands.filter((b) => (selYear.shares[b] ?? 0) > 0) : [];
  const leaderText = drift.leaders
    .map((l, i) => {
      const span = l.from === l.to ? `${l.from}` : `${l.from} to ${l.to}`;
      return `${i === 0 ? '' : 'then '}${l.band} (${span})`;
    })
    .join(', ');

  const toggleBand = (year: number, band: string) =>
    setSel((cur) => (cur && cur.year === year && cur.band === band ? null : { year, band }));

  const toggleYear = (yr: SoundDriftYear) => {
    const band = largestBand(yr, bands);
    if (!band) return;
    setSel((cur) => (cur && cur.year === yr.year ? null : { year: yr.year, band }));
  };

  const pickBand = (band: string) => {
    const year = yearForBand(drift, band);
    if (year !== null) toggleBand(year, band);
  };

  // A tap on the chart picks the band under the pointer in that year's column.
  const pickColumn = (yr: SoundDriftYear, clientY: number) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.height === 0) return;
    const svgY = ((clientY - box.top) / box.height) * H;
    const v = 1 - (svgY - PAD_Y) / innerH;
    const band = bandAt(yr, bands, Math.max(0, Math.min(1, v)));
    if (band) toggleBand(yr.year, band);
  };

  const changeLevel = (next: Level) => {
    setLevel(next);
    setSel(null);
  };

  return (
    <div className="space-y-3 rounded-card border border-line bg-surface-1 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-text-muted">Sound Drift</h3>
          <p className="text-xs text-text-muted">Your sets by genre, year by year.</p>
        </div>
        {drift.levels === 'taxonomy' && (
          <Segmented label="Group genres by" options={LEVEL_OPTIONS} value={level} onChange={changeLevel} compact />
        )}
      </div>

      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Share of your sets by genre, for each year"
          className="h-44 w-full overflow-visible"
        >
          {paths.map((b) => (
            <path key={b.name} d={b.d} fill={b.color} fillOpacity={0.85} />
          ))}

          {years.map((yr, i) => {
            const x = xAt(i);
            const left = i === 0 ? PAD_X : x - colW / 2;
            const width = i === 0 || i === n - 1 ? colW / 2 : colW;
            return (
              <g key={yr.year}>
                {!yr.counted && (
                  <rect
                    x={left}
                    y={PAD_Y}
                    width={width}
                    height={innerH}
                    fill="var(--surface-1, #111)"
                    fillOpacity={0.55}
                    pointerEvents="none"
                  />
                )}
                {sel?.year === yr.year && (
                  <line
                    x1={x}
                    y1={PAD_Y}
                    x2={x}
                    y2={H - PAD_Y}
                    stroke="var(--text, #fff)"
                    strokeWidth={1.5}
                    strokeDasharray="3 3"
                    vectorEffect="non-scaling-stroke"
                    pointerEvents="none"
                  />
                )}
                <rect
                  x={left}
                  y={PAD_Y}
                  width={width}
                  height={innerH}
                  fill="transparent"
                  aria-hidden="true"
                  onClick={(e) => pickColumn(yr, e.clientY)}
                  style={{ cursor: 'pointer' }}
                />
              </g>
            );
          })}
        </svg>

        <div className="flex gap-0.5 px-[2.67%]" role="group" aria-label="Years">
          {years.map((yr) => {
            const on = sel?.year === yr.year;
            return (
              <button
                key={yr.year}
                type="button"
                aria-pressed={on}
                aria-label={`${yr.year}${yr.counted ? '' : ', not counted, fewer than 10 sets'}`}
                onClick={() => toggleYear(yr)}
                className={`min-h-11 min-w-0 flex-1 rounded-control font-mono text-[10px] tabular-nums transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent sm:min-h-9 ${
                  on ? 'font-semibold text-text' : yr.counted ? 'text-text-muted hover:text-text' : 'text-text-faint opacity-60'
                }`}
              >
                {`’${String(yr.year).slice(-2)}`}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-text-muted">
        {bands.map((b, i) => {
          const on = sel?.band === b;
          return (
            <button
              key={b}
              type="button"
              aria-pressed={on}
              onClick={() => pickBand(b)}
              className={`inline-flex min-h-11 items-center gap-1.5 rounded-control px-1.5 transition-colors hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent sm:min-h-9 ${
                on ? 'font-semibold text-text' : ''
              }`}
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: bandColor(b, i) }} aria-hidden="true" />
              <span>{b}</span>
            </button>
          );
        })}
      </div>

      {sel && selYear && drivers && (
        <div className="space-y-3 rounded-control border border-line bg-surface-2 p-3 text-sm">
          <div className="flex items-start justify-between gap-2">
            <p className="font-semibold text-text">
              {sel.band} in {sel.year}
            </p>
            <IconButton icon={X} label="Close" onClick={() => setSel(null)} />
          </div>

          {panelBands.length > 1 && (
            <Segmented
              label={`Band in ${sel.year}`}
              options={panelBands.map((b) => ({ value: b, label: b }))}
              value={sel.band}
              onChange={(band) => setSel({ year: sel.year, band })}
              compact
            />
          )}

          {drivers.sets.length === 0 ? (
            <p className="text-xs text-text-muted">No sets in this band that year.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <h4 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-muted">Artists</h4>
                <ul className="space-y-1">
                  {drivers.artists.map((a) => {
                    const count = formatSets(a.sets);
                    return (
                      <li key={a.key} className="flex justify-between gap-2 text-xs">
                        <span className="text-text">{a.name}</span>
                        <span className="shrink-0 font-mono tabular-nums text-text-muted">
                          {count} {count === '1' ? 'set' : 'sets'}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div className="space-y-1.5">
                <h4 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-text-muted">Sets</h4>
                <ul className="space-y-1">
                  {drivers.sets.map((s, i) => (
                    <li key={`${s.eventId}-${s.act}-${i}`} className="text-xs">
                      <span className="font-mono tabular-nums text-text-muted">{s.date}</span>{' '}
                      <span className="text-text">{s.eventName}</span>{' '}
                      <span className="text-text-muted">({s.act})</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      )}

      {leaderText && <p className="text-sm font-medium text-text">Your lead sound: {leaderText}.</p>}

      <p className="text-[11px] text-text-faint">
        Shares split each set across its act&apos;s genres by weight. Faded years have fewer than {DRIFT_MIN_SETS} sets and
        are not counted in the lead sound.
      </p>

      <table className="sr-only">
        <caption>Sound Drift: share of sets by genre, by year</caption>
        <thead>
          <tr>
            <th>Year</th>
            <th>Sets</th>
            {bands.map((b) => (
              <th key={b}>{b}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {years.map((yr) => (
            <tr key={yr.year}>
              <td>{`${yr.year}${yr.counted ? '' : ' (not counted)'}`}</td>
              <td>{formatSets(yr.known)}</td>
              {bands.map((b) => (
                <td key={b}>{Math.round((yr.shares[b] ?? 0) * 100)}%</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
