import React, { useEffect, useState } from 'react';
import { GitMerge, MapPin, Sparkles, Tag } from 'lucide-react';
import { entitiesApi, eventsApi, LoggedEvent } from '../services/lineupApi';
import type { Entity, HistoryEntry } from '../server/entities/types';
import { entityLabel, KINDS, ManageData } from './ManageView';
import { categoryGaps, linkedSuggestions, placeOfferVenues, rareLabels, recentAutoLinks, venuesWithoutPlace } from '../services/dataHealth';
import { Equalizer } from './ui/Equalizer';
import { Ledger } from './ui/Ledger';
import { SeriesHealth } from './SeriesHealth';
import { useIsOwner } from './MeContext';

// Data health in the Manage tab: what needs your call to keep records from
// drifting. Records that look like the same one (merge, or leave them),
// venues whose events disagree on the city (pick the venue's city), label
// groups some records lack, labels offered from linked records, labels used
// once, venues with no place, and cities a save brought that the venue's
// place replaced (src/services/dataHealth.ts). Nothing
// here changes on its own; every change can be undone from History.

interface DataHealthProps {
  data: ManageData;
  events: LoggedEvent[];
  counts: Map<string, LoggedEvent[]>; // events per record
  onOpen: (id: string) => void;
  onChanged: (entry: HistoryEntry, eventsToo?: boolean) => Promise<void>;
}

type VenuePlaces = Awaited<ReturnType<typeof entitiesApi.health>>['venuePlaces'];

const sectionTitle = 'text-xs font-bold uppercase tracking-wide text-text-muted';
const chip =
  'inline-flex min-h-11 sm:min-h-9 items-center gap-1 rounded-full border border-line-strong px-2.5 py-1 text-xs text-text hover:border-accent hover:text-accent disabled:opacity-40';

