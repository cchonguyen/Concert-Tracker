import type { Edition, Fetcher } from '../lineup/types';
import type { LineupStore } from '../lineup/store/types';
import { writeEdition } from '../canon/editions';
import { resolveEvent } from './inherit';
import { lookupWeather } from './weather';
import type { EventWeather, LoggedEvent } from './types';

// One weather record per canonical edition (docs/specs/canonical-weather.md). A save from the edition
// copies the record when the edition has one. When it has none, one lookup fills it, so later members
// reuse it. The change is recorded on the edition's history.
export async function weatherForEdition(
  store: LineupStore,
  edition: Edition,
  event: LoggedEvent,
  fetcher: Fetcher,
  now: Date,
): Promise<{ weather?: EventWeather; source: 'edition' | 'lookup' | 'none' }> {
  if (edition.weather) return { weather: edition.weather, source: 'edition' };
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
