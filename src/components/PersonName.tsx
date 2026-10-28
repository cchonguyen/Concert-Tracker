import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { entitiesApi, LoggedEvent } from '../services/lineupApi';
import type { Entity } from '../server/entities/types';
import { norm as normalizeName } from '../services/listImport';
import { displayNames, nameForms, PersonNames } from '../services/people';

// How the people you went with are shown (Manage step 4): the longest of
// full name, "First L." and initials that fits the space the name is given,
// worked out from the element's real width, so it adapts in table cells,
// chips and on a phone. Forms come from `displayNames` over everyone you
// went with, so two people never look alike. The full name is the tooltip
// (hover, or long press on touch).

type Forms = Map<string, PersonNames>; // by normalized name or AKA

const PeopleContext = createContext<Forms>(new Map());

// Everyone named on your events, with the first and last names you set on
// their records (records load once 0014 is applied; before that, names are
// read as they are). Records are fetched again when `version` changes.
export const PeopleProvider: React.FC<{ events: LoggedEvent[]; version?: unknown; children: React.ReactNode }> = ({
  events,
  version,
  children,
}) => {
  const [records, setRecords] = useState<{ people: Entity[]; aliases: Map<string, string> } | null>(null);
  useEffect(() => {
    let live = true;
    entitiesApi
      .list()
      .then((d) => {
        if (!live) return;
        const people = d.entities.filter((e) => e.kind === 'person' && !e.mergedIntoId);
        setRecords({ people, aliases: new Map(d.aliases.filter((a) => a.kind === 'person').map((a) => [a.aliasNormalized, a.entityId])) });
      })
      .catch(() => undefined); // without records, names are shown as typed
    return () => {
      live = false;
    };
  }, [version]);

  const forms = useMemo(() => {
    const byKey = new Map<string, { id: string; name: string; attrs?: Record<string, unknown> }>();
    const byId = new Map((records?.people ?? []).map((p) => [p.id, p]));
    for (const p of records?.people ?? []) byKey.set(p.nameNormalized, { id: p.id, name: p.name, attrs: p.attrs });
    for (const e of events) {
      for (const name of e.companions) {
        const k = normalizeName(name);
        if (!k || byKey.has(k)) continue;
        const aliased = records?.aliases.get(k);
        const p = aliased ? byId.get(aliased) : undefined;
        byKey.set(k, p ? { id: p.id, name: p.name, attrs: p.attrs } : { id: `name:${k}`, name });
      }
    }
    const unique = [...new Map([...byKey.values()].map((p) => [p.id, p])).values()];
    const names = displayNames(unique);
    return new Map([...byKey.entries()].map(([k, p]) => [k, names.get(p.id)!]));
  }, [events, records]);

  return <PeopleContext.Provider value={forms}>{children}</PeopleContext.Provider>;
};

export function usePersonNames(name: string): PersonNames {
  const forms = useContext(PeopleContext);
  return forms.get(normalizeName(name)) ?? nameForms(name);
}

const LEVELS = ['full', 'short', 'initials'] as const;

// One person's name in the space it is given. `form` fixes one form (for
// example initials in an avatar); otherwise the longest that fits is shown.
export const PersonName: React.FC<{ name: string; form?: keyof PersonNames; className?: string }> = ({ name, form, className = '' }) => {
  const names = usePersonNames(name);
  const box = useRef<HTMLSpanElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const [level, setLevel] = useState<keyof PersonNames>('full');
  const [peek, setPeek] = useState(false); // long press: the full name
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useLayoutEffect(() => {
    if (form) return;
    const el = box.current;
    const ruler = measure.current;
    if (!el || !ruler || typeof ResizeObserver === 'undefined') return;
    const fit = () => {
      const room = el.clientWidth;
      const widths = [...ruler.children].map((c) => (c as HTMLElement).offsetWidth);
      const i = widths.findIndex((w) => w <= room + 0.5);
      setLevel(LEVELS[i < 0 ? LEVELS.length - 1 : i]);
    };
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, [form, names]);

  const shown = peek ? names.full : names[form ?? level];
  const release = () => {
    clearTimeout(hold.current);
    setPeek(false);
  };
  return (
    <span
      ref={box}
      className={`person-name ${peek ? 'person-name-peek' : ''} ${className}`}
      title={names.full}
      aria-label={names.full}
      onPointerDown={(e) => {
        if (e.pointerType !== 'mouse' && shown !== names.full) hold.current = setTimeout(() => setPeek(true), 450);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={release}
    >
      <span aria-hidden="true">{shown}</span>
      {!form && (
        <span ref={measure} className="person-name-ruler" aria-hidden="true">
          {LEVELS.map((l) => (
            <span key={l}>{names[l]}</span>
          ))}
        </span>
      )}
    </span>
  );
};