export const DataHealth: React.FC<DataHealthProps> = ({ data, events, counts, onOpen, onChanged }) => {
  const isOwner = useIsOwner();
  const [venues, setVenues] = useState<VenuePlaces | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [merging, setMerging] = useState<{ from: Entity; into: Entity } | null>(null);
  const [unlinked, setUnlinked] = useState<Set<string>>(() => new Set());
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
  const input = { entities: data.entities, links: data.links, events };
  const gaps = categoryGaps(input);
  const offers = linkedSuggestions(input);
  const rare = rareLabels(input);
  const unplaced = venuesWithoutPlace(input);
  const offered = placeOfferVenues(data.entities);
  const label = (kind: string, n: number) => `${n} ${KINDS.find((k) => k.kind === kind)?.[n === 1 ? 'one' : 'label'].toLowerCase() ?? kind}`;
  const addLabel = (recordId: string, labelId: string) =>
    void run(`label:${recordId}:${labelId}`, () => entitiesApi.link(recordId, labelId, 'has_label'));
  const autoLinked = recentAutoLinks(events, new Date()).filter((e) => !unlinked.has(e.id));
  const unlink = async (id: string) => {
    setBusy(`unlink:${id}`);
    setError(null);
    try {
      await eventsApi.unlink(id);
      setUnlinked((prev) => new Set(prev).add(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const disagree = (venues ?? []).filter((v) => byId.get(v.venueId) && !byId.get(v.venueId)!.mergedIntoId);

  return (
    <section className="space-y-6">
      <p className="text-xs text-text-muted">
        Things that need your call to keep names consistent. Nothing here changes on its own, and every change can be undone from
        History.
      </p>
      {error && <p className="rounded-card border border-bad/45 bg-bad/10 p-2.5 text-sm text-bad">{error}</p>}

      {autoLinked.length > 0 && (
        <div className="space-y-2">
          <h3 className={sectionTitle}>Linked automatically</h3>
          <p className="text-xs text-text-muted">
            These events had the same date, name and venue as one shared edition, so they were linked to it. What you typed still shows.
            Unlink one to keep it on its own; it will not be linked again.
          </p>
          <ul className="space-y-1">
            {autoLinked.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-text">{e.name}</span>
                <span className="font-mono text-xs tabular-nums text-text-muted">{e.startDate}</span>
                <button onClick={() => void unlink(e.id)} disabled={busy !== null} className={chip}>
                  {busy === `unlink:${e.id}` ? 'Unlinking…' : 'Unlink'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {isOwner && <SeriesHealth />}

      <div className="space-y-2">
        <h3 className={sectionTitle}>Venues whose events disagree on the city</h3>
        {!venues ? (
          <span role="status" aria-label="Loading venues" className="inline-flex items-center text-text-muted">
            <Equalizer />
          </span>
        ) : !disagree.length ? (
          <p className="text-sm text-text-muted">None. Every venue with a city on its events is in one place.</p>
        ) : (
          <Ledger>
            {disagree.map((v) => {
              const venue = byId.get(v.venueId)!;
              return (
                <Ledger.Row key={v.venueId} edge="needs" className="flex-col items-stretch gap-2 p-3">
                  <p className="text-sm text-text">
                    <button onClick={() => onOpen(venue.id)} className="font-semibold hover:text-accent">
                      {venue.name}
                    </button>{' '}
                    <span className="text-text-muted">is in which city? Its events will all take the one you pick.</span>
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
                          {busy === `venue:${v.venueId}` ? <Equalizer size="sm" /> : <MapPin className="h-3 w-3" />}
                          {entityLabel(place)}
                          <span className="font-mono tabular-nums text-text-muted">
                            {p.events} event{p.events === 1 ? '' : 's'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </Ledger.Row>
              );
            })}
          </Ledger>
        )}
        <button
          onClick={() =>
            void run('venues', () => entitiesApi.linkVenuePlaces(), (entry) => {
              if (!entry) setError('No venue to put in a city: every venue whose events share one city already has it.');
            })
          }
          disabled={Boolean(busy)}
          className="min-h-11 rounded-control text-xs text-text-muted hover:text-accent disabled:opacity-40 sm:min-h-9"
        >
          {busy === 'venues' ? 'Working…' : 'Put venues whose events all share a city in it'}
        </button>
      </div>

      <div className="space-y-2">
        <h3 className={sectionTitle}>Look-alikes</h3>
        {!groups.length ? (
          <p className="text-sm text-text-muted">None. No two records differ only by spacing, a leading “the”, or “and”.</p>
        ) : (
          <Ledger>
            {groups.map((g) => {
              const kind = KINDS.find((k) => k.kind === g[0].kind)!;
              return (
                <Ledger.Row key={g.map((e) => e.id).join()} edge="needs" className="flex-col items-stretch gap-2 p-3">
                  <p className="text-[11px] uppercase tracking-wide text-text-muted">{kind.one}</p>
                  <ul className="space-y-1">
                    {g.map((e) => (
                      <li key={e.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <button onClick={() => onOpen(e.id)} className="text-text hover:text-accent">
                          {entityLabel(e)}
                        </button>
                        <span className="font-mono text-xs tabular-nums text-text-muted">
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
                    <div className="space-y-2 rounded-card border border-accent-tint-line bg-accent-tint p-2.5 text-sm text-text">
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
                          className="inline-flex min-h-11 items-center gap-1.5 rounded-control bg-accent-fill px-3 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-fill disabled:opacity-40 sm:min-h-9"
                        >
                          {busy === 'merge' ? <Equalizer size="sm" /> : <GitMerge className="h-3.5 w-3.5" />} Merge
                        </button>
                        <button onClick={() => setMerging(null)} className="min-h-11 rounded-control border border-line-strong px-3 py-1.5 text-sm text-text-muted hover:text-text sm:min-h-9">
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </Ledger.Row>
              );
            })}
          </Ledger>
        )}
      </div>

      {gaps.length > 0 && (
        <div className="space-y-2">
          <h3 className={sectionTitle}>Labels some records lack</h3>
          {gaps.map((g) => (
            <div key={`${g.kind}:${g.group}`} className="space-y-1.5 rounded-card border border-line bg-surface-1 p-3">
              <p className="text-sm text-text">
                {label(g.kind, g.missing.length)} with no {g.group.toLowerCase()}
              </p>
              <ul className="space-y-1">
                {g.missing.slice(0, 12).map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-1.5 text-sm">
                    <button onClick={() => onOpen(r.id)} className="mr-1 text-text hover:text-accent">
                      {r.name}
                    </button>
                    {g.labels.map((l) => (
                      <button key={l.id} onClick={() => addLabel(r.id, l.id)} disabled={Boolean(busy)} className={chip}>
                        <Tag className="h-3 w-3" /> {l.name}
                      </button>
                    ))}
                  </li>
                ))}
              </ul>
              {g.missing.length > 12 && <p className="font-mono text-xs tabular-nums text-text-muted">and {g.missing.length - 12} more</p>}
            </div>
          ))}
        </div>
      )}

      {offers.length > 0 && (
        <div className="space-y-2">
          <h3 className={sectionTitle}>Offered from linked records</h3>
          <ul className="space-y-1.5">
            {offers.map((o) => {
              const r = byId.get(o.recordId);
              const l = byId.get(o.labelId);
              const because = byId.get(o.becauseId);
              if (!r || !l || !because) return null;
              return (
                <li key={`${o.recordId}:${o.labelId}`} className="flex flex-wrap items-center gap-2 text-sm text-text">
                  <Sparkles className="h-3.5 w-3.5 text-accent" />
                  <button onClick={() => onOpen(r.id)} className="text-text hover:text-accent">
                    {r.name}
                  </button>
                  <span className="text-text-muted">
                    has no {String(l.attrs.group ?? 'such label').toLowerCase()}; {because.name} is {l.name}.
                  </span>
                  <button onClick={() => addLabel(r.id, l.id)} disabled={Boolean(busy)} className={chip}>
                    Add {l.name}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {rare.length > 0 && (
        <div className="space-y-2">
          <h3 className={sectionTitle}>Labels used once or not at all</h3>
          <p className="text-xs text-text-muted">Often a typo of another label: open one to merge or rename it.</p>
          <ul className="flex flex-wrap gap-1.5">
            {rare.map(({ label: l, uses }) => (
              <li key={l.id}>
                <button onClick={() => onOpen(l.id)} className={chip}>
                  {l.name} <span className="text-text-muted">{uses ? 'once' : 'unused'}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {offered.length > 0 && (
        <div className="space-y-2">
          <h3 className={sectionTitle}>Other cities a save brought</h3>
          <p className="text-xs text-text-muted">
            These events took their venue's city in place of the one shown. If the venue's city is the wrong one, open the venue and move it.
          </p>
          <ul className="space-y-1.5">
            {offered.map(({ venue, offers: cities }) => (
              <li key={venue.id} className="text-sm text-text-muted">
                <button onClick={() => onOpen(venue.id)} className="font-semibold text-text hover:text-accent">
                  {venue.name}
                </button>{' '}
                <span>
                  {cities.map((c) => `${[c.city, c.region, c.country].filter(Boolean).join(', ')} (from ${c.from === 'user' ? 'you' : c.from})`).join('; ')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2">
        <h3 className={sectionTitle}>Venues with no place</h3>
        {unplaced.filter((v) => !disagree.some((d) => d.venueId === v.id)).length ? (
          <ul className="flex flex-wrap gap-1.5">
            {unplaced.filter((v) => !disagree.some((d) => d.venueId === v.id)).map((v) => (
              <li key={v.id}>
                <button onClick={() => onOpen(v.id)} className={chip}>
                  <MapPin className="h-3 w-3" /> {v.name}
                  <span className="font-mono tabular-nums text-text-muted">{n(v.id)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-muted">None. Every venue on your events is in a place.</p>
        )}
      </div>
    </section>
  );
};
