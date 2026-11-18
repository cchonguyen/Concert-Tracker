import type { Edition, Fetcher } from '../lineup/types';
import type { LineupStore } from '../lineup/store/types';
import { normalizeName } from '../lineup/text';
import { writeEdition } from '../canon/editions';
import { cityWithRegion } from './regions';
import { resolveEvent } from './inherit';
import { lookupWeather } from './weather';
import type { EventWeather, LoggedEvent } from './types';

// A weather record a member already has on this event can become the edition's record, when it is for
// the edition's place and its days all fall inside the edition's dates. Only the place, coordinates, days
// and URL are copied; a record flagged cityChanged is never promoted.
export function promotableWeather(event: LoggedEvent, edition: Edition): EventWeather | undefined {
  const w = event.weather;
  if (!w || w.cityChanged || !w.days.length) return undefined;
  if (!edition.startDate || !edition.city) return undefined;
  const want = normalizeName(cityWithRegion(edition.city, edition.region) ?? edition.city);
  if (normalizeName(w.place) !== want) return undefined;
  const end = edition.endDate && edition.endDate > edition.startDate ? edition.endDate : edition.startDate;
  const inside = w.days.every((d) => d.date >= edition.startDate! && d.date <= end);
  return inside ? { place: w.place, latitude: w.latitude, longitude: w.longitude, days: w.days, sourceUrl: w.sourceUrl, checkedAt: w.checkedAt } : undefined;
}

// One weather record per canonical edition (docs/specs/canonical-weather.md). A save from the edition
// copies the record when the edition has one. When it has none, a record the member already has for
// these days is promoted; otherwise one lookup fills it, so later members reuse it. Each change is
// recorded on the edition's history.
export async function weatherForEdition(
  store: LineupStore,
  edition: Edition,
  event: LoggedEvent,
  fetcher: Fetcher,
  now: Date,
): Promise<{ weather?: EventWeather; source: 'edition' | 'promoted' | 'lookup' | 'none' }> {
  if (edition.weather) return { weather: edition.weather, source: 'edition' };
  const promoted = promotableWeather(event, edition);
  if (promoted) {
    await writeEdition(store, {
      edition: { ...edition, weather: promoted },
      before: edition,
      actor: 'system:weather',
      reason: 'a member lookup for these days was copied to the edition',
    });
    return { weather: promoted, source: 'promoted' };
  }
  const { weather } = await lookupWeather(resolveEvent(event, edition), fetcher, now);
  if (!weather) return { source: 'none' };
  await writeEdition(store, {
    edition: { ...edition, weather },
    before: edition,
    actor: 'system:weather',
    reason: 'weather looked up once for the edition',
  });
  return { weather, source: 'lookup' };
}
