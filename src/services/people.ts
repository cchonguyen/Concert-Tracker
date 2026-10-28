import { normalizeName } from '../server/lineup/text';

// How the people you went with are named on screen (Manage step 4). A
// person record keeps the name you gave and, once you set them, a first and
// last name in `attrs`. The display takes the longest form that fits the
// space: the full name ("Mike Rivera"), then first name and last initial
// ("Mike R."), then initials ("MR"). A shorter form that would read the same
// as someone else's stays one step longer, for both of them, so two people
// never look alike. The full name is always a hover or long press away.

export interface PersonParts {
  first: string;
  last?: string;
}

export interface PersonNames {
  full: string;
  short: string;
  initials: string;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

// The first and last name you set, or, before you set them, the name read as
// first word and the rest. Only used for display; nothing is stored from it.
export function personParts(name: string, attrs: Record<string, unknown> = {}): PersonParts {
  const first = text(attrs.first);
  if (first) {
    const last = text(attrs.last);
    return last ? { first, last } : { first };
  }
  const words = text(name).split(' ').filter(Boolean);
  if (words.length < 2) return { first: words[0] ?? '' };
  return { first: words[0], last: words.slice(1).join(' ') };
}

// The first letter or digit, upper case ('' when there is none).
const initial = (s: string): string => Array.from(s).find((c) => /[\p{L}\p{N}]/u.test(c))?.toUpperCase() ?? '';

// The three forms for one person, before collisions are looked at.
export function nameForms(name: string, attrs: Record<string, unknown> = {}): PersonNames {
  const full = text(name);
  const { first, last } = personParts(name, attrs);
  const lastInitial = last ? initial(last) : '';
  const short = first && lastInitial ? `${first} ${lastInitial}.` : first || full;
  const initials = initial(first) + lastInitial || short;
  return { full, short, initials };
}

const key = (s: string) => normalizeName(s);

// Display forms for everyone in your list, by ID, with shorter forms kept
// one step longer wherever they would collide. `people` should be the live
// person records (not merged ones).
export function displayNames(people: Array<{ id: string; name: string; attrs?: Record<string, unknown> }>): Map<string, PersonNames> {
  const out = new Map(people.map((p) => [p.id, nameForms(p.name, p.attrs)]));
  const bump = (level: 'short' | 'initials', longer: (n: PersonNames) => string) => {
    const others = (id: string) => [...out.entries()].filter(([other]) => other !== id);
    const clash = new Set<string>();
    for (const [id, n] of out) {
      const mine = key(n[level]);
      if (mine === key(longer(n))) continue; // already as long as the next form
      for (const [other, o] of others(id)) {
        // Same short form as theirs: both go longer. Same as one of their
        // longer forms: only this one does.
        if (key(o[level]) === mine && key(longer(o)) !== mine) {
          clash.add(id);
          clash.add(other);
        } else if (key(o.full) === mine || (level === 'initials' && key(o.short) === mine)) clash.add(id);
      }
    }
    for (const id of clash) {
      const n = out.get(id)!;
      out.set(id, { ...n, [level]: longer(n) });
    }
  };
  bump('short', (n) => n.full);
  bump('initials', (n) => n.short);
  return out;
}
