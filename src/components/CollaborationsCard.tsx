import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { ChevronDown, ChevronRight, Edit2, Plus, Trash2, Users, X } from 'lucide-react';
import { Button } from './ui/Button';
import { Equalizer } from './ui/Equalizer';
import { IconButton } from './ui/IconButton';
import { Pill } from './ui/Pill';
import { Confirm } from './ui/Confirm';
import { SuggestInput } from './SuggestInput';
import { collaborationsApi, type CollaborationItem } from '../services/lineupApi';
import type { HistoryEntry } from '../server/entities/types';
import { normalizeName } from '../server/lineup/text';

interface Props {
  allArtists: Array<{ id: string; name: string }>;
  searchQuery?: string;
  onOpenArtist: (id: string) => void;
  onChanged: (entry: HistoryEntry) => Promise<void>;
}

export const CollaborationsCard: React.FC<Props> = ({
  allArtists,
  searchQuery = '',
  onOpenArtist,
  onChanged,
}) => {
  const [items, setItems] = useState<CollaborationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CollaborationItem | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [aliasInput, setAliasInput] = useState('');
  const [partners, setPartners] = useState<string[]>([]);
  const [newPartner, setNewPartner] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<CollaborationItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const artistNames = useMemo(() => allArtists.map((a) => a.name), [allArtists]);
  const artistByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of allArtists) {
      map.set(normalizeName(a.name), a.id);
    }
    return map;
  }, [allArtists]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await collaborationsApi.list();
      setItems(res);
    } catch {
      // Offline or mock mode
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const startNew = () => {
    setIsNew(true);
    setEditing(null);
    setAliasInput('');
    setPartners([]);
    setNewPartner('');
    setError(null);
    setOpen(true);
  };

  const startEdit = (collab: CollaborationItem) => {
    setEditing(collab);
    setIsNew(false);
    setAliasInput(collab.alias);
    setPartners([...collab.partners]);
    setNewPartner('');
    setError(null);
    setOpen(true);
  };

  const cancelForm = () => {
    setEditing(null);
    setIsNew(false);
    setError(null);
  };

  const addPartner = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const norm = normalizeName(trimmed);
    if (partners.some((p) => normalizeName(p) === norm)) return;
    setPartners((ps) => [...ps, trimmed]);
    setNewPartner('');
  };

  const removePartner = (index: number) => {
    setPartners((ps) => ps.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    const trimmedAlias = aliasInput.trim();
    if (!trimmedAlias) {
      setError('Please provide a project moniker name.');
      return;
    }
    if (partners.length < 2) {
      setError('A collaboration requires at least 2 artist partners.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await collaborationsApi.save({
        alias: trimmedAlias,
        partners,
        oldAlias: editing?.alias,
      });
      await load();
      cancelForm();
      await onChanged(res.entry);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (collab: CollaborationItem) => {
    setRemoving(null);
    setBusy(true);
    try {
      const res = await collaborationsApi.remove(collab.alias);
      await load();
      if (editing?.alias === collab.alias) cancelForm();
      await onChanged(res.entry);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const q = normalizeName(searchQuery);
  const filtered = useMemo(() => {
    if (!q) return items;
    return items.filter((item) => {
      if (normalizeName(item.alias).includes(q)) return true;
      return item.partners.some((p) => normalizeName(p).includes(q));
    });
  }, [items, q]);

  // If a search query matches collaborations, auto-expand the section
  useEffect(() => {
    if (q && filtered.length > 0 && !open) {
      setOpen(true);
    }
  }, [q, filtered.length, open]);

  return (
    <div className="space-y-3 rounded-card border border-line bg-surface-1 p-3.5">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-text hover:text-accent sm:min-h-9"
        >
          {open ? <ChevronDown className="h-4 w-4 text-text-muted" /> : <ChevronRight className="h-4 w-4 text-text-muted" />}
          <Users className="h-4 w-4 text-accent" />
          <span>Collaborations and group projects</span>
          <span className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-xs font-normal tabular-nums text-text-muted">
            {items.length}
          </span>
        </button>

        {!isNew && !editing && (
          <Button variant="ghost" className="h-auto px-2.5 py-1 text-xs text-accent" onClick={startNew}>
            <Plus className="mr-1 h-3.5 w-3.5" /> New collaboration
          </Button>
        )}
      </div>

      {open && (
        <div className="space-y-4 pt-2">
          {(isNew || editing) && (
            <div className="space-y-3 rounded-card border border-line bg-accent-tint p-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-text">
                  {isNew ? 'Create Collaboration' : `Edit ${editing?.alias}`}
                </h4>
                <IconButton icon={X} label="Close" size="chip" onClick={cancelForm} />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-text-muted">Name they play under together (AKA)</label>
                <input
                  className="min-h-11 w-full rounded-control border border-line-strong bg-surface-1 px-3 py-1.5 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none sm:min-h-9"
                  placeholder="e.g. Subjohnics, Kx5, ISOKNOCK, Everything Always"
                  value={aliasInput}
                  onChange={(e) => setAliasInput(e.target.value)}
                  autoFocus
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-text-muted">Partner artists (<span className="font-mono tabular-nums">{partners.length}</span>)</label>
                <div className="flex min-h-[36px] flex-wrap items-center gap-1.5 rounded-control border border-line-strong bg-surface-1 p-1.5">
                  {partners.map((partner, idx) => (
                    <span
                      key={partner}
                      className="inline-flex items-center gap-1 rounded-full bg-surface-2 py-0.5 pl-2.5 pr-1 text-xs text-text"
                    >
                      {partner}
                      <button
                        type="button"
                        onClick={() => removePartner(idx)}
                        aria-label={`Remove ${partner}`}
                        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-text-muted hover:text-text"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  <div className="min-w-[140px] flex-1">
                    <SuggestInput
                      value={newPartner}
                      suggestions={artistNames}
                      onPick={addPartner}
                      onChange={(e) => setNewPartner(e.target.value)}
                      placeholder="Add an artist..."
                      className="w-full border-0 bg-transparent px-2 py-0.5 text-xs text-text placeholder:text-text-faint focus:outline-none"
                    />
                  </div>
                </div>
                <p className="text-[11px] text-text-muted">
                  Type or pick 2+ artists. In lineup review, typing "{aliasInput || 'the moniker'}" will auto-expand into these artists.
                </p>
              </div>

              {error && <p className="text-xs text-bad">{error}</p>}

              <div className="flex items-center justify-end gap-2 pt-1">
                <Button variant="ghost" onClick={cancelForm} disabled={busy}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={handleSave} disabled={busy}>
                  {busy ? <Equalizer size="sm" className="mr-1" /> : null}
                  {isNew ? 'Create Project' : 'Save Changes'}
                </Button>
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-4 text-sm text-text-muted">
              <Equalizer /> Loading collaborations...
            </div>
          ) : !filtered.length ? (
            <p className="py-1 text-xs text-text-muted">
              {q ? `No collaborations match "${searchQuery}".` : 'No collaborative projects recorded yet.'}
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {filtered.map((item) => (
                <div
                  key={item.aliasNormalized}
                  className="flex flex-col justify-between rounded-card border border-line bg-surface-2 p-2.5 transition hover:border-line-strong"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <span className="text-sm font-semibold text-text">{item.alias}</span>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        {item.partners.map((partner) => {
                          const artistId = artistByName.get(normalizeName(partner));
                          return (
                            <button
                              key={partner}
                              type="button"
                              onClick={() => artistId && onOpenArtist(artistId)}
                              className="focus:outline-none"
                              title={artistId ? `View ${partner}'s profile in Manage` : partner}
                            >
                              <Pill tone="neutral">
                                <span className={artistId ? 'text-text hover:underline' : 'text-text-muted'}>
                                  {partner}
                                </span>
                              </Pill>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-0.5">
                      <IconButton
                        icon={Edit2}
                        label={`Edit ${item.alias}`}
                        size="chip"
                        onClick={() => startEdit(item)}
                      />
                      <IconButton
                        icon={Trash2}
                        label={`Delete ${item.alias}`}
                        size="chip"
                        onClick={() => setRemoving(item)}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {removing && (
        <Confirm
          title="Remove collaboration"
          message={`Remove the collaboration moniker "${removing.alias}"?`}
          confirmLabel="Remove collaboration"
          onCancel={() => setRemoving(null)}
          onConfirm={() => void handleDelete(removing)}
        />
      )}
    </div>
  );
};
