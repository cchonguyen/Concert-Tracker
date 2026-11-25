import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Search, X } from 'lucide-react';
import {
  canonicalApi,
  type CanonicalEditionSummary,
  type Edition,
} from '../services/lineupApi';
import { weekendLabel } from '../services/format';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { Equalizer } from './ui/Equalizer';
import { Ledger } from './ui/Ledger';
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
      panelClassName="w-full max-w-3xl max-h-[90vh] overflow-y-auto space-y-4 rounded-t-card border border-line-strong bg-surface-1 p-5 shadow-2xl sm:rounded-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-lg font-normal text-text">Merge editions</h3>
          <p className="text-xs text-text-muted">
            Choose which edition record to keep. Performances, external IDs, and attendee links move onto the kept edition.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          aria-label="Close merge dialog"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control text-text-muted hover:text-text disabled:opacity-40"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Add another edition to merge */}
      <div className="space-y-2 rounded-card border border-line bg-surface-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs font-semibold tabular-nums text-text">
            Editions in merge ({editions.length})
          </span>
          <button
            type="button"
            onClick={() => setSearchOpen((v) => !v)}
            className="inline-flex min-h-11 items-center gap-1 rounded-control px-1.5 text-xs text-accent hover:underline sm:min-h-9"
          >
            <Plus className="h-3.5 w-3.5" /> {searchOpen ? 'Hide search' : 'Add another edition'}
          </button>
        </div>
        {searchOpen && (
          <div className="space-y-2">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2.5 top-3 h-4 w-4 text-text-faint sm:top-2.5" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search editions by name, series, or venue…"
                aria-label="Search editions to merge"
                className="min-h-11 w-full rounded-control border border-line-strong bg-surface-1 py-1.5 pl-8 pr-3 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none sm:min-h-9"
              />
            </label>
            {searching ? (
              <p className="flex items-center gap-1.5 text-xs text-text-muted">
                <Equalizer size="sm" /> Searching…
              </p>
            ) : candidateResults.length === 0 ? (
              <p className="text-xs text-text-muted">No matching editions to add.</p>
            ) : (
              <Ledger className="max-h-40 overflow-y-auto">
                {candidateResults.map((r) => (
                  <Ledger.Row key={r.id} edge="none" className="min-h-11 justify-between px-2.5 py-1.5 text-xs sm:min-h-9">
                    <span className="min-w-0 truncate">
                      <span className="font-medium text-text">{r.name}</span>{' '}
                      <span className="font-mono tabular-nums text-text-muted">
                        · {[r.seriesName, r.startDate ?? String(r.year), r.venue, r.city].filter(Boolean).join(' · ')} ({r.performanceCount} acts)
                      </span>
                    </span>
                    <Button onClick={() => void addEditionById(r.id)} disabled={addingId === r.id}>
                      {addingId === r.id ? <Equalizer size="sm" /> : 'Add'}
                    </Button>
                  </Ledger.Row>
                ))}
              </Ledger>
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
              className={`space-y-2 rounded-card border p-3 text-xs ${
                isKeep ? 'border-accent-tint-line bg-accent-tint' : 'border-line bg-surface-2'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <label className="flex cursor-pointer items-center gap-2 font-semibold text-text">
                  <input
                    type="radio"
                    name="merge-keep-edition"
                    checked={isKeep}
                    onChange={() => setKeepId(ed.id)}
                    className="accent-accent-fill"
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
                      className="flex h-7 w-7 items-center justify-center rounded-control text-text-muted hover:text-text"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <p className="text-sm font-semibold text-text">{ed.name}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-text-muted">
                <dt className="text-text-faint">Series</dt>
                <dd className="truncate">
                  {ed.seriesName || ed.seriesSlug || 'None'}
                  {ed.seriesBrand && <span className="ml-1.5 text-text-muted">({ed.seriesBrand})</span>}
                </dd>
                <dt className="text-text-faint">Dates</dt>
                <dd className="font-mono tabular-nums">{editionDateSummary(ed)}</dd>
                <dt className="text-text-faint">Venue</dt>
                <dd className="truncate">{ed.venue ?? 'Not known'}</dd>
                <dt className="text-text-faint">Place</dt>
                <dd className="truncate">{[ed.city, ed.region, ed.country].filter(Boolean).join(', ') || 'Not known'}</dd>
                <dt className="text-text-faint">Acts</dt>
                <dd className="font-mono tabular-nums">{ed.performances.length} billed</dd>
              </dl>
            </div>
          );
        })}
      </div>

      {/* Combine as weekends */}
      {distinctDates && editions.length >= 2 && (
        <label className="block space-y-1 rounded-card border border-accent-tint-line bg-accent-tint p-3 text-xs">
          <span className="flex items-center gap-2 font-semibold text-text">
            <input
              type="checkbox"
              checked={combineAsWeekends}
              onChange={(e) => setCombineAsWeekends(e.target.checked)}
              className="accent-accent-fill"
            />
            Combine dates into Weekend 1 &amp; Weekend 2
          </span>
          <span className="block pl-5 text-text-muted">
            Builds multi-weekend dates on the kept edition. Existing attendees keep their weekend dates (Weekend 1, Weekend 2, etc.) on their personal log entries. Merges cannot be undone via Undo.
          </span>
        </label>
      )}

      {/* Differing fact choices */}
      {diffs.length > 0 && (
        <div className="space-y-2 rounded-card border border-line bg-surface-1 p-3">
          <p className="text-xs font-semibold text-text">Choose differing facts</p>
          <div className="space-y-2">
            {diffs.map((d) => {
              const current = factChoices[d.field] ?? (kept?.[d.field] ? String(kept[d.field]) : d.options[0]?.value);
              return (
                <div key={d.field} className="space-y-1 text-xs">
                  <span className="text-text-muted">{d.label}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {d.options.map((opt) => {
                      const active = current === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setFactChoices((prev) => ({ ...prev, [d.field]: opt.value }))}
                          className={`min-h-11 rounded-full border px-3 py-1 text-xs sm:min-h-9 ${
                            active
                              ? 'border-accent-tint-line bg-accent-tint text-accent'
                              : 'border-line-strong text-text-muted hover:border-accent'
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

      <label className="block space-y-1 text-xs text-text-muted">
        <span>Merge note (optional)</span>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. duplicate entry, or combine Weekend 1 & Weekend 2"
          className="min-h-11 w-full rounded-control border border-line-strong bg-surface-1 px-2.5 py-1.5 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none sm:min-h-9"
        />
      </label>

      {!distinctDates && (
        <p className="text-xs text-warn">
          Merging editions moves performances, external IDs, and attendee links onto the kept edition. Merges cannot be undone via Undo.
        </p>
      )}

      {error && <p role="alert" className="text-sm text-bad">{error}</p>}

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button
          variant="primary"
          onClick={() => void submitMerge()}
          disabled={saving || editions.length < 2 || dropIds.length === 0}
        >
          {saving && <Equalizer size="sm" />}
          Merge {dropIds.length} {dropIds.length === 1 ? 'edition' : 'editions'} into kept
        </Button>
      </div>
    </Dialog>
  );
};
