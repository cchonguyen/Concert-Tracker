import type { LoggedEvent } from '../events/types';
import { attendanceOf, lastDay } from '../events/attendance';
import { eventScale, type LineupFacts } from '../events/scale';
import { cityWithRegion } from '../events/regions';
import { eventYear, formatsOf, whenLabel } from '../../services/format';
import { eventTitle } from '../../services/series';
import { seriesStats, top } from '../../services/stats';
import type { ShareEvent, ShareSettings, ShareView } from './types';

// Builds the share page's content from your log. This is the allow-list: the
// page is rendered from the returned ShareView alone, so a field reaches
// visitors only when it is copied here on purpose (and tested in
// tests/share.test.ts).

const fold = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

// Today's date (YYYY-MM-DD) where the owner is. An unknown time zone falls
// back to the last place on Earth to reach a new day (UTC-12), which hides
// more rather than less.
export function todayIn(timeZone: string, now: Date): string {
  const parts = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  try {
    return parts(timeZone);
  } catch {
    return parts('Etc/GMT+12');
  }
}

// An event appears only when you went and every day it could have been on
// is before today: nothing ahead, nothing happening today, no festival still
// underway, and nothing without a date to tell (it could be tonight).
export function isOver(e: LoggedEvent, today: string): boolean {
  const last = lastDay(e);
  return Boolean(last && last < today) && attendanceOf(e, today) === 'went';
}

export function buildShareView(
  all: LoggedEvent[],
  settings: ShareSettings,
  now: Date,
  lineups: Record<string, LineupFacts> = {},
): ShareView {
  const today = todayIn(settings.timeZone, now);
  const events = all.filter((e) => isOver(e, today));
  const kindOf = (e: LoggedEvent) => eventScale(e, e.editionId ? lineups[e.editionId] : undefined).kind;

  const shareEvent = (e: LoggedEvent): ShareEvent => {
    const out: ShareEvent = { title: eventTitle(e), acts: [...new Set(e.seen.map((s) => s.name))] };
    const kind = kindOf(e);
    if (kind) out.kind = kind;
    const city = cityWithRegion(e.city, e.region);
    if (city) out.city = city;
    if (e.country) out.country = e.country;
    if (settings.showDates) {
      const when = whenLabel(e);
      if (when) out.when = when;
    }
    if (settings.showVenues && e.venue) out.venue = e.venue;
    if (settings.showFormat) {
      const formats = formatsOf(e.format);
      if (formats.length) out.formats = formats;
    }
    return out;
  };

  // Newest year first. Within a year, newest first when dates are shown;
  // with dates hidden, A to Z, so the order does not give the dates away.
  const byYear = new Map<number, LoggedEvent[]>();
  for (const e of events) {
    const y = eventYear(e)!; // isOver needs a date, so every event has a year
    byYear.set(y, [...(byYear.get(y) ?? []), e]);
  }
  const years = [...byYear.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, list]) => {
      const rows = list.map((e) => ({ e, row: shareEvent(e) }));
      rows.sort((a, b) =>
        settings.showDates
          ? (b.e.startDate ?? '').localeCompare(a.e.startDate ?? '') || a.row.title.localeCompare(b.row.title)
          : a.row.title.localeCompare(b.row.title),
      );
      return { year, events: rows.map((r) => r.row) };
    });

  const kinds = events.map(kindOf);
  const states = new Set(events.flatMap((e) => (e.city && e.region ? [`${fold(e.country ?? '')}|${fold(e.region)}`] : [])));
  const countries = new Set(events.flatMap((e) => (e.country ? [fold(e.country)] : [])));
  const cities = top(events, 'city', Number.MAX_SAFE_INTEGER).map((r) => ({ name: r.label, count: r.count }));
  const yearList = [...byYear.keys()];

  return {
    displayName: settings.displayName,
    totals: {
      events: events.length,
      festivals: kinds.filter((k) => k === 'festival').length,
      concerts: kinds.filter((k) => k === 'concert').length,
      acts: new Set(events.flatMap((e) => e.seen.map((s) => s.key))).size,
      cities: cities.length,
      states: states.size,
      countries: countries.size,
      ...(yearList.length ? { firstYear: Math.min(...yearList), lastYear: Math.max(...yearList) } : {}),
    },
    mostSeen: top(events, 'artist', 10).map((r) => ({ name: r.label, count: r.count })),
    // Festivals and tours you went back to: series with two or more years.
    series: seriesStats(events)
      .filter((s) => s.years.length > 1)
      .map((s) => ({ name: s.name, years: s.years })),
    years,
    cities,
  };
}
