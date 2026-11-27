import React, { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { genresApi, type GenresList } from '../services/lineupApi';
import { genresByArtist } from '../services/genres';
import { genreKey, genreResolver, NOT_GROUPED } from '../server/events/genreVocabulary';
import { canonicalArtistUrl, isModifiedClick, rememberManageSearch } from '../services/manageNav';
import type { GenreRelation, GenreRelationOrigin, GenreRelationType, GenreVocabChange } from '../server/events/genreTypes';
import type { GenreMergePlan } from '../server/events/genreVocabularyManage';
import type { FamilyChoice, GenreListRow } from './GenresPanel';
import { Button } from './ui/Button';
import { Equalizer } from './ui/Equalizer';
import { IconButton } from './ui/IconButton';
import { Ledger } from './ui/Ledger';
import { Notice } from './ui/Notice';
import { Pill } from './ui/Pill';

// A row's record in Manage > Global archive > Genres (docs/specs/genre-vocabulary.md
// section 6, docs/specs/genre-taxonomy-phase-a.md section 6). A genre has its name,
// spellings, family, links, umbrellas, merge and history. A family or macro has its
// name, the genres under it and the artists behind them. Every write goes to the
// server, which refuses with the spec's lines; those are shown as they come.

const field =
  'min-h-11 sm:min-h-9 rounded-control border border-line-strong bg-surface-1 px-2.5 py-1.5 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none';
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
// The server's "Merge instead" refusal names the genre that already holds the spelling.
const MERGE_INSTEAD = /That is already a genre: (.+)\. Merge instead\./;
const ARTISTS_PREVIEW_LIMIT = 30;
const WEIGHT_MIN = 0.05;
const WEIGHT_STEP = 0.05;
// Where each kind of row's key starts (a genre's key is its plain letters).
const KEY_PREFIX = { genre: '', family: 'family:', macro: 'macro:' } as const;
// Plain words for where a link came from.
const ORIGIN_LABEL: Record<GenreRelationOrigin, string> = {
  curated: 'yours',
  artist_cooccur: 'from shared artist data',
  lineup_cooccur: 'from shared lineups',
};
const LINK_TYPE_LABEL: Record<GenreRelationType, string> = {
  secondary_parent: 'Secondary families',
  adjacent: 'Adjacent',
  derived_from: 'Derived from',
};

const Heading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h4 className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{children}</h4>
);

