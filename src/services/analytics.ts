import {
  ArtistAffinityMetric,
  FestivalAttendanceMetric,
  LineupOverlapMetric,
  PopulatedEvent,
  TemporalVelocityMetric,
  VenueLoyaltyMetric,
} from '../types/schema';

export interface HabitTelemetrySummary {
  totalEvents: number;
  uniqueArtists: number;
  uniqueVenues: number;
  outdoorPercentage: number;
  totalExpenditure: number;
  averageTicketPrice: number;
  topHeadliner: string | null;
  topVenue: string | null;
  mostActiveYear: string | null;
  artistAffinities: ArtistAffinityMetric[];
  venueLoyalties: VenueLoyaltyMetric[];
  temporalVelocity: TemporalVelocityMetric[];
  lineupOverlaps: LineupOverlapMetric[];
  totalFestivalEvents: number;
  totalFestivalDays: number;
  attendedFestivalDays: number;
  festivalAttendanceRate: number;
  festivalBreakdown: FestivalAttendanceMetric[];
  costPerAttendedDay: number;
}

export function computeHabitTelemetry(events: PopulatedEvent[]): HabitTelemetrySummary {
  if (events.length === 0) {
    return {
      totalEvents: 0,
      uniqueArtists: 0,
      uniqueVenues: 0,
      outdoorPercentage: 0,
      totalExpenditure: 0,
      averageTicketPrice: 0,
      topHeadliner: null,
      topVenue: null,
      mostActiveYear: null,
      artistAffinities: [],
      venueLoyalties: [],
      temporalVelocity: [],
      lineupOverlaps: [],
      totalFestivalEvents: 0,
      totalFestivalDays: 0,
      attendedFestivalDays: 0,
      festivalAttendanceRate: 0,
      festivalBreakdown: [],
      costPerAttendedDay: 0,
    };
  }

  // 1. Artist Affinity Indices
  const artistMap = new Map<
    string,
    {
      artistId: string;
      artistName: string;
      mbid?: string | null;
      headlineCount: number;
      supportCount: number;
      festivalCount: number;
      dates: string[];
    }
  >();

  events.forEach((evt) => {
    evt.appearances.forEach((app) => {
      const art = app.artist;
      if (!artistMap.has(art.id)) {
        artistMap.set(art.id, {
          artistId: art.id,
          artistName: art.name,
          mbid: art.musicbrainz_id,
          headlineCount: 0,
          supportCount: 0,
          festivalCount: 0,
          dates: [],
        });
      }
      const entry = artistMap.get(art.id)!;
      entry.dates.push(evt.event_date);

      if (app.billing_role === 'headliner') {
        entry.headlineCount += 1;
      } else if (app.billing_role === 'support' || app.billing_role === 'guest') {
        entry.supportCount += 1;
      } else {
        entry.festivalCount += 1;
      }
    });
  });

  const artistAffinities: ArtistAffinityMetric[] = Array.from(artistMap.values())
    .map((item) => {
      const total = item.headlineCount + item.supportCount + item.festivalCount;
      const sortedDates = [...item.dates].sort();
      let affinityTier: ArtistAffinityMetric['affinityTier'] = 'Occasional';
      if (total >= 4) affinityTier = 'Obsession';
      else if (total >= 2) affinityTier = 'Core Favorite';
      else if (item.headlineCount >= 1) affinityTier = 'Regular';

      return {
        artistId: item.artistId,
        artistName: item.artistName,
        mbid: item.mbid,
        totalAppearances: total,
        headlineCount: item.headlineCount,
        supportCount: item.supportCount,
        festivalCount: item.festivalCount,
        firstSeenDate: sortedDates[0],
        lastSeenDate: sortedDates[sortedDates.length - 1],
        affinityTier,
      };
    })
    .sort((a, b) => b.totalAppearances - a.totalAppearances || b.headlineCount - a.headlineCount);

  // 2. Venue Loyalty Metrics
  const venueMap = new Map<
    string,
    {
      venueId: string;
      venueName: string;
      location: string;
      isOutdoor: boolean;
      dates: string[];
    }
  >();

  events.forEach((evt) => {
    const v = evt.venue;
    if (!venueMap.has(v.id)) {
      venueMap.set(v.id, {
        venueId: v.id,
        venueName: v.name,
        location: `${v.city}${v.state ? ', ' + v.state : ''}`,
        isOutdoor: !!v.isOutdoor,
        dates: [],
      });
    }
    venueMap.get(v.id)!.dates.push(evt.event_date);
  });

  const venueLoyalties: VenueLoyaltyMetric[] = Array.from(venueMap.values())
    .map((item) => {
      const sortedDates = [...item.dates].sort();
      return {
        venueId: item.venueId,
        venueName: item.venueName,
        location: item.location,
        visitCount: item.dates.length,
        isOutdoor: item.isOutdoor,
        firstVisit: sortedDates[0],
        lastVisit: sortedDates[sortedDates.length - 1],
        loyaltyRank: 0,
      };
    })
    .sort((a, b) => b.visitCount - a.visitCount)
    .map((item, idx) => ({ ...item, loyaltyRank: idx + 1 }));

  // 3. Temporal Velocity (Concentration across periods & annual expenditure)
  const periodMap = new Map<
    string,
    {
      periodKey: string;
      label: string;
      count: number;
      totalSpend: number;
      headliners: string[];
    }
  >();

  let totalSpend = 0;
  let paidEventsCount = 0;
  let outdoorCount = 0;

  events.forEach((evt) => {
    if (evt.venue.isOutdoor) outdoorCount++;
    if (evt.ticket_price && evt.ticket_price > 0) {
      totalSpend += evt.ticket_price;
      paidEventsCount++;
    }

    const year = evt.event_date.slice(0, 4);
    if (!periodMap.has(year)) {
      periodMap.set(year, {
        periodKey: year,
        label: year,
        count: 0,
        totalSpend: 0,
        headliners: [],
      });
    }
    const entry = periodMap.get(year)!;
    entry.count += 1;
    if (evt.ticket_price) entry.totalSpend += evt.ticket_price;

    const headliners = evt.appearances
      .filter((a) => a.billing_role === 'headliner')
      .map((a) => a.artist.name);
    entry.headliners.push(...headliners);
  });

  const temporalVelocity: TemporalVelocityMetric[] = Array.from(periodMap.values()).sort(
    (a, b) => a.periodKey.localeCompare(b.periodKey),
  );

  // 4. Lineup Overlap Ratios (Recurring pairings between headliners and supporting acts)
  const overlapMap = new Map<
    string,
    {
      primaryHeadliner: string;
      supportingAct: string;
      sharedShowsCount: number;
      tours: Set<string>;
      events: { eventName: string; date: string }[];
    }
  >();

  events.forEach((evt) => {
    const headliners = evt.appearances.filter((a) => a.billing_role === 'headliner');
    const supporters = evt.appearances.filter(
      (a) => a.billing_role === 'support' || a.billing_role === 'guest',
    );

    headliners.forEach((hl) => {
      supporters.forEach((sup) => {
        const key = `${hl.artist.name}:::${sup.artist.name}`;
        if (!overlapMap.has(key)) {
          overlapMap.set(key, {
            primaryHeadliner: hl.artist.name,
            supportingAct: sup.artist.name,
            sharedShowsCount: 0,
            tours: new Set<string>(),
            events: [],
          });
        }
        const o = overlapMap.get(key)!;
        o.sharedShowsCount += 1;
        if (evt.tour_name) o.tours.add(evt.tour_name);
        o.events.push({ eventName: evt.name, date: evt.event_date });
      });
    });
  });

  const lineupOverlaps: LineupOverlapMetric[] = Array.from(overlapMap.values())
    .map((o) => ({
      primaryHeadliner: o.primaryHeadliner,
      supportingAct: o.supportingAct,
      sharedShowsCount: o.sharedShowsCount,
      tours: Array.from(o.tours),
      events: o.events,
    }))
    .sort((a, b) => b.sharedShowsCount - a.sharedShowsCount);

  const outdoorPercentage = Math.round((outdoorCount / events.length) * 100);
  const avgTicket = paidEventsCount > 0 ? Math.round(totalSpend / paidEventsCount) : 0;

  // 5. Multi-Day Festival Attendance Telemetry
  const festivalEvents = events.filter(
    (e) => e.is_festival || (e.festival_days && e.festival_days.length > 0),
  );

  let totalFestivalDays = 0;
  let attendedFestivalDays = 0;

  const festivalBreakdown: FestivalAttendanceMetric[] = festivalEvents.map((evt) => {
    const days = evt.festival_days && evt.festival_days.length > 0
      ? evt.festival_days
      : [
          {
            date: evt.event_date,
            day_index: 1,
            label: 'Day 1',
            attended: evt.attendance_status === 'attended',
          },
        ];

    const totalDays = days.length;
    const attendedList = days.filter((d) => d.attended);
    const attendedDaysCount = attendedList.length;
    const attendedDates = attendedList.map((d) => d.date);
    const attendancePercentage = totalDays > 0 ? Math.round((attendedDaysCount / totalDays) * 100) : 0;

    totalFestivalDays += totalDays;
    attendedFestivalDays += attendedDaysCount;

    return {
      eventId: evt.id,
      eventName: evt.name,
      tourName: evt.tour_name,
      startDate: evt.event_date,
      endDate: evt.end_date,
      totalDays,
      attendedDaysCount,
      attendancePercentage,
      attendedDates,
      days,
    };
  });

  const festivalAttendanceRate =
    totalFestivalDays > 0 ? Math.round((attendedFestivalDays / totalFestivalDays) * 100) : 0;

  // Total attended live days = attended single shows + attended festival days
  const singleShowsAttended = events.filter(
    (e) => !e.is_festival && (!e.festival_days || e.festival_days.length === 0) && e.attendance_status === 'attended',
  ).length;
  const totalAttendedLiveDays = singleShowsAttended + attendedFestivalDays;
  const costPerAttendedDay = totalAttendedLiveDays > 0 ? Math.round(totalSpend / totalAttendedLiveDays) : avgTicket;

  return {
    totalEvents: events.length,
    uniqueArtists: artistAffinities.length,
    uniqueVenues: venueLoyalties.length,
    outdoorPercentage,
    totalExpenditure: totalSpend,
    averageTicketPrice: avgTicket,
    topHeadliner: artistAffinities[0]?.artistName || null,
    topVenue: venueLoyalties[0]?.venueName || null,
    mostActiveYear: [...temporalVelocity].sort((a, b) => b.count - a.count)[0]?.label || null,
    artistAffinities,
    venueLoyalties,
    temporalVelocity,
    lineupOverlaps,
    totalFestivalEvents: festivalEvents.length,
    totalFestivalDays,
    attendedFestivalDays,
    festivalAttendanceRate,
    festivalBreakdown,
    costPerAttendedDay,
  };
}
