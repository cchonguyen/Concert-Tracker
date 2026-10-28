import React, { useEffect, useState } from 'react';
import { GitMerge, Loader2, MapPin } from 'lucide-react';
import { entitiesApi, LoggedEvent } from '../services/lineupApi';
import type { Entity, HistoryEntry } from '../server/entities/types';
import { entityLabel, KINDS, ManageData } from './ManageView';

// Data health in the Manage tab: what needs your call to keep records from
// drifting. Records that look like the same one (merge, or leave them), and
// venues whose events disagree on the city (pick the venue's city). Nothing
// here changes on its own; every change can be undone from History.

interface DataHealthProps {
  data: ManageData;
  counts: Map<string, LoggedEvent[]>; // events per record
  onOpen: (id: string) => void;
  onChanged: (entry: HistoryEntry, eventsToo?: boolean) => Promise<void>;
}

type VenuePlaces = Awaited<ReturnType<typeof entitiesApi.health>>['venuePlaces'];

const sectionTitle = 'text-xs font-bold uppercase tracking-wide text-zinc-500';
const chip =
  'inline-flex items-center gap-1 rounded-full border border-zinc-800 px-2.5 py-1 text-xs text-zinc-200 hover:border-violet-500/60 hover:text-violet-200 disabled:opacity-40';

export const DataHealth: React.FC<DataHealthProps> = ({ data, counts, onOpen, onChanged }) => {
  const [venues, setVenues] = useState<VenuePlaces | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [merging, setMerging] = useState<{ from: Entity; into: Entity } | null>(null);
  const byId = new Map(data.entities.map((e) => [e.id, e]));
  const n = (id: string) => counts.get(id)?.length ?? 0;

  const load = () =>
    entitiesApi
      .health()
      .then((h) => setVenues(h.venuePlaces))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  useEffect(() => {
    void load();
  }, [data]);

  const run = async (what: string, fn: () => Promise<HistoryEntry | null>, done?: (entry: HistoryEntry | null) => void) => {
    setBusy(what);
    setError(null);
    try {
      const entry = await fn();
      if (entry) await onChanged(entry, true);
      done?.(entry);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  // Look-alike groups with every record still live, most used first.
  const groups = data.duplicates
    .map((g) => g.map((id) => byId.get(id)).filter((e): e is Entity => Boolean(e && !e.mergedIntoId)))
    .filter((g) => g.length > 1)
    .map((g) => [...g].sort((a, b) => n(b.id) - n(a.id) || entityLabel(a).localeCompare(entityLabel(b))));
  const disagree = (venues ?? []).filter((v) => byId.get(v.venueId) && !byId.get(v.venueId)!.mergedIntoId);

  return (
    <section className="space-y-6">
      <p className="text-xs text-zinc-500">
        Things that need your call to keep names consistent. Nothing here changes on its own, and every change can be undone from
        History.
      </p>
      {error && <p className="rounded-lg border border-rose-500/30 bg-rose-950/30 p-2.5 text-sm text-rose-200">{error}</p>}

      <div className="space-y-2">
        <h3 className={sectionTitle}>Venues whose events disagree on the city</h3>
        {!venues ? (
          <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
        ) : !disagree.length ? (
          <p className="text-sm text-zinc-500">None. Every venue with a city on its events is in one place.</p>
        ) : (
          <ul className="space-y-2">
            {disagree.map((v) => {
              const venue = byId.get(v.venueId)!;
              return (
                <li key={v.venueId} className="space-y-2 rounded-xl border border-zinc-900 p-3">
                  <p className="text-sm text-zinc-200">
                    <button onClick={() => onOpen(venue.id)} className="font-semibold hover:text-violet-300">
                      {venue.name}
                    </button>{' '}
                    <span className="text-zinc-500">is in which city? Its events will all take the one you pick.</span>
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {v.places.map((p) => {
                      const place = byId.get(p.placeId);
                      if (!place) return null;
                      return (
                        <button
                          key={p.placeId}
                          onClick={() => void run(`venue:${v.venueId}`, () => entitiesApi.link(v.venueId, p.placeId, 'in'))}
                          disabled={Boolean(busy)}
                          className={chip}
                        >
                          {busy === `venue:${v.venueId}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <MapPin className="h-3 w-3" />}
                          {entityLabel(place)}
                          <span className="text-zinc-500">
                            {p.events} event{p.events === 1 ? '' : 's'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <button
          onClick={() =>
            void run('venues', () => entitiesApi.linkVenuePlaces(), (entry) => {
              if (!entry) setError('No venue to put in a city: every venue whose events share one city already has it.');
            })
          }
          disabled={Boolean(busy)}
          className="text-xs text-zinc-400 hover:text-violet-300 disabled:opacity-40"
        >
          {busy === 'venues' ? 'Working…' : 'Put venues whose events all share a city in it'}
        </button>
      </div>

      <div className="space-y-2">
        <h3 className={sectionTitle}>Look-alikes</h3>
        {!groups.length ? (
          <p className="text-sm text-zinc-500">None. No two records differ only by spacing, a leading “the”, or “and”.</p>
        ) : (
          <ul className="space-y-2">
            {groups.map((g) => {
              const kind = KINDS.find((k) => k.kind === g[0].kind)!;
              return (
                <li key={g.map((e) => e.id).join()} className="space-y-2 rounded-xl border border-zinc-900 p-3">
                  <p className="text-[11px] uppercase tracking-wide text-zinc-500">{kind.one}</p>
                  <ul className="space-y-1">
                    {g.map((e) => (
                      <li key={e.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                        <button onClick={() => onOpen(e.id)} className="text-zinc-100 hover:text-violet-300">
                          {entityLabel(e)}
                        </button>
                        <span className="text-xs text-zinc-500">
                          {n(e.id)} event{n(e.id) === 1 ? '' : 's'}
                        </span>
                        {g
                          .filter((o) => o.id !== e.id)
                          .map((into) => (
                            <button key={into.id} onClick={() => setMerging({ from: e, into })} disabled={Boolean(busy)} className={chip}>
                              <GitMerge className="h-3 w-3" /> into {entityLabel(into)}
                            </button>
                          ))}
                      </li>
                    ))}
                  </ul>
                  {merging && g.includes(merging.from) && (
                    <div className="space-y-2 rounded-lg border border-violet-500/30 bg-violet-950/20 p-2.5 text-sm text-zinc-200">
                      <p>
                        Merge “{entityLabel(merging.from)}” into “{entityLabel(merging.into)}”? Its {n(merging.from.id)} event
                        {n(merging.from.id) === 1 ? '' : 's'} will show “{entityLabel(merging.into)}”
                        {merging.from.kind !== 'place' && <>, and “{merging.from.name}” becomes an AKA</>}.
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={() =>
                            void run('merge', () => entitiesApi.merge(merging.from.id, merging.into.id), () => setMerging(null))
                          }
                          disabled={Boolean(busy)}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-40"
                        >
                          {busy === 'merge' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitMerge className="h-3.5 w-3.5" />} Merge
                        </button>
                        <button onClick={() => setMerging(null)} className="rounded-lg border border-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:text-zinc-100">
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
};
