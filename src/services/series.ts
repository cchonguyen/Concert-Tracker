import type { LoggedEvent } from '../server/events/types';
import { eventYear } from './format';

// Series: the festival or tour an event is one edition of ("EDC Las Vegas"),
// named by you. An event in a series shows as "<series> <year>", so its
// editions read the same way however each one was typed or imported. The
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

// What the app shows as the event's name: "EDC Las Vegas 2024" in a series,
// otherwise the name as you typed it.
export function eventTitle(e: Pick<LoggedEvent, 'name' | 'series' | 'startDate' | 'year'>): string {
  if (!e.series) return e.name;
  const year = eventYear(e as LoggedEvent);
  return year ? `${e.series} ${year}` : e.series;
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

// Events whose names are the same once the year is taken out, and that are not
// all in one series yet. Two or more, or one that matches a series you have.
export function seriesSuggestions(events: LoggedEvent[]): SeriesSuggestion[] {
  const byKey = new Map<string, LoggedEvent[]>();
  const add = (key: string, e: LoggedEvent) => {
    if (!key) return;
    const list = byKey.get(key) ?? [];
    if (!list.includes(e)) byKey.set(key, [...list, e]);
  };
  for (const e of events) {
    add(seriesKey(seriesBase(e.name)), e);
    if (e.series) add(seriesKey(e.series), e);
  }
  const out: SeriesSuggestion[] = [];
  for (const [key, list] of byKey) {
    const series = list.flatMap((e) => (e.series && seriesKey(e.series) === key ? [e.series] : []));
    const name = series.length ? mostUsed(series) : mostUsed(list.map((e) => seriesBase(e.name)));
    const linked = list.filter((e) => e.series === name).length;
    if (list.length < 2 || linked === list.length) continue;
    out.push({ key, name, events: [...list].sort(byDate), linked });
  }
  return out.sort((a, b) => b.events.length - a.events.length || a.name.localeCompare(b.name));
}

// Series names to offer on one event: yours that its name starts with or
// contains, then the name with its year taken out.
export function seriesOffers(event: LoggedEvent, events: LoggedEvent[]): string[] {
  const name = ` ${seriesKey(event.name)} `;
  const yours = seriesList(events)
    .map((g) => g.name)
    .filter((s) => name.includes(` ${seriesKey(s)} `));
  const base = seriesBase(event.name);
  return [...new Set([...yours, ...(base ? [base] : []), ...seriesList(events).map((g) => g.name)])].filter(
    (s) => s !== event.series,
  );
}
