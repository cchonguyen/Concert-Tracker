import { useEffect, useState } from 'react';
import { eventsApi, type PlaceGuess } from '../services/lineupApi';
import { placePatch } from '../services/table';

export interface UsePlaceAutofillOptions {
  city?: string | null;
  region?: string | null;
  country?: string | null;
  pastCities: string[];
  enabled?: boolean;
  guessDelayMs?: number;
}

export interface PlaceMapOffer {
  value: string;
  from: string;
  patch: { city?: string; region?: string; country?: string };
}

/**
 * Shared place autofill hook for City suggestions (`/api/places/cities`) and
 * State/Country map lookup offers (`/api/places/guess`).
 */
export function usePlaceAutofill({
  city,
  region,
  country,
  pastCities,
  enabled = true,
  guessDelayMs = 300,
}: UsePlaceAutofillOptions) {
  const [cityQuery, setCityQuery] = useState('');
  const [foundCities, setFoundCities] = useState<string[]>([]);
  const [placeGuess, setPlaceGuess] = useState<PlaceGuess | null>(null);

  useEffect(() => {
    if (!enabled || cityQuery.trim().length < 3) {
      setFoundCities([]);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      eventsApi.cities(cityQuery).then(
        (cities) => {
          if (live) setFoundCities(cities);
        },
        () => {
          if (live) setFoundCities([]);
        },
      );
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [cityQuery, enabled]);

  const cleanCity = city?.trim() ?? '';
  const cleanRegion = region?.trim() ?? '';
  const cleanCountry = country?.trim() ?? '';

  useEffect(() => {
    setPlaceGuess(null);
    if (!enabled || !cleanCity || (cleanRegion && cleanCountry)) return;
    let live = true;
    const run = () => {
      eventsApi
        .placeGuess({
          city: cleanCity,
          ...(cleanRegion ? { region: cleanRegion } : {}),
          ...(cleanCountry ? { country: cleanCountry } : {}),
        })
        .then(
          (r) => {
            if (live) setPlaceGuess(r.guess);
          },
          () => undefined,
        );
    };
    if (guessDelayMs <= 0) {
      run();
      return () => {
        live = false;
      };
    }
    const t = window.setTimeout(run, guessDelayMs);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [cleanCity, cleanRegion, cleanCountry, enabled, guessDelayMs]);

  const citySuggestions = [...new Set([...pastCities, ...foundCities])];
  const guessed =
    enabled && placeGuess
      ? placePatch(
          {
            city: cleanCity || undefined,
            region: cleanRegion || undefined,
            country: cleanCountry || undefined,
          },
          placeGuess,
        )
      : null;

  const mapOffer: PlaceMapOffer | null =
    guessed && placeGuess
      ? {
          value: placeGuess.label,
          from: placeGuess.places > 1 ? 'the map (the biggest by that name)' : 'the map',
          patch: guessed,
        }
      : null;

  return {
    cityQuery,
    setCityQuery,
    foundCities,
    citySuggestions,
    placeGuess,
    guessed,
    mapOffer,
  };
}
