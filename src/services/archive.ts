import type { Attendance, Edition } from '../server/lineup/types';
import { ExtractedEventManifest, FestivalDayAttendance } from '../types/schema';
import { concertStore } from './storage';

function datesBetween(start: string, end?: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end || start}T00:00:00Z`);
  while (cur <= last && out.length < 14) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// Writes a confirmed edition into your personal archive. Only the sets you
// marked as seen become appearances, so "artists I've seen" counts real sets.
export function archiveConfirmedEdition(edition: Edition, attendance: Attendance | null, lookupJobId: string) {
  if (!edition.startDate) throw new Error('A start date is required to archive an event.');
  const seen = new Set(attendance?.seenArtistKeys ?? []);
  const seenPerformances = edition.performances.filter((p) => seen.has(p.artistKey));
  const allDays = datesBetween(edition.startDate, edition.endDate);
  const isFestival = allDays.length > 1 || edition.performances.length > 4;
  const attendedDays = new Set(attendance?.daysAttended?.length ? attendance.daysAttended : allDays);
  const festivalDays: FestivalDayAttendance[] | undefined =
    allDays.length > 1
      ? allDays.map((date, i) => ({
          date,
          day_index: i + 1,
          label: `Day ${i + 1} (${new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })})`,
          attended: attendedDays.has(date),
        }))
      : undefined;

  const manifest: ExtractedEventManifest = {
    eventName: edition.name,
    tourName: '',
    eventDate: edition.startDate,
    isFestival,
    isMultiDay: allDays.length > 1,
    endDate: edition.endDate,
    venue: {
      name: edition.venue ?? '',
      city: edition.city ?? '',
      state: '',
      country: edition.country ?? '',
    },
    artists: seenPerformances.map((p, i) => ({
      name: p.name,
      billingOrder: i + 1,
      role: isFestival ? 'festival_lineup' : i === 0 ? 'headliner' : 'support',
      stage: p.stages[0],
    })),
    setlistConfirmed: false,
    confidenceScore: 1,
    notes: attendance?.notes ?? '',
    sourceUrls: [...new Set(edition.performances.flatMap((p) => p.sources.map((s) => s.sourceUrl)).filter(Boolean))],
    engineMetadata: {
      extractionModel: 'source-first lookup',
      editionKey: edition.key,
      lookupJobId,
      timestamp: new Date().toISOString(),
    },
  };

  return concertStore.commitManifest(manifest, {
    ticketPrice: attendance?.ticketPrice,
    companions: attendance?.companions,
    rating: attendance?.rating,
    attendanceStatus: 'attended',
    isFestival,
    endDate: edition.endDate,
    festivalDays,
  });
}
