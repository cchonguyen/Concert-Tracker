import {
  ExtractedEventManifest,
  TransformedIngestionPayload,
  EngineMetadata,
  ScanningCues,
  StagingInput,
  PopulatedEvent,
  BillingRole,
} from '../types/schema';
import { concertStore } from './storage';

export interface ExtractionEngineResult {
  manifest: ExtractedEventManifest;
  transformed: TransformedIngestionPayload;
  metadata: EngineMetadata;
  modelUsed: string;
}

export interface IngestionOverrides {
  ticketPrice?: number;
  seatingTier?: string;
  companions?: string[];
  attendanceStatus?: 'attended' | 'upcoming' | 'wishlist';
  rating?: number;
  isOutdoor?: boolean;
}

/**
 * Fast client-side lexical scanner that provides instantaneous cue feedback
 * as the user types queries, guiding the user on how the engine will tokenize.
 */
export function scanLocalInputCues(input: StagingInput): ScanningCues {
  const query = input.concertName.trim();
  const rawTokens = query.split(/\s+/).filter(Boolean);
  const supportingActs: string[] = [];
  let headliner = '';
  let venueCue = input.venueHint?.trim() || '';
  let municipalityCue = input.cityHint?.trim() || '';
  let dateCue = input.dateHint?.trim() || '';
  let endDateCue = input.endDateHint?.trim() || '';
  let tourCue = input.tourHint?.trim() || '';
  const isFestival = /festival|fest|sun\s*soaked|sunsoaked|coachella|lollapalooza|edc|bonnaroo|in the park|gov ball|outside lands|primavera|primavera sound|portola|crssd|austin city limits|acl/i.test(query);

  // Specialized festival edition parsing for Sun Soaked (Kaskade)
  if (/sun\s*soaked|sunsoaked/i.test(query)) {
    headliner = 'Kaskade';
    tourCue = tourCue || 'Sun Soaked 2026';
    venueCue = venueCue || 'Huntington State Beach';
    municipalityCue = municipalityCue || 'Huntington Beach';
    if (/\b2026\b/.test(query) || !dateCue) {
      dateCue = dateCue || '2026-09-12';
    }
  }

  // Split on delimiters like "with", "feat.", "featuring", "b2b", "and", "x", "+"
  const parts = query.split(/\s+(?:with|feat\.?|featuring|b2b|and|x|\+)\s+/i);
  if (parts.length > 1) {
    headliner = parts[0].replace(/(?:Tour|Live|Concert|Festival|at\s+.*)/i, '').trim();
    for (let i = 1; i < parts.length; i++) {
      const act = parts[i].replace(/(?:at\s+.*|in\s+.*|\d{4}.*)/i, '').trim();
      if (act) supportingActs.push(act);
    }
  } else {
    const atMatch = query.match(/(?:at|@)\s+([^,]+)(?:,\s*([^,]+))?/i);
    if (atMatch) {
      if (!venueCue) venueCue = atMatch[1].trim();
      if (!municipalityCue && atMatch[2]) municipalityCue = atMatch[2].trim();
      headliner = query.slice(0, atMatch.index).replace(/(?:Tour|Live|Concert)/i, '').trim();
    } else {
      headliner = query.replace(/(?:Tour|Live|Concert)/i, '').trim();
    }
  }

  // Specialized festival edition parsing for Zedd in the Park
  if (/zedd.*in.*the.*park/i.test(query)) {
    headliner = 'Zedd';
    venueCue = venueCue || 'Los Angeles State Historic Park';
    municipalityCue = municipalityCue || 'Los Angeles';
    if (/\b2022\b/.test(query)) {
      dateCue = dateCue || '2022-07-08';
      tourCue = tourCue || 'Zedd in the Park 2022';
    } else if (/\b2024\b/.test(query)) {
      dateCue = dateCue || '2024-09-06';
      endDateCue = endDateCue || '2024-09-07';
      tourCue = tourCue || 'Zedd in the Park 2024';
    } else if (/\b2026\b/.test(query)) {
      dateCue = dateCue || '2026-08-14';
      endDateCue = endDateCue || '2026-08-15';
      tourCue = tourCue || 'Zedd in the Park 2026';
      venueCue = "Randall's Island Park";
      municipalityCue = 'New York City';
    } else if (/\b2019\b/.test(query)) {
      dateCue = dateCue || '2019-09-07';
      tourCue = tourCue || 'Zedd in the Park 2019';
    }
  }

  // Check for multi-day date span in query or dateHint, e.g. "Sept 6-7, 2024" or "April 19-21, 2024"
  let isMultiDay = Boolean(endDateCue);
  let estimatedDays = endDateCue ? 2 : undefined;

  const combinedDateText = `${query} ${input.dateHint || ''} ${input.notesHint || ''}`;
  const rangeMatch = combinedDateText.match(/(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*)\s+(\d{1,2})\s*[-–—]\s*(\d{1,2})(?:,?\s*(\d{4}))?/i);
  if (rangeMatch) {
    const startDay = parseInt(rangeMatch[1], 10);
    const endDay = parseInt(rangeMatch[2], 10);
    if (endDay > startDay && endDay - startDay < 10) {
      isMultiDay = true;
      estimatedDays = endDay - startDay + 1;
    }
  }

  if (/(?:2|3|4|5)[- ]day|weekend pass|multi[- ]day/i.test(combinedDateText)) {
    isMultiDay = true;
    const dayCountMatch = combinedDateText.match(/(\d)[- ]day/i);
    if (dayCountMatch) {
      estimatedDays = parseInt(dayCountMatch[1], 10);
    }
  }

  if (!dateCue) {
    const yearMatch = query.match(/\b(20\d{2})\b/);
    if (yearMatch) dateCue = yearMatch[1];
  }

  return {
    rawTokens,
    headliner: headliner || undefined,
    supportingActs,
    venueCue: venueCue || undefined,
    municipalityCue: municipalityCue || undefined,
    dateCue: dateCue || undefined,
    endDateCue: endDateCue || undefined,
    tourCue: tourCue || undefined,
    isFestival,
    isMultiDay,
    estimatedDays,
  };
}

/**
 * Executes the Gemini AI extraction engine via the server-side proxy
 */
export async function executeEventExtraction(input: StagingInput): Promise<ExtractionEngineResult> {
  const response = await fetch('/api/extract-event', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Extraction failed with status ${response.status}`);
  }

  const result = await response.json();
  return {
    manifest: result.manifest,
    transformed: result.transformed,
    metadata: result.metadata,
    modelUsed: result.modelUsed || result.metadata?.extractionModel || 'gemini-3.8-flash',
  };
}

/**
 * Passes transformed data from the extraction engine to the database and interface
 */
export function ingestExtractedEvent(
  manifest: ExtractedEventManifest,
  overrides?: IngestionOverrides
): PopulatedEvent {
  return concertStore.commitManifest(manifest, {
    ticketPrice: overrides?.ticketPrice,
    seatingTier: overrides?.seatingTier,
    companions: overrides?.companions,
    attendanceStatus: overrides?.attendanceStatus || 'attended',
    rating: overrides?.rating || 5,
    isOutdoor: overrides?.isOutdoor ?? manifest.venue.isOutdoor ?? false,
  });
}
