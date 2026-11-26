import type { LoggedEvent } from '../server/events/types';
import { eventScale } from '../server/events/scale';
import { artistsOf, eventYear } from './format';

// Series: the festival or tour an event is one edition of ("EDC Las Vegas"),
// named by you. An event in a series shows as "<series> <year>", with the
// event's own city added when the series name does not already say it
// ("EDC" in Las Vegas shows as "EDC Las Vegas 2024"), so its editions read
// the same way however each one was typed or imported. The
// name you typed stays on the event and is still what a lineup lookup reads.
// Offers come only from your own event names; nothing is linked without a tap.

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

// The words that change from one edition to the next: a year ("2024", "'24"),
// and a weekend, day or night number. What is left names the series. A year
// right after "the" is part of a name (The 1975), as in parse.ts.
const EDITION_WORDS = /(?<!\bthe\s)\b(?:19|20)\d{2}\b|['\u2019`]\d{2}\b|\b(?:weekend|wknd|day|night)\s*\d{1,2}\b|\bw\d{1,2}\b/gi;

export function seriesBase(name: string): string {
  return name
    .replace(EDITION_WORDS, ' ')
    .replace(/\(\s*\)|\[\s*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:|,·/]+|[\s\-–—:|,·/]+$/g, '')
    .trim();
}

export const seriesKey = (name: string) =>
  fold(name)
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// The town of a stored city: "Las Vegas" from "Las Vegas, NV".
export const townOf = (city?: string) => city?.split(',')[0].trim() || undefined;

// A series name with the town added, unless the name already says it.
export function withPlace(name: string, city?: string): string {
  const town = townOf(city);
  if (!town || ` ${seriesKey(name)} `.includes(` ${seriesKey(town)} `)) return name;
  return `${name} ${town}`;
}

// The shown name of a shared series, built from what each level holds: the
// brand and the words that set this series apart inside it. A festival reads
// "Dreamstate SoCal", a tour "Andrew Bayer: Duality Tour", and a series with no
// qualifier is the brand alone. Without a brand (a tour whose artist is not
// known) the qualifier stands alone, and a series with neither keeps its name.
export function seriesDisplayName(s: { name: string; brand?: string; qualifier?: string; kind?: 'festival' | 'tour' }): string {
  const brand = s.brand?.trim();
  const qualifier = s.qualifier?.trim();
  if (!brand) return qualifier || s.name;
  if (!qualifier) return brand;
  return s.kind === 'tour' ? `${brand}: ${qualifier}` : `${brand} ${qualifier}`;
}

// The shared series name a linked event shows: its edition's series, built
// from brand and qualifier. Undefined when the edition has no series.
export function sharedSeriesName(
  edition: { seriesSlug?: string; seriesName?: string; seriesBrand?: string; seriesQualifier?: string; seriesKind?: 'festival' | 'tour' } | null | undefined,
): string | undefined {
  const name = edition?.seriesSlug ? edition.seriesName?.trim() : undefined;
  if (!edition || !name) return undefined;
  return seriesDisplayName({ name, brand: edition.seriesBrand, qualifier: edition.seriesQualifier, kind: edition.seriesKind }) || undefined;
}

// The shown title of a shared edition: its series' name, the year unless it is
// a tour stop, the night's own subtitle, and the weekend when one is picked
// ("Coachella 2024 · Weekend 1", "A State of Trance Los Angeles 2025 · 1000").
// An edition with no series keeps its captured name, which stays stored either
// way because stage 2 and matching read it.
export function editionTitle(
  e: {
    name: string;
    year: number;
    subtitle?: string;
    seriesSlug?: string;
    seriesName?: string;
    seriesBrand?: string;
    seriesQualifier?: string;
    seriesKind?: 'festival' | 'tour';
  },
  weekend?: number,
): string {
  const series = e.seriesSlug && e.seriesName
    ? seriesDisplayName({ name: e.seriesName, brand: e.seriesBrand, qualifier: e.seriesQualifier, kind: e.seriesKind })
    : undefined;
  const parts = [series ? (e.seriesKind === 'tour' ? series : `${series} ${e.year}`) : e.name];
  if (e.subtitle?.trim()) parts.push(e.subtitle.trim());
  if (weekend) parts.push(`Weekend ${weekend}`);
  return parts.join(' · ');
}

// What the app shows as the event's name: "EDC Las Vegas 2024" in a series
// (the town from the event's city when the series name lacks it), and
// "Coachella 2024 · Weekend 1" when you picked the weekend. Outside a series,
// an event that is not a festival with one or two main acts you saw (not
// billed as support) shows them first: "Gryffin - Alive Tour", "Above &
// Beyond, Seven Lions - Pier Party", or "Sasha b2b John Digweed - Pier Party"
// when the two played B2B, unless the name already says one of them.
// Otherwise the name as you typed it. The name itself never changes and is
// what a lineup lookup reads.
export function eventTitle(e: LoggedEvent): string {
  const { artists, name } = eventTitleParts(e);
  return artists ? `${artists} - ${name}` : name;
}

// The same title in its two parts, so a view can set the acts apart from the
// event's name: { artists: "Gryffin", name: "Alive Tour" }. Without acts in
// front, the whole title is `name`.
export function eventTitleParts(e: LoggedEvent): { artists?: string; name: string } {
  if (e.series) {
    // A shared series name already says its place when it needs one, so only your own wording gets the town.
    const shared = e.seriesKind !== undefined && !('series' in (e.overrides ?? {}));
    const name = shared ? e.series : withPlace(e.series, e.city);
    const year = eventYear(e);
    const title = year ? `${name} ${year}` : name;
    return { name: e.weekend ? `${title} · Weekend ${e.weekend}` : title };
  }
  const main = artistsOf(e.seen);
  if (!main.length || main.length > 2 || eventScale(e).kind === 'festival') return { name: e.name };
  const name = ` ${seriesKey(e.name)} `;
  if (main.some((a) => name.includes(` ${seriesKey(a.name)} `))) return { name: e.name };
  const b2b = main.length === 2 && !!main[0].b2b?.includes(main[1].key);
  return { artists: main.map((a) => a.name).join(b2b ? ' b2b ' : ', '), name: e.name };
}

// The weekend your own name for the event gives ("Weekend 2", "W1", "Wknd 1"),
// offered when you link it; never stored without your tap.
export function weekendFromName(name: string): number | undefined {
  const m = name.match(/\b(?:weekend|wknd)\s*(\d)\b|\bw(\d)\b/i);
  const n = m ? Number(m[1] ?? m[2]) : NaN;
  return n >= 1 && n <= 9 ? n : undefined;
}

export interface SeriesGroup {
  name: string;
  events: LoggedEvent[]; // oldest first
}

const byDate = (a: LoggedEvent, b: LoggedEvent) =>
  (a.startDate ?? String(a.year ?? '9999')).localeCompare(b.startDate ?? String(b.year ?? '9999'));

// Your series, most editions first.
export function seriesList(events: LoggedEvent[]): SeriesGroup[] {
  const groups = new Map<string, LoggedEvent[]>();
  for (const e of events) if (e.series) groups.set(e.series, [...(groups.get(e.series) ?? []), e]);
  return [...groups.entries()]
    .map(([name, list]) => ({ name, events: list.sort(byDate) }))
    .sort((a, b) => b.events.length - a.events.length || a.name.localeCompare(b.name));
}

function mostUsed(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
}

export interface SeriesSuggestion {
  key: string;
  name: string; // a series you already use with this name, else your most used spelling
  events: LoggedEvent[]; // oldest first
  linked: number; // how many are in that series already
}

// Events whose names are the same once the year is taken out, in the same
// city, and that are not all in one series yet. The name offered carries the
// town ("EDC Las Vegas"), so the same festival in two cities is two series.
// An event with no city joins the one city its name is known in, if just one.
export function seriesSuggestions(events: LoggedEvent[]): SeriesSuggestion[] {
  const townsByBase = new Map<string, Set<string>>();
  for (const e of events) {
    const base = seriesKey(seriesBase(e.name));
    const town = townOf(e.city);
    if (base && town) townsByBase.set(base, (townsByBase.get(base) ?? new Set()).add(town));
  }
  // The city an event is grouped by: its own, or the only one its name has.
  const placeOf = (e: LoggedEvent) => {
    if (e.city) return e.city;
    const towns = townsByBase.get(seriesKey(seriesBase(e.name)));
    return towns?.size === 1 ? [...towns][0] : undefined;
  };
  const byKey = new Map<string, LoggedEvent[]>();
  const add = (key: string, e: LoggedEvent) => {
    if (!key) return;
    const list = byKey.get(key) ?? [];
    if (!list.includes(e)) byKey.set(key, [...list, e]);
  };
  const keyOf = (name: string, e: LoggedEvent) => seriesKey(withPlace(name, placeOf(e)));
  for (const e of events) {
    const base = seriesBase(e.name);
    if (base) add(keyOf(base, e), e);
    if (e.series) add(keyOf(e.series, e), e);
  }
  const out: SeriesSuggestion[] = [];
  for (const [key, list] of byKey) {
    const series = list.flatMap((e) => (e.series && keyOf(e.series, e) === key ? [e.series] : []));
    const name = series.length
      ? mostUsed(series)
      : mostUsed(list.flatMap((e) => (seriesBase(e.name) ? [withPlace(seriesBase(e.name), placeOf(e))] : [])));
    const linked = list.filter((e) => e.series === name).length;
    if (list.length < 2 || linked === list.length) continue;
    out.push({ key, name, events: [...list].sort(byDate), linked });
  }
  return out.sort((a, b) => b.events.length - a.events.length || a.name.localeCompare(b.name));
}

// Series names to offer on one event: the shared series of its edition first,
// then yours that its name starts with or contains, then the name with its
// year taken out.
export function seriesOffers(event: LoggedEvent, events: LoggedEvent[], shared?: string): string[] {
  const name = ` ${seriesKey(event.name)} `;
  const yours = seriesList(events)
    .map((g) => g.name)
    .filter((s) => name.includes(` ${seriesKey(s)} `));
  const base = seriesBase(event.name) && withPlace(seriesBase(event.name), event.city);
  return [...new Set([...(shared ? [shared] : []), ...yours, ...(base ? [base] : []), ...seriesList(events).map((g) => g.name)])].filter(
    (s) => s !== event.series,
  );
}
