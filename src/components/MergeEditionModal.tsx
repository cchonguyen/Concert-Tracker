import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, Search, X } from 'lucide-react';
import {
  canonicalApi,
  type CanonicalEditionSummary,
  type Edition,
} from '../services/lineupApi';
import { weekendLabel } from '../services/format';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { Pill } from './ui/Pill';

export type MergeFactField = 'name' | 'seriesSlug' | 'startDate' | 'endDate' | 'venue' | 'city' | 'region' | 'country';

const MERGE_FIELD_LABELS: Record<MergeFactField, string> = {
  name: 'Name',
  seriesSlug: 'Series',
  startDate: 'Start date',
  endDate: 'End date',
  venue: 'Venue',
  city: 'City',
  region: 'Region',
  country: 'Country',
};

const ALL_MERGE_FIELDS: MergeFactField[] = ['name', 'seriesSlug', 'startDate', 'endDate', 'venue', 'city', 'region', 'country'];

// Mirrors mergeCanonicalEditions in src/server/lineup/canonicalIngest.ts: true when at least 2 distinct start dates exist.
export function hasDistinctEditionDates(editions: Array<Pick<Edition, 'startDate' | 'weekends'>>): boolean {
  const starts = new Set<string>();
  for (const ed of editions) {
    if (ed.weekends && ed.weekends.length > 0) {
      for (const w of ed.weekends) {
        if (w.startDate) starts.add(w.startDate);
      }
    } else if (ed.startDate) {
      starts.add(ed.startDate);
    }
  }
  return starts.size >= 2;
}

export function editionDateSummary(e: Pick<Edition, 'startDate' | 'endDate' | 'weekends' | 'year'>): string {
  if (e.weekends && e.weekends.length > 0) {
    return e.weekends.map((w) => weekendLabel(w, 'WK')).join(' · ');
  }
  if (e.startDate) {
    return e.endDate && e.endDate !== e.startDate ? `${e.startDate} to ${e.endDate}` : e.startDate;
  }
  return e.year ? String(e.year) : 'Not known';
}

export function differingMergeFields(
  editions: Edition[],
  combineAsWeekends: boolean,
): Array<{ field: MergeFactField; label: string; options: Array<{ value: string; display: string }> }> {
  if (editions.length < 2) return [];
  const fields = combineAsWeekends
    ? ALL_MERGE_FIELDS.filter((f) => f !== 'startDate' && f !== 'endDate')
    : ALL_MERGE_FIELDS;
  const out: Array<{ field: MergeFactField; label: string; options: Array<{ value: string; display: string }> }> = [];
  for (const field of fields) {
    const byValue = new Map<string, string>();
    for (const ed of editions) {
      const raw = ed[field];
      if (typeof raw === 'string' && raw.trim()) {
        const val = raw.trim();
        if (!byValue.has(val)) {
          const display = field === 'seriesSlug' ? (ed.seriesName ? `${ed.seriesName} (${val})` : val) : val;
          byValue.set(val, display);
        }
      }
    }
    if (byValue.size >= 2) {
      out.push({
        field,
        label: MERGE_FIELD_LABELS[field],
        options: [...byValue.entries()].map(([value, display]) => ({ value, display })),
      });
    }
  }
  return out;
}

interface MergeEditionModalProps {
  initialEditions: Edition[];
  onClose: () => void;
  onMerged: (edition: Edition) => void;
}

