import { useEffect, useState, type FC } from 'react';
import { genresApi, type LineupGenresAct } from '../services/lineupApi';
import { genresByArtist } from '../services/genres';
import { lineupDna, LINEUP_DNA_MIN_ACTS, type DnaBar, type DnaSegment, type LineupDnaResult } from '../services/genreInsights';
import { POPOVER_PANEL } from './ui/Popover';
import { PALETTE } from './GenreYearsChart';

interface Props {
  eventId: string;
  refreshKey?: string | number; // Changes when the lineup changes, so the bar is worked out again.
}

// Other is a neutral token.
const OTHER_FILL = 'var(--line-strong)';

const pct = (share: number): string => `${Math.round(share * 100)}%`;

interface Loaded {
  dna: LineupDnaResult;
  names: Map<string, string>;
}

// The bar shows nothing until the lineup has genres; a failed request shows nothing at all.
export const LineupDna: FC<Props> = ({ eventId, refreshKey }) => {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [open, setOpen] = useState<string | null>(null); // 'barId|segmentKey' of the panel showing

  useEffect(() => {
    let live = true;
    setLoaded(null);
    setOpen(null);
    Promise.all([genresApi.getLineupGenres(eventId), genresApi.list()])
      .then(([lineup, list]) => {
        if (!live) return;
        const acts: LineupGenresAct[] = lineup.acts;
        if (acts.length === 0) return;
        const byArtist = genresByArtist(lineup.genres, list.vocabulary, list.map);
        const dna = lineupDna(acts, byArtist, list.vocabulary);
        setLoaded({ dna, names: new Map(acts.map((a) => [a.key, a.name])) });
      })
      .catch(() => {
        if (live) setLoaded(null);
      });
    return () => {
      live = false;
    };
  }, [eventId, refreshKey]);

  // Escape closes the open panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!loaded) return null;
  const { dna, names } = loaded;
  // Colours follow the segment order within each bar, as Sound Drift does; Other is neutral.
  const colourFor = (seg: DnaSegment, index: number): string => (seg.key === 'other' ? OTHER_FILL : PALETTE[index % PALETTE.length]);

  return (
    <section aria-labelledby="lineup-dna-heading" className="space-y-3">
      <h4 id="lineup-dna-heading" className="font-mono text-xs uppercase tracking-wide text-text-muted">
        Lineup DNA
      </h4>
      {dna.bars.map((bar: DnaBar) => {
        const panelFor = (seg: DnaSegment) => `${bar.id}|${seg.key}`;
        const shown = bar.segments.map((seg, i) => ({ seg, colour: colourFor(seg, i) }));
        const current = bar.segments.find((s) => open === panelFor(s));
        return (
          <div key={bar.id} className="space-y-1.5">
            <p className="text-sm text-text">{bar.name}</p>
            {!bar.enough && (
              <p className="text-xs text-text-muted">
                Lineup DNA shows once {LINEUP_DNA_MIN_ACTS} acts on the bill have a genre. {bar.tagged} do.
              </p>
            )}
            {bar.enough && (
              <>
                <div className="flex w-full">
                  {shown.map(({ seg, colour }) => (
                    <button
                      key={seg.key}
                      type="button"
                      aria-label={`${seg.name}, ${pct(seg.share)} of ${bar.name}`}
                      aria-expanded={open === panelFor(seg)}
                      onClick={() => setOpen(open === panelFor(seg) ? null : panelFor(seg))}
                      style={{ width: pct(seg.share) }}
                      className="flex h-11 min-w-0 items-center rounded-control focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:h-6"
                    >
                      <span className="h-3 w-full rounded-control" style={{ backgroundColor: colour }} aria-hidden="true" />
                    </button>
                  ))}
                </div>
                {current && (
                  <div role="dialog" aria-label={`${current.name} in ${bar.name}`} className={`${POPOVER_PANEL} space-y-2`}>
                    <p className="font-medium">
                      {current.name} <span className="font-normal text-text-muted">· {pct(current.share)}</span>
                    </p>
                    {current.genres.length > 0 && (
                      <ul className="space-y-0.5 text-xs text-text-muted">
                        {current.genres.map((g) => (
                          <li key={g.name}>
                            {g.name} · {pct(g.share)}
                          </li>
                        ))}
                      </ul>
                    )}
                    {current.acts.length > 0 && (
                      <p className="text-xs text-text-muted">{current.acts.map((k) => names.get(k) ?? k).join(', ')}</p>
                    )}
                  </div>
                )}
                {bar.lowCoverage && (
                  <p className="text-xs text-text-muted">
                    {bar.tagged} of {bar.total} acts have a genre.
                  </p>
                )}
              </>
            )}
          </div>
        );
      })}
      <table className="sr-only">
        <caption>Lineup DNA numbers</caption>
        <thead>
          <tr>
            <th scope="col">Bar</th>
            <th scope="col">Family</th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          {dna.bars.flatMap((bar) => [
            <tr key={`${bar.id}-coverage`}>
              <td>{bar.name}</td>
              <td>Acts with a genre</td>
              <td>
                {bar.tagged} of {bar.total}
              </td>
            </tr>,
            ...bar.segments.map((seg) => (
              <tr key={`${bar.id}-${seg.key}`}>
                <td>{bar.name}</td>
                <td>{seg.name}</td>
                <td>{pct(seg.share)}</td>
              </tr>
            )),
          ])}
        </tbody>
      </table>
    </section>
  );
};
