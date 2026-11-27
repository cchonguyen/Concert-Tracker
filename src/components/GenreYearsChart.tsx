import React, { useState } from 'react';
import { YEARS_MIN_COUNTED, type GenreByYearResult } from '../services/genreInsights';

interface GenreYearsChartProps {
  data: GenreByYearResult;
  storyLine: string | null;
}

const PALETTE = [
  'var(--accent, #e11d48)',
  '#38bdf8',
  '#34d399',
  '#f59e0b',
  '#a78bfa',
  '#94a3b8',
];

const W = 600;
const H = 180;
const PAD_X = 16;
const PAD_Y = 14;

export const GenreYearsChart: React.FC<GenreYearsChartProps> = ({ data, storyLine }) => {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  if (data.countedYears < YEARS_MIN_COUNTED || data.years.length < 2) return null;

  const series = [...data.groups, ...(data.hasOther ? ['Other'] : [])];
  const n = data.years.length;
  const innerW = W - PAD_X * 2;
  const innerH = H - PAD_Y * 2;
  const xAt = (i: number) => PAD_X + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yAt = (share: number) => PAD_Y + (1 - Math.max(0, Math.min(1, share))) * innerH;

  // Build cumulative stacked bands per series.
  const bands = series.map((name, sIdx) => {
    const topPoints: Array<[number, number]> = [];
    const botPoints: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) {
      const yr = data.years[i];
      let base = 0;
      for (let k = 0; k < sIdx; k++) base += yr.shares[series[k]] ?? 0;
      const top = Math.min(1, base + (yr.shares[name] ?? 0));
      const x = xAt(i);
      topPoints.push([x, yAt(top)]);
      botPoints.push([x, yAt(base)]);
    }
    const d = [
      `M ${topPoints[0][0]} ${topPoints[0][1]}`,
      ...topPoints.slice(1).map(([x, y]) => `L ${x} ${y}`),
      ...botPoints.reverse().map(([x, y]) => `L ${x} ${y}`),
      'Z',
    ].join(' ');
    return { name, color: PALETTE[sIdx % PALETTE.length], d };
  });

  const active = activeIdx !== null ? data.years[activeIdx] ?? null : null;
  const colW = n > 1 ? innerW / (n - 1) : innerW;

  return (
    <div className="space-y-3 rounded-card border border-line bg-surface-1 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-text-muted">
            Over the years
          </h3>
          {storyLine && <p className="mt-1 text-sm font-medium text-text">{storyLine}</p>}
        </div>
        {active && (
          <p className="font-mono text-xs tabular-nums text-text-muted">
            {active.year} · {active.knownSets} {active.knownSets === 1 ? 'set' : 'sets'}
            {active.thin ? ' (fewer than 10)' : ''}
          </p>
        )}
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="Genre share over the years"
          className="h-44 w-full overflow-visible"
          onMouseLeave={() => setActiveIdx(null)}
        >
          {bands.map((b) => (
            <path key={b.name} d={b.d} fill={b.color} fillOpacity={0.85} />
          ))}

          {data.years.map((yr, i) => {
            const x = xAt(i);
            const left = i === 0 ? PAD_X : x - colW / 2;
            const width = i === 0 || i === n - 1 ? colW / 2 : colW;
            return (
              <g key={yr.year}>
                {yr.thin && (
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
                {activeIdx === i && (
                  <line
                    x1={x}
                    y1={PAD_Y}
                    x2={x}
                    y2={H - PAD_Y}
                    stroke="var(--text, #fff)"
                    strokeWidth={1.5}
                    strokeDasharray="3 3"
                    pointerEvents="none"
                  />
                )}
                <rect
                  x={left}
                  y={PAD_Y}
                  width={width}
                  height={innerH}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${yr.year}: ${yr.knownSets} sets`}
                  onMouseEnter={() => setActiveIdx(i)}
                  onFocus={() => setActiveIdx(i)}
                  onBlur={() => setActiveIdx(null)}
                />
              </g>
            );
          })}
        </svg>

        <div className="flex justify-between px-2 font-mono text-[10px] tabular-nums text-text-muted">
          <span>{data.years[0].year}</span>
          {data.years.length > 2 && <span>{data.years[Math.floor(data.years.length / 2)].year}</span>}
          <span>{data.years[data.years.length - 1].year}</span>
        </div>
      </div>

      {active && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 rounded-control border border-line bg-surface-2 px-3 py-1.5 text-xs">
          {series
            .filter((name) => (active.shares[name] ?? 0) > 0)
            .map((name) => (
              <span key={name} className="font-mono tabular-nums text-text-muted">
                <span className="text-text">{name}</span> {Math.round((active.shares[name] ?? 0) * 100)}%
              </span>
            ))}
        </div>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-text-muted">
        {bands.map((b) => (
          <span key={b.name} className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: b.color }} aria-hidden="true" />
            <span>{b.name}</span>
          </span>
        ))}
      </div>

      <p className="text-[11px] text-text-faint">
        Shares split each set across its act&apos;s genres by weight. Faded years have fewer than 10 sets.
      </p>

      <table className="sr-only">
        <caption>Genre share by year</caption>
        <thead>
          <tr>
            <th>Year</th>
            <th>Sets</th>
            {series.map((s) => (
              <th key={s}>{s}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.years.map((yr) => (
            <tr key={yr.year}>
              <td>{yr.year}</td>
              <td>{yr.knownSets}</td>
              {series.map((s) => (
                <td key={s}>{Math.round((yr.shares[s] ?? 0) * 100)}%</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