export const MergeEditionModal: React.FC<MergeEditionModalProps> = ({ initialEditions, onClose, onMerged }) => {
  const [editions, setEditions] = useState<Edition[]>(initialEditions);
  const [keepId, setKeepId] = useState<string>(initialEditions[0]?.id ?? '');
  const [factChoices, setFactChoices] = useState<Partial<Record<MergeFactField, string>>>({});
  const [combineAsWeekends, setCombineAsWeekends] = useState(false);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Search to add another edition (used when opened from EditionDetail "Merge with…", or to add more).
  const [searchOpen, setSearchOpen] = useState(initialEditions.length < 2);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [results, setResults] = useState<CanonicalEditionSummary[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!searchOpen) return;
    const controller = new AbortController();
    setSearching(true);
    canonicalApi
      .editions(debouncedSearch, 'all', controller.signal)
      .then((res) => {
        setResults(res.editions);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearching(false);
      });
    return () => controller.abort();
  }, [searchOpen, debouncedSearch]);

  const distinctDates = useMemo(() => hasDistinctEditionDates(editions), [editions]);
  useEffect(() => {
    if (!distinctDates && combineAsWeekends) setCombineAsWeekends(false);
  }, [distinctDates, combineAsWeekends]);

  const diffs = useMemo(() => differingMergeFields(editions, combineAsWeekends), [editions, combineAsWeekends]);
  const kept = editions.find((e) => e.id === keepId) ?? editions[0];
  const dropIds = editions.filter((e) => e.id !== keepId).map((e) => e.id);

  const addEditionById = async (id: string) => {
    if (editions.some((e) => e.id === id)) return;
    setAddingId(id);
    setError(null);
    try {
      const { edition } = await canonicalApi.edition(id);
      setEditions((prev) => (prev.some((e) => e.id === edition.id) ? prev : [...prev, edition]));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingId(null);
    }
  };

  const removeEdition = (id: string) => {
    if (editions.length <= 1) return;
    const next = editions.filter((e) => e.id !== id);
    setEditions(next);
    if (keepId === id && next[0]) setKeepId(next[0].id);
  };

  const submitMerge = async () => {
    if (!keepId || dropIds.length === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      const cleanChoices: Record<string, string> = {};
      for (const d of diffs) {
        const chosen = factChoices[d.field] ?? (kept?.[d.field] ? String(kept[d.field]) : d.options[0]?.value);
        if (chosen) cleanChoices[d.field] = chosen;
      }
      const res = await canonicalApi.mergeEditions(keepId, {
        dropIds,
        ...(Object.keys(cleanChoices).length ? { factChoices: cleanChoices } : {}),
        ...(distinctDates && combineAsWeekends ? { combineAsWeekends: true } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      onMerged(res.edition);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const selectedIds = new Set(editions.map((e) => e.id));
  const candidateResults = (results ?? []).filter((r) => !selectedIds.has(r.id)).slice(0, 12);

  return (
    <Dialog
      title="Merge editions"
      placement="center"
      onClose={saving ? undefined : onClose}
      panelClassName="w-full max-w-3xl max-h-[90vh] overflow-y-auto space-y-4 rounded-t-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl sm:rounded-2xl"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-zinc-50">Merge editions</h3>
          <p className="text-xs text-zinc-400">
            Choose which edition record to keep. Performances, external IDs, and attendee links move onto the kept edition.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          aria-label="Close merge dialog"
          className="rounded-md p-1 text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Add another edition to merge */}
      <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-zinc-300">
            Editions in merge ({editions.length})
          </span>
          <button
            type="button"
            onClick={() => setSearchOpen((v) => !v)}
            className="inline-flex items-center gap-1 text-xs text-violet-300 hover:text-violet-200"
          >
            <Plus className="h-3.5 w-3.5" /> {searchOpen ? 'Hide search' : 'Add another edition'}
          </button>
        </div>
        {searchOpen && (
          <div className="space-y-2">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-zinc-500" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search editions by name, series, or venue…"
                aria-label="Search editions to merge"
                className="w-full rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 pl-8 pr-3 text-sm text-zinc-100 placeholder-zinc-500 focus:border-violet-500 focus:outline-none"
              />
            </label>
            {searching ? (
              <p className="flex items-center gap-1.5 text-xs text-zinc-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…
              </p>
            ) : candidateResults.length === 0 ? (
              <p className="text-xs text-zinc-500">No matching editions to add.</p>
            ) : (
              <ul className="max-h-40 divide-y divide-zinc-800 overflow-y-auto rounded-lg border border-zinc-800">
                {candidateResults.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs">
                    <span className="min-w-0 truncate">
                      <span className="font-medium text-zinc-100">{r.name}</span>{' '}
                      <span className="text-zinc-400">
                        · {[r.seriesName, r.startDate ?? String(r.year), r.venue, r.city].filter(Boolean).join(' · ')} ({r.performanceCount} acts)
                      </span>
                    </span>
                    <Button onClick={() => void addEditionById(r.id)} disabled={addingId === r.id}>
                      {addingId === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Add'}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Side-by-side preview */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {editions.map((ed) => {
          const isKeep = ed.id === keepId;
          return (
            <div
              key={ed.id}
              className={`space-y-2 rounded-xl border p-3 text-xs ${
                isKeep ? 'border-violet-500 bg-violet-950/20' : 'border-zinc-800 bg-zinc-950/60'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <label className="flex cursor-pointer items-center gap-2 font-semibold text-zinc-100">
                  <input
                    type="radio"
                    name="merge-keep-edition"
                    checked={isKeep}
                    onChange={() => setKeepId(ed.id)}
                    className="accent-violet-500"
                  />
                  <span>{isKeep ? 'Keep this edition' : 'Merge into kept'}</span>
                </label>
                <div className="flex items-center gap-1.5">
                  <Pill tone={ed.status === 'verified' || ed.status === 'confirmed' ? 'good' : 'neutral'}>
                    {ed.status === 'confirmed' ? 'verified' : ed.status}
                  </Pill>
                  {editions.length > 2 && (
                    <button
                      type="button"
                      onClick={() => removeEdition(ed.id)}
                      aria-label={`Remove ${ed.name} from merge`}
                      className="text-zinc-500 hover:text-zinc-300"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <p className="text-sm font-semibold text-zinc-50">{ed.name}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-zinc-300">
                <dt className="text-zinc-500">Series</dt>
                <dd className="truncate">
                  {ed.seriesName || ed.seriesSlug || 'None'}
                  {ed.seriesBrand && <span className="ml-1.5 text-zinc-400">({ed.seriesBrand})</span>}
                </dd>
                <dt className="text-zinc-500">Dates</dt>
                <dd>{editionDateSummary(ed)}</dd>
                <dt className="text-zinc-500">Venue</dt>
                <dd className="truncate">{ed.venue ?? 'Not known'}</dd>
                <dt className="text-zinc-500">Place</dt>
                <dd className="truncate">{[ed.city, ed.region, ed.country].filter(Boolean).join(', ') || 'Not known'}</dd>
                <dt className="text-zinc-500">Acts</dt>
                <dd>{ed.performances.length} billed</dd>
              </dl>
            </div>
          );
        })}
      </div>

      {/* Combine as weekends */}
      {distinctDates && editions.length >= 2 && (
        <label className="block space-y-1 rounded-lg border border-violet-500/30 bg-violet-950/15 p-3 text-xs">
          <span className="flex items-center gap-2 font-semibold text-zinc-100">
            <input
              type="checkbox"
              checked={combineAsWeekends}
              onChange={(e) => setCombineAsWeekends(e.target.checked)}
              className="accent-violet-500"
            />
            Combine dates into Weekend 1 &amp; Weekend 2
          </span>
          <span className="block pl-5 text-zinc-400">
            Builds multi-weekend dates on the kept edition. Existing attendees keep their weekend dates (Weekend 1, Weekend 2, etc.) on their personal log entries. Merges cannot be undone via Undo.
          </span>
        </label>
      )}

      {/* Differing fact choices */}
      {diffs.length > 0 && (
        <div className="space-y-2 rounded-lg border border-zinc-800 p-3">
          <p className="text-xs font-semibold text-zinc-200">Choose differing facts</p>
          <div className="space-y-2">
            {diffs.map((d) => {
              const current = factChoices[d.field] ?? (kept?.[d.field] ? String(kept[d.field]) : d.options[0]?.value);
              return (
                <div key={d.field} className="space-y-1 text-xs">
                  <span className="text-zinc-400">{d.label}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {d.options.map((opt) => {
                      const active = current === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setFactChoices((prev) => ({ ...prev, [d.field]: opt.value }))}
                          className={`rounded-full border px-2.5 py-1 text-xs ${
                            active
                              ? 'border-violet-400 bg-violet-500/20 text-violet-100'
                              : 'border-zinc-700 text-zinc-300 hover:border-violet-500'
                          }`}
                        >
                          {opt.display}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <label className="block space-y-1 text-xs text-zinc-400">
        <span>Merge note (optional)</span>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. duplicate entry, or combine Weekend 1 & Weekend 2"
          className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-violet-500 focus:outline-none"
        />
      </label>

      {!distinctDates && (
        <p className="text-xs text-amber-300/90">
          Merging editions moves performances, external IDs, and attendee links onto the kept edition. Merges cannot be undone via Undo.
        </p>
      )}

      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button
          variant="primary"
          onClick={() => void submitMerge()}
          disabled={saving || editions.length < 2 || dropIds.length === 0}
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Merge {dropIds.length} {dropIds.length === 1 ? 'edition' : 'editions'} into kept
        </Button>
      </div>
    </Dialog>
  );
};
