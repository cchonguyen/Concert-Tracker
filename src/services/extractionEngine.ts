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
  const isFestival =
    /festival|fest|gathering|carnival|fair|summit|weekend|open\s*air|in\s*the\s*park|music\s*and\s*arts/i.test(
      query
    );

  // Check for "at <Venue>" or "@ <Venue>" or "in <City>"
  const atMatch = query.match(/(?:at|@)\s+([^,]+?)(?:\s+in\s+([^,]+))?(?:,\s*([A-Za-z\s]+))?$/i);
  let cleanedForArtists = query;
  if (atMatch) {
    if (!venueCue) venueCue = atMatch[1].trim();
    if (!municipalityCue && atMatch[2]) municipalityCue = atMatch[2].trim();
    if (!municipalityCue && atMatch[3]) municipalityCue = atMatch[3].trim();
    cleanedForArtists = query.slice(0, atMatch.index).trim();
  }

  // Deconstruct billing delimiters: with, feat., featuring, b2b, and, x, +, vs, supporting
  const parts = cleanedForArtists.split(/\s+(?:with|feat\.?|featuring|ft\.?|b2b|and|x|\+|vs\.?|presents)\s+/i);
  if (parts.length > 1) {
    headliner = parts[0].replace(/(?:Tour|Live|Concert|Festival|Fest|Residency)/gi, '').trim();
    for (let i = 1; i < parts.length; i++) {
      const act = parts[i]
        .replace(/(?:Tour|Live|Concert|Festival|Fest|at\s+.*|in\s+.*|\b20\d{2}\b.*)/gi, '')
        .trim();
      if (act && !supportingActs.includes(act)) supportingActs.push(act);
    }
  } else {
    // If it's a festival title like "Portola Music Festival 2024", treat the name as event title
    if (isFestival) {
      tourCue = tourCue || query.replace(/\b20\d{2}\b/g, '').trim();
      headliner = query.replace(/(?:Music\s+)?(?:Festival|Fest|Open\s*Air)\b/gi, '').trim();
    } else {
      headliner = cleanedForArtists.replace(/(?:Tour|Live|Concert)/gi, '').trim();
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