// One link: its target, strength, where it came from, and the controls to change or remove it.
const LinkRow: React.FC<{
  name: string;
  relation: GenreRelation;
  busy: boolean;
  onSave: (weight: number) => void;
  onRemove: () => void;
}> = ({ name, relation, busy, onSave, onRemove }) => {
  const [value, setValue] = useState(String(relation.weight));
  useEffect(() => {
    setValue(String(relation.weight));
  }, [relation.weight]);
  const unchanged = Number(value) === relation.weight && relation.origin === 'curated';
  return (
    <li className="flex flex-wrap items-center gap-2 text-sm text-text">
      <span className="font-medium">{name}</span>
      <span className="font-mono text-xs tabular-nums text-text-muted">{relation.weight.toFixed(2)}</span>
      <span className="text-xs text-text-faint">{ORIGIN_LABEL[relation.origin]}</span>
      <input
        aria-label={`Strength of the link to ${name}`}
        type="number"
        min={WEIGHT_MIN}
        max={1}
        step={WEIGHT_STEP}
        className={`${field} w-24`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button disabled={busy || unchanged} onClick={() => onSave(Number(value))}>
        Save strength
      </Button>
      <Button variant="ghost" disabled={busy} onClick={onRemove}>
        Remove
      </Button>
    </li>
  );
};

export const GenreRecord: React.FC<{
  row: GenreListRow;
  rows: GenreListRow[];
  // Every family, with its macro: the family menu and the macro lists.
  families: FamilyChoice[];
  // The genre keys this family or macro holds (none for a genre).
  members: string[];
  data: GenresList;
  // A change was saved: the panel shows its notice with Undo, reloads, and opens `selectKey` when given.
  onChanged: (change: GenreVocabChange, selectKey?: string) => Promise<void>;
  onSelect: (key: string) => void;
  onClose: () => void;
}> = ({ row, rows, families, members, data, onChanged, onSelect, onClose }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The genre a "Merge instead" refusal named, offered as a merge target.
  const [mergeOffer, setMergeOffer] = useState<string | null>(null);
  const [name, setName] = useState(row.name);
  const [alias, setAlias] = useState('');
  const [umbrellaQuery, setUmbrellaQuery] = useState('');
  const [merging, setMerging] = useState(false);
  const [target, setTarget] = useState('');
  const [plan, setPlan] = useState<GenreMergePlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [showAllArtists, setShowAllArtists] = useState(false);
  const [linkType, setLinkType] = useState<GenreRelationType>('adjacent');
  const [linkTarget, setLinkTarget] = useState('');
  const [linkWeight, setLinkWeight] = useState('1');

  // A different row opened: start its record afresh.
  useEffect(() => {
    setName(row.name);
    setAlias('');
    setUmbrellaQuery('');
    setMerging(false);
    setTarget('');
    setPlan(null);
    setError(null);
    setMergeOffer(null);
    setShowAllArtists(false);
    setLinkTarget('');
  }, [row.key, row.name]);

  const isGenre = row.level === 'genre';
  const vocab = useMemo(() => data.vocabulary.genres.find((g) => g.key === row.key), [data, row.key]);
  const vocabByKey = useMemo(() => new Map(data.vocabulary.genres.map((g) => [g.key, g])), [data]);
  const nameOf = (key: string) => rows.find((r) => r.key === key)?.name ?? key;
  const umbrellaKeys = vocab?.umbrellas ?? [];
  const under = useMemo(
    () => data.vocabulary.genres.filter((g) => g.umbrellas.includes(row.key)).map((g) => ({ key: g.key, name: nameOf(g.key) })),
    [data, row.key, rows],
  );
  const recordKeys = useMemo(() => new Set(isGenre ? [row.key] : members), [isGenre, row.key, members]);
  const connectedArtists = useMemo(() => {
    const shared = data.genres.filter((r) => r.source !== 'added');
    const resolver = genreResolver(data.vocabulary, data.map, shared);
    const byArtist = genresByArtist(shared, data.vocabulary, data.map);
    const out: Array<{ key: string; name: string }> = [];
    for (const [key, artist] of byArtist) {
      if (artist.genres.some((g) => recordKeys.has(resolver.resolve(g.style).key))) {
        out.push({ key, name: artist.name });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [data, recordKeys]);
  // Spellings joined by the key alone (same letters), not by an alias the owner added.
  const folded = row.spellings.filter((s) => s !== row.name && !row.aliases.includes(s) && genreKey(s) === row.key);

  const umbrellaMatches = useMemo(() => {
    const q = umbrellaQuery.trim().toLowerCase();
    if (!q) return [];
    return rows
      .filter((r) => r.key !== row.key && r.level === 'genre' && !umbrellaKeys.includes(r.key))
      .filter((r) => [r.name, ...r.aliases].some((n) => n.toLowerCase().includes(q)))
      .slice(0, 8);
  }, [rows, row.key, umbrellaKeys, umbrellaQuery]);

  // The vocabulary changes that touch this row (by its key or one of its alias keys), newest first.
  const history = useMemo(() => {
    const keys = new Set([row.key, ...(vocab?.aliases.map((a) => a.key) ?? [])]);
    return (data.vocabularyChanges ?? [])
      .filter((c) => [...c.before, ...c.after].some((g) => keys.has(g.key)))
      .sort((a, b) => b.at.localeCompare(a.at));
  }, [data, row.key, vocab]);
  const newestOpen = history.find((c) => !c.undoneAt)?.id;

  // Families grouped by macro, for the family menus.
  const macroGroups = useMemo(() => {
    const byMacro = new Map<string, FamilyChoice[]>();
    for (const f of families) byMacro.set(f.macro, [...(byMacro.get(f.macro) ?? []), f]);
    return [...byMacro];
  }, [families]);
  // Genres a new link can point at.
  const genreChoices = useMemo(() => rows.filter((r) => r.level === 'genre' && r.key !== row.key), [rows, row.key]);

  // A family or macro: the families it holds, each with its genres.
  const familiesInRecord = useMemo(() => {
    if (isGenre) return [];
    const list =
      row.level === 'family' ? [{ key: row.key, name: row.name }] : families.filter((f) => f.macroKey === row.key).map((f) => ({ key: f.key, name: f.name }));
    return list.map((f) => ({
      ...f,
      genres: members
        .filter((gk) => vocabByKey.get(gk)?.primaryParent === f.key)
        .map((gk) => ({ key: gk, name: nameOf(gk) })),
    }));
  }, [isGenre, row.level, row.key, row.name, families, members, vocabByKey, rows]);

  const links = vocab?.relations ?? [];
  const familyOfGenre = families.find((f) => f.key === vocab?.primaryParent);

  const act = async (action: () => Promise<GenreVocabChange>, selectKey?: () => string | undefined): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setMergeOffer(null);
    try {
      const change = await action();
      await onChanged(change, selectKey?.());
      return true;
    } catch (err) {
      const msg = messageOf(err);
      setError(msg);
      setMergeOffer(MERGE_INSTEAD.exec(msg)?.[1] ?? null);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const preview = async (keep: string) => {
    setTarget(keep);
    setPlan(null);
    setError(null);
    if (!keep) return;
    setPlanLoading(true);
    try {
      setPlan(await genresApi.previewGenreMerge(row.name, keep));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setPlanLoading(false);
    }
  };

  const startMerge = (keepName: string) => {
    setMerging(true);
    const keep = rows.find((r) => r.level === 'genre' && (r.key === genreKey(keepName) || r.aliases.some((a) => genreKey(a) === genreKey(keepName))));
    void preview(keep?.name ?? keepName);
  };

  // The list of one kind of link, with the controls for each.
  const linkList = (type: GenreRelationType) => {
    const list = links.filter((l) => l.type === type);
    return (
      <div className="space-y-1.5">
        <Heading>{LINK_TYPE_LABEL[type]}</Heading>
        {list.length === 0 ? (
          <p className="text-sm text-text-muted">None.</p>
        ) : (
          <ul className="space-y-1.5">
            {list.map((l) => (
              <LinkRow
                key={`${l.type}:${l.target}`}
                name={nameOf(l.target)}
                relation={l}
                busy={busy}
                onSave={(weight) => void act(() => genresApi.setGenreRelationWeight(row.name, l.target, l.type, weight))}
                onRemove={() => void act(() => genresApi.removeGenreRelation(row.name, l.target, l.type))}
              />
            ))}
          </ul>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4 rounded-card border border-line bg-surface-1 p-3" data-genre-record-slot={row.key}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-display text-xl font-normal text-text">{row.name}</h3>
          {isGenre ? (
            <Pill tone={row.group === NOT_GROUPED ? 'neutral' : 'accent'}>{row.group}</Pill>
          ) : (
            <Pill tone="info">{row.level === 'family' ? `Family in ${row.group}` : 'Macro'}</Pill>
          )}
          <span className="font-mono text-xs tabular-nums text-text-muted">
            {row.artists} {row.artists === 1 ? 'artist' : 'artists'}
          </span>
        </div>
        <IconButton icon={X} label="Close" onClick={onClose} />
      </div>

      {error && (
        <div className="flex flex-wrap items-center gap-2">
          <Notice tone="warning">{error}</Notice>
          {mergeOffer && (
            <Button onClick={() => startMerge(mergeOffer)} disabled={busy}>
              Merge into {mergeOffer}
            </Button>
          )}
        </div>
      )}

      <form
        className="space-y-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const next = name.trim();
          // A family or macro is named by its key; a genre by its name.
          void act(
            () => genresApi.renameGenre(isGenre ? row.name : row.key, next),
            () => KEY_PREFIX[row.level] + genreKey(next),
          );
        }}
      >
        <Heading>Name</Heading>
        <div className="flex flex-wrap items-center gap-2">
          <input aria-label="Name" className={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          <Button type="submit" disabled={busy || !name.trim() || name.trim() === row.name}>
            Rename
          </Button>
        </div>
      </form>

      {isGenre && (
        <div className="space-y-1.5">
          <Heading>Other spellings</Heading>
          {row.aliases.length === 0 && folded.length === 0 && <p className="text-sm text-text-muted">None yet.</p>}
          {row.aliases.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {row.aliases.map((a) => (
                <li key={a} className="flex items-center gap-0.5 rounded-full border border-line pl-2 text-sm text-text">
                  {a}
                  <IconButton
                    icon={X}
                    size="chip"
                    label={`Remove ${a}`}
                    disabled={busy}
                    onClick={() => void act(() => genresApi.removeGenreAlias(row.name, a))}
                  />
                </li>
              ))}
            </ul>
          )}
          {folded.length > 0 && (
            <p className="text-sm text-text-faint">
              {folded.join(', ')} <span className="text-xs">Same letters; joined on its own.</span>
            </p>
          )}
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void act(() => genresApi.addGenreAlias(row.name, alias.trim())).then((ok) => ok && setAlias(''));
            }}
          >
            <input
              aria-label="New spelling"
              className={field}
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="Another spelling"
              maxLength={80}
            />
            <Button type="submit" disabled={busy || !alias.trim()}>
              Add spelling
            </Button>
          </form>
        </div>
      )}

      {isGenre && (
        <div className="space-y-2">
          <div className="space-y-1.5">
            <Heading>Family</Heading>
            <select
              aria-label="Family"
              className={field}
              value={vocab?.primaryParent ?? ''}
              disabled={busy}
              onChange={(e) => {
                const v = e.target.value;
                void act(() => genresApi.setGenreFamily(row.name, v === '' ? null : v));
              }}
            >
              <option value="">Not grouped</option>
              {macroGroups.map(([macro, list]) => (
                <optgroup key={macro} label={macro}>
                  {list.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <p className="text-sm text-text-muted">
            Macro: {familyOfGenre?.macro ?? NOT_GROUPED}
            {vocab?.tier && <> · Kind: {vocab.tier === 'umbrella_fallback' ? 'broad catch-all' : 'specific'}</>}
          </p>
          {linkList('secondary_parent')}
        </div>
      )}

      {isGenre && (
        <>
          {linkList('adjacent')}
          {linkList('derived_from')}
          <div className="space-y-1.5">
            <Heading>Add a link</Heading>
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void act(() => genresApi.addGenreRelation(row.name, linkTarget, linkType, Number(linkWeight))).then((ok) => ok && setLinkTarget(''));
              }}
            >
              <select
                aria-label="Link type"
                className={field}
                value={linkType}
                onChange={(e) => {
                  setLinkType(e.target.value as GenreRelationType);
                  setLinkTarget('');
                }}
              >
                <option value="adjacent">Adjacent</option>
                <option value="derived_from">Derived from</option>
                <option value="secondary_parent">Secondary family</option>
              </select>
              <select aria-label="Link target" className={`${field} min-w-[12rem]`} value={linkTarget} onChange={(e) => setLinkTarget(e.target.value)}>
                <option value="">Choose…</option>
                {linkType === 'secondary_parent'
                  ? macroGroups.map(([macro, list]) => (
                      <optgroup key={macro} label={macro}>
                        {list.map((f) => (
                          <option key={f.key} value={f.key}>
                            {f.name}
                          </option>
                        ))}
                      </optgroup>
                    ))
                  : genreChoices.map((r) => (
                      <option key={r.key} value={r.key}>
                        {r.name}
                      </option>
                    ))}
              </select>
              <input
                aria-label="Link strength, from 0.05 to 1"
                type="number"
                min={WEIGHT_MIN}
                max={1}
                step={WEIGHT_STEP}
                className={`${field} w-24`}
                value={linkWeight}
                onChange={(e) => setLinkWeight(e.target.value)}
              />
              <Button type="submit" disabled={busy || !linkTarget || !linkWeight}>
                Add link
              </Button>
            </form>
          </div>
        </>
      )}

      {isGenre && (
        <div className="space-y-1.5">
          <Heading>Under these umbrellas</Heading>
          {umbrellaKeys.length === 0 ? (
            <p className="text-sm text-text-muted">None.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {umbrellaKeys.map((k) => (
                <li key={k} className="flex items-center gap-0.5 rounded-full border border-line pl-2 text-sm text-text">
                  {nameOf(k)}
                  <IconButton
                    icon={X}
                    size="chip"
                    label={`Remove ${nameOf(k)}`}
                    disabled={busy}
                    onClick={() => void act(() => genresApi.removeGenreUmbrella(row.name, nameOf(k)))}
                  />
                </li>
              ))}
            </ul>
          )}
          <input
            aria-label="Find an umbrella genre"
            className={field}
            value={umbrellaQuery}
            onChange={(e) => setUmbrellaQuery(e.target.value)}
            placeholder="Find a genre to put this under"
            maxLength={80}
          />
          {umbrellaMatches.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {umbrellaMatches.map((m) => (
                <li key={m.key}>
                  <Button
                    onClick={() => void act(() => genresApi.addGenreUmbrella(row.name, m.name)).then((ok) => ok && setUmbrellaQuery(''))}
                    disabled={busy}
                  >
                    Under {m.name}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {isGenre && (
        <div className="space-y-1.5">
          <Heading>Genres under this one</Heading>
          {under.length === 0 ? (
            <p className="text-sm text-text-muted">None.</p>
          ) : (
            <ul className="flex flex-wrap gap-x-3 gap-y-1">
              {under.map((g) => (
                <li key={g.key}>
                  <button type="button" className="text-sm text-accent hover:underline" onClick={() => onSelect(g.key)}>
                    {g.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!isGenre && (
        <div className="space-y-2">
          <Heading>{row.level === 'family' ? 'Genres in this family' : 'Families in this macro'}</Heading>
          {familiesInRecord.length === 0 ? (
            <p className="text-sm text-text-muted">None yet.</p>
          ) : (
            familiesInRecord.map((f) => (
              <div key={f.key} className="space-y-1">
                {row.level === 'macro' && (
                  <button type="button" className="text-sm font-medium text-accent hover:underline" onClick={() => onSelect(f.key)}>
                    {f.name}
                  </button>
                )}
                {f.genres.length === 0 ? (
                  <p className="text-sm text-text-muted">No genres yet.</p>
                ) : (
                  <ul className="flex flex-wrap gap-x-3 gap-y-1">
                    {f.genres.map((g) => (
                      <li key={g.key}>
                        <button type="button" className="text-sm text-accent hover:underline" onClick={() => onSelect(g.key)}>
                          {g.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))
          )}
        </div>
      )}

      <div className="space-y-1.5">
        <Heading>Artists{connectedArtists.length > 0 ? ` (${connectedArtists.length})` : ''}</Heading>
        {connectedArtists.length === 0 ? (
          <p className="text-sm text-text-muted">None yet.</p>
        ) : (
          <>
            <ul className="flex flex-wrap gap-x-3 gap-y-1">
              {(showAllArtists ? connectedArtists : connectedArtists.slice(0, ARTISTS_PREVIEW_LIMIT)).map((a) => {
                const url = canonicalArtistUrl(a.key);
                return (
                  <li key={a.key}>
                    <a
                      href={url}
                      onClick={(e) => {
                        if (isModifiedClick(e)) return;
                        e.preventDefault();
                        window.history.pushState({ fromManageList: true }, '', url);
                        rememberManageSearch(new URL(url, window.location.origin).search);
                        window.dispatchEvent(new PopStateEvent('popstate'));
                      }}
                      className="text-sm text-accent hover:underline"
                    >
                      {a.name}
                    </a>
                  </li>
                );
              })}
            </ul>
            {connectedArtists.length > ARTISTS_PREVIEW_LIMIT && (
              <button
                type="button"
                className="text-xs text-text-muted hover:text-accent"
                onClick={() => setShowAllArtists((v) => !v)}
              >
                {showAllArtists ? 'Show fewer' : `Show all ${connectedArtists.length} artists`}
              </button>
            )}
          </>
        )}
      </div>

      {isGenre && (
        <div className="space-y-1.5">
          <Button onClick={() => (merging ? (setMerging(false), setTarget(''), setPlan(null)) : setMerging(true))} disabled={busy}>
            {merging ? 'Cancel merge' : 'Merge into another genre'}
          </Button>
          {merging && (
            <div className="space-y-2 rounded-card border border-warn/45 bg-warn/10 p-3 text-sm">
              <p className="font-semibold text-text">Merge "{row.name}" into another genre</p>
              <select aria-label="Genre to keep" className={`${field} min-w-[14rem]`} value={target} onChange={(e) => void preview(e.target.value)}>
                <option value="">Choose the genre to keep…</option>
                {genreChoices.map((r) => (
                  <option key={r.key} value={r.name}>
                    {r.name}
                  </option>
                ))}
              </select>
              {planLoading && <Equalizer size="sm" />}
              {plan && (
                <div className="space-y-1 text-text">
                  <p>
                    {plan.artists} {plan.artists === 1 ? 'artist moves' : 'artists move'} to {plan.keep.name}.
                  </p>
                  {plan.aliases.length > 0 && <p>Become spellings of {plan.keep.name}: {plan.aliases.join(', ')}</p>}
                  {plan.umbrellasMoved.length > 0 && (
                    <p>Umbrella links moved: {plan.umbrellasMoved.map((l) => `${l.genre} under ${l.umbrella}`).join(', ')}</p>
                  )}
                  {plan.umbrellasDropped.length > 0 && (
                    <p>Umbrella links dropped: {plan.umbrellasDropped.map((l) => `${l.genre} under ${l.umbrella}`).join(', ')}</p>
                  )}
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () => genresApi.mergeGenres(row.name, plan.keep.name).then((r) => r.change),
                        () => plan.keep.key,
                      )
                    }
                  >
                    {busy && <Equalizer size="sm" />} Merge
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        <Heading>History</Heading>
        {history.length === 0 ? (
          <p className="text-sm text-text-muted">No changes yet.</p>
        ) : (
          <Ledger>
            {history.map((c) => (
              <Ledger.Row key={c.id} className="text-sm">
                <div className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className={c.undoneAt ? 'text-text-faint line-through' : 'text-text'}>{c.summary}</span>
                  <span className="font-mono text-[11px] tabular-nums text-text-muted">{when(c.at)}</span>
                  {c.undoneAt && <span className="font-mono text-[11px] tabular-nums text-text-muted">Undone {when(c.undoneAt)}</span>}
                  {c.id === newestOpen && (
                    <span className="ml-auto">
                      <Button onClick={() => void act(() => genresApi.undoVocabulary(c.id))} disabled={busy}>
                        Undo
                      </Button>
                    </span>
                  )}
                </div>
              </Ledger.Row>
            ))}
          </Ledger>
        )}
      </div>
    </div>
  );
};
