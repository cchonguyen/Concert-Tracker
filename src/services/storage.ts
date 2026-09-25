import {
  Artist,
  BillingRole,
  ConcertEvent,
  EventAppearance,
  ExtractedEventManifest,
  FestivalDayAttendance,
  PopulatedEvent,
  Venue,
} from '../types/schema';

const STORAGE_KEYS = {
  EVENTS: 'livearchive_relational_events_v1',
  VENUES: 'livearchive_relational_venues_v1',
  ARTISTS: 'livearchive_relational_artists_v1',
  APPEARANCES: 'livearchive_relational_appearances_v1',
  CONFIG: 'livearchive_config_v1',
};

// Seed dataset
const SEED_VENUES: Venue[] = [
  {
    id: 'ven-1',
    name: 'Los Angeles State Historic Park',
    city: 'Los Angeles',
    state: 'California',
    country: 'United States',
    isOutdoor: true,
    capacity: 25000,
  },
  {
    id: 'ven-2',
    name: 'Empire Polo Club',
    city: 'Indio',
    state: 'California',
    country: 'United States',
    isOutdoor: true,
    capacity: 125000,
  },
  {
    id: 'ven-3',
    name: 'Kia Forum',
    city: 'Inglewood',
    state: 'California',
    country: 'United States',
    isOutdoor: false,
    capacity: 17500,
  },
  {
    id: 'ven-4',
    name: 'Red Rocks Amphitheatre',
    city: 'Morrison',
    state: 'Colorado',
    country: 'United States',
    isOutdoor: true,
    capacity: 9525,
  },
  {
    id: 'ven-5',
    name: 'Shrine Auditorium and Expo Hall',
    city: 'Los Angeles',
    state: 'California',
    country: 'United States',
    isOutdoor: false,
    capacity: 6300,
  },
];

const SEED_ARTISTS: Artist[] = [
  {
    id: 'art-1',
    name: 'Porter Robinson',
    musicbrainz_id: '9c6da991-8846-4be9-a8c6-bbad3d7e8284',
    genres: ['Electronic', 'Synth-pop', 'Electropop'],
  },
  {
    id: 'art-2',
    name: 'Ericdoa',
    musicbrainz_id: '50be9d53-a55b-4395-8848-18e3ddff1709',
    genres: ['Hyperpop', 'Digicore'],
  },
  {
    id: 'art-3',
    name: 'Kendrick Lamar',
    musicbrainz_id: 'd8628229-5094-4f96-88a8-01f0f29f6bdc',
    genres: ['Hip Hop', 'Conscious Rap'],
  },
  {
    id: 'art-4',
    name: 'Baby Keem',
    musicbrainz_id: '58e1c667-bb89-4a00-abfa-3cf6c8d76b1f',
    genres: ['Hip Hop', 'Trap'],
  },
  {
    id: 'art-5',
    name: 'Fred again..',
    musicbrainz_id: 'fc4bc598-be9c-485e-be98-6bb7f55b1129',
    genres: ['Electronic', 'UK Garage', 'House'],
  },
  {
    id: 'art-6',
    name: 'Skrillex',
    musicbrainz_id: '58414b28-fc33-4f9e-8c37-33e1eb30cc84',
    genres: ['Electronic', 'Bass Music', 'Dubstep'],
  },
  {
    id: 'art-7',
    name: 'Four Tet',
    musicbrainz_id: 'd0e51351-4040-424a-97ab-ebcf0f5a7035',
    genres: ['Electronic', 'IDM', 'Folktronica'],
  },
  {
    id: 'art-8',
    name: 'Justice',
    musicbrainz_id: '992a5d7c-bb2e-4b6d-a3d8-5f048d3db0a1',
    genres: ['Electro House', 'Electronic Rock'],
  },
  {
    id: 'art-9',
    name: 'Wallows',
    musicbrainz_id: '900b91d2-78d1-4dbd-8cf7-190f8450f39e',
    genres: ['Indie Rock', 'Post-Punk'],
  },
  {
    id: 'art-10',
    name: 'Zedd',
    musicbrainz_id: 'f5f242e0-ec56-42db-a178-3a9d9e604f32',
    genres: ['Electro House', 'EDM', 'Complextro'],
  },
  {
    id: 'art-11',
    name: 'Madeon',
    musicbrainz_id: 'd9b9a67a-e490-482d-8884-3079b76c117b',
    genres: ['Electropop', 'French House'],
  },
  {
    id: 'art-12',
    name: 'San Holo',
    musicbrainz_id: '86894b9d-5eb2-430c-be3a-6ff14ff352ff',
    genres: ['Future Bass', 'Indie Electronic'],
  },
];

const SEED_EVENTS: ConcertEvent[] = [
  {
    id: 'evt-1',
    name: 'Porter Robinson - SMILE! :D World Tour',
    tour_name: 'SMILE! :D World Tour',
    event_date: '2024-10-11',
    venue_id: 'ven-1',
    created_at: '2024-10-12T04:22:00Z',
    notes: 'Outdoor headline performance for the Smile album tour cycle. High energy live band setup.',
    setlist_confirmed: true,
    confidence_score: 0.98,
    source_urls: ['https://www.setlist.fm', 'https://pitchfork.com'],
    ticket_price: 85,
    seating_tier: 'General Admission Lawn',
    companions: ['Alex Chen', 'Sam Rivera'],
    attendance_status: 'attended',
    rating: 5,
    setlist_tracks: [
      { order: 1, title: 'Knock Yourself Out XD' },
      { order: 2, title: 'Cheerleader' },
      { order: 3, title: 'Russian Roulette' },
      { order: 4, title: 'Mona Lisa' },
      { order: 5, title: 'Look at the Sky' },
      { order: 6, title: 'Musician' },
      { order: 7, title: 'Sad Machine' },
      { order: 8, title: 'Shelter', isEncore: true },
      { order: 9, title: 'Everything Goes On', isEncore: true },
    ],
  },
  {
    id: 'evt-2',
    name: 'Coachella Valley Music & Arts Festival 2024',
    tour_name: 'Coachella 2024 (Weekend 2)',
    event_date: '2024-04-19',
    is_festival: true,
    end_date: '2024-04-21',
    festival_days: [
      {
        date: '2024-04-19',
        day_index: 1,
        label: 'Day 1 (Friday)',
        attended: false,
        notes: 'Did not attend Friday programming',
      },
      {
        date: '2024-04-20',
        day_index: 2,
        label: 'Day 2 (Saturday)',
        attended: false,
        notes: 'Did not attend Saturday programming',
      },
      {
        date: '2024-04-21',
        day_index: 3,
        label: 'Day 3 (Sunday)',
        attended: true,
        notes: 'Attended Sunday closure: Justice live debut at the Outdoor Theatre',
      },
    ],
    venue_id: 'ven-2',
    created_at: '2024-04-22T08:00:00Z',
    notes: 'Three-day desert festival. Attended Sunday only for Justice headline live tour debut at the Outdoor Theatre.',
    setlist_confirmed: true,
    confidence_score: 0.96,
    source_urls: ['https://coachella.com', 'https://setlist.fm'],
    ticket_price: 240,
    seating_tier: 'Single-Day Sunday Wristband',
    companions: ['Maya Lin', 'Alex Chen'],
    attendance_status: 'attended',
    rating: 5,
    setlist_tracks: [
      { order: 1, title: 'Genesis / Phantom' },
      { order: 2, title: 'Generator' },
      { order: 3, title: 'Neverender' },
      { order: 4, title: 'D.A.N.C.E. x Safe and Sound' },
      { order: 5, title: 'We Are Your Friends', isEncore: true },
    ],
  },
  {
    id: 'evt-6',
    name: 'Zedd in the Park 2024',
    tour_name: 'Zedd in the Park 2024',
    event_date: '2024-09-06',
    is_festival: true,
    end_date: '2024-09-07',
    festival_days: [
      {
        date: '2024-09-06',
        day_index: 1,
        label: 'Day 1 (Friday)',
        attended: true,
        notes: 'Attended full Friday: Zedd headline set with Madeon and San Holo',
      },
      {
        date: '2024-09-07',
        day_index: 2,
        label: 'Day 2 (Saturday)',
        attended: true,
        notes: 'Attended Day 2 festival finale with Grey, Ellis, and Throttle',
      },
    ],
    venue_id: 'ven-1',
    created_at: '2024-09-08T10:00:00Z',
    notes: 'Two-day flagship electronic festival at Los Angeles State Historic Park. Attended both Friday and Saturday editions.',
    setlist_confirmed: true,
    confidence_score: 0.98,
    source_urls: ['https://www.setlist.fm', 'https://zeddinthepark.com'],
    ticket_price: 185,
    seating_tier: '2-Day General Admission Pass',
    companions: ['Alex Chen', 'Sam Rivera'],
    attendance_status: 'attended',
    rating: 5,
    setlist_tracks: [
      { order: 1, title: 'Out of Time (Intro)' },
      { order: 2, title: 'Spectrum' },
      { order: 3, title: 'Clarity' },
      { order: 4, title: 'Stay The Night' },
      { order: 5, title: 'The Middle' },
      { order: 6, title: 'Alive', isEncore: true },
    ],
  },
  {
    id: 'evt-3',
    name: 'The Big Steppers Tour: Kendrick Lamar with Baby Keem',
    tour_name: 'The Big Steppers Tour',
    event_date: '2022-09-17',
    venue_id: 'ven-3',
    created_at: '2022-09-18T10:15:00Z',
    notes: 'Unbelievable production, ventriloquist puppet stagecraft, and Baby Keem family ties performance.',
    setlist_confirmed: true,
    confidence_score: 0.99,
    source_urls: ['https://thekiaforum.com', 'https://setlist.fm'],
    ticket_price: 165,
    seating_tier: 'Lower Bowl Section 112',
    companions: ['Marcus Davis'],
    attendance_status: 'attended',
    rating: 5,
    setlist_tracks: [
      { order: 1, title: 'United in Grief' },
      { order: 2, title: 'N95' },
      { order: 3, title: 'Worldwide Steppers' },
      { order: 4, title: 'Backseat Freestyle' },
      { order: 5, title: 'family ties (with Baby Keem)' },
      { order: 6, title: 'Savior', isEncore: true },
    ],
  },
  {
    id: 'evt-4',
    name: 'Fred again.. x Skrillex x Four Tet: Surprise Marathon',
    tour_name: 'Pangbourne House Mafia Pop-Up',
    event_date: '2023-02-17',
    venue_id: 'ven-5',
    created_at: '2023-02-18T12:00:00Z',
    notes: 'Historic spontaneous pop-up b3b before the MSG arena takeover. 5-hour continuous back-to-back set.',
    setlist_confirmed: true,
    confidence_score: 0.94,
    source_urls: ['https://www.youtube.com', 'https://setlist.fm'],
    ticket_price: 45,
    seating_tier: 'Floor GA',
    companions: ['Sam Rivera', 'Taylor Hayes'],
    attendance_status: 'attended',
    rating: 5,
    setlist_tracks: [
      { order: 1, title: 'Rumble' },
      { order: 2, title: 'Baby again..' },
      { order: 3, title: 'Leavemealone' },
      { order: 4, title: 'Country Riddim', isCover: true, originalArtist: 'HOL!' },
    ],
  },
  {
    id: 'evt-5',
    name: 'Wallows - Model & More Tour at Red Rocks',
    tour_name: 'Model & More World Tour',
    event_date: '2024-08-08',
    venue_id: 'ven-4',
    created_at: '2024-08-09T03:00:00Z',
    notes: 'Atmospheric sunset show overlooking Denver skyline from the monolith rocks.',
    setlist_confirmed: true,
    confidence_score: 0.92,
    source_urls: ['https://www.redrocksonline.com'],
    ticket_price: 95,
    seating_tier: 'Reserved Row 18',
    companions: ['Alex Chen'],
    attendance_status: 'attended',
    rating: 4,
    setlist_tracks: [
      { order: 1, title: 'Your Apartment' },
      { order: 2, title: 'Calling After Me' },
      { order: 3, title: 'Pleaser' },
      { order: 4, title: 'Are You Bored Yet?' },
      { order: 5, title: 'Only Friend', isEncore: true },
    ],
  },
];

const SEED_APPEARANCES: EventAppearance[] = [
  // Event 1: Porter Robinson Smile Tour
  {
    id: 'app-1',
    event_id: 'evt-1',
    artist_id: 'art-1',
    billing_role: 'headliner',
    billing_order: 1,
    stage_name: 'Main Stage',
  },
  {
    id: 'app-2',
    event_id: 'evt-1',
    artist_id: 'art-2',
    billing_role: 'support',
    billing_order: 2,
    stage_name: 'Main Stage',
  },
  // Event 2: Coachella Sunday (Justice headliner / lineup)
  {
    id: 'app-3',
    event_id: 'evt-2',
    artist_id: 'art-8',
    billing_role: 'headliner',
    billing_order: 1,
    stage_name: 'Outdoor Theatre',
  },
  // Event 3: Kendrick Lamar Big Steppers
  {
    id: 'app-4',
    event_id: 'evt-3',
    artist_id: 'art-3',
    billing_role: 'headliner',
    billing_order: 1,
    stage_name: 'Centre Stage',
  },
  {
    id: 'app-5',
    event_id: 'evt-3',
    artist_id: 'art-4',
    billing_role: 'support',
    billing_order: 2,
    stage_name: 'Centre Stage',
  },
  // Event 4: Fred again.. x Skrillex x Four Tet
  {
    id: 'app-6',
    event_id: 'evt-4',
    artist_id: 'art-5',
    billing_role: 'headliner',
    billing_order: 1,
    stage_name: 'Center 360 Booth',
  },
  {
    id: 'app-7',
    event_id: 'evt-4',
    artist_id: 'art-6',
    billing_role: 'headliner',
    billing_order: 2,
    stage_name: 'Center 360 Booth',
  },
  {
    id: 'app-8',
    event_id: 'evt-4',
    artist_id: 'art-7',
    billing_role: 'headliner',
    billing_order: 3,
    stage_name: 'Center 360 Booth',
  },
  // Event 5: Wallows Red Rocks
  {
    id: 'app-9',
    event_id: 'evt-5',
    artist_id: 'art-9',
    billing_role: 'headliner',
    billing_order: 1,
    stage_name: 'Amphitheatre Stage',
  },
  // Event 6: Zedd in the Park 2024 (2-Day Festival)
  {
    id: 'app-10',
    event_id: 'evt-6',
    artist_id: 'art-10',
    billing_role: 'headliner',
    billing_order: 1,
    stage_name: 'Main Stage',
  },
  {
    id: 'app-11',
    event_id: 'evt-6',
    artist_id: 'art-11',
    billing_role: 'support',
    billing_order: 2,
    stage_name: 'Main Stage',
  },
  {
    id: 'app-12',
    event_id: 'evt-6',
    artist_id: 'art-12',
    billing_role: 'support',
    billing_order: 3,
    stage_name: 'Main Stage',
  },
];

// Helper to safely load or initialize JSON from localStorage
function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`Error reading ${key} from localStorage, using fallback:`, err);
    return fallback;
  }
}

function saveToStorage<T>(key: string, data: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (err) {
    console.error(`Error saving ${key} to localStorage:`, err);
  }
}

export class RelationalConcertStore {
  private venues: Venue[];
  private artists: Artist[];
  private events: ConcertEvent[];
  private appearances: EventAppearance[];

  constructor() {
    this.venues = loadFromStorage(STORAGE_KEYS.VENUES, SEED_VENUES);
    this.artists = loadFromStorage(STORAGE_KEYS.ARTISTS, SEED_ARTISTS);
    this.events = loadFromStorage(STORAGE_KEYS.EVENTS, SEED_EVENTS);
    this.appearances = loadFromStorage(STORAGE_KEYS.APPEARANCES, SEED_APPEARANCES);

    // Save initial state if first run
    if (!localStorage.getItem(STORAGE_KEYS.EVENTS)) {
      this.persistAll();
    } else {
      // Migrate seed festival events if cached data lacks festival_days
      let hasMigrated = false;
      const coachella = this.events.find((e) => e.id === 'evt-2');
      if (coachella && (!coachella.festival_days || coachella.festival_days.length === 0)) {
        coachella.is_festival = true;
        coachella.end_date = '2024-04-21';
        coachella.festival_days = [
          { date: '2024-04-19', day_index: 1, label: 'Day 1 (Friday)', attended: false, notes: 'Did not attend Friday programming' },
          { date: '2024-04-20', day_index: 2, label: 'Day 2 (Saturday)', attended: false, notes: 'Did not attend Saturday programming' },
          { date: '2024-04-21', day_index: 3, label: 'Day 3 (Sunday)', attended: true, notes: 'Attended Sunday closure: Justice live debut at the Outdoor Theatre' },
        ];
        hasMigrated = true;
      }
      if (!this.events.some((e) => e.id === 'evt-6')) {
        const seedZedd = SEED_EVENTS.find((e) => e.id === 'evt-6');
        if (seedZedd) {
          this.events.push(seedZedd);
          const zeddApps = SEED_APPEARANCES.filter((a) => a.event_id === 'evt-6');
          this.appearances.push(...zeddApps);
          hasMigrated = true;
        }
      }
      if (hasMigrated) {
        this.persistAll();
      }
    }
  }

  private persistAll() {
    saveToStorage(STORAGE_KEYS.VENUES, this.venues);
    saveToStorage(STORAGE_KEYS.ARTISTS, this.artists);
    saveToStorage(STORAGE_KEYS.EVENTS, this.events);
    saveToStorage(STORAGE_KEYS.APPEARANCES, this.appearances);
  }

  public getAllVenues(): Venue[] {
    return [...this.venues];
  }

  public getAllArtists(): Artist[] {
    return [...this.artists];
  }

  public getAllEvents(): PopulatedEvent[] {
    const venueMap = new Map(this.venues.map((v) => [v.id, v]));
    const artistMap = new Map(this.artists.map((a) => [a.id, a]));

    return this.events
      .map((evt) => {
        const venue =
          venueMap.get(evt.venue_id) || {
            id: evt.venue_id,
            name: 'Unknown Venue',
            city: 'Unknown City',
            state: '',
            country: '',
          };

        const appearances = this.appearances
          .filter((app) => app.event_id === evt.id)
          .sort((a, b) => a.billing_order - b.billing_order)
          .map((app) => ({
            ...app,
            artist:
              artistMap.get(app.artist_id) || {
                id: app.artist_id,
                name: 'Unknown Performer',
              },
          }));

        return {
          ...evt,
          venue,
          appearances,
        };
      })
      .sort((a, b) => new Date(b.event_date).getTime() - new Date(a.event_date).getTime());
  }

  public getEventById(id: string): PopulatedEvent | null {
    const all = this.getAllEvents();
    return all.find((e) => e.id === id) || null;
  }

  // Typeahead lookups matching user specification
  public typeaheadArtists(query: string): Artist[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.artists.slice(0, 8);
    return this.artists
      .filter((a) => a.name.toLowerCase().includes(q))
      .slice(0, 10);
  }

  public typeaheadVenues(query: string): Venue[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.venues.slice(0, 8);
    return this.venues
      .filter(
        (v) =>
          v.name.toLowerCase().includes(q) ||
          v.city.toLowerCase().includes(q) ||
          v.state.toLowerCase().includes(q),
      )
      .slice(0, 10);
  }

  // Atomic Commit of Grounded Manifest
  public commitManifest(
    manifest: ExtractedEventManifest,
    extra?: {
      ticketPrice?: number;
      seatingTier?: string;
      companions?: string[];
      attendanceStatus?: 'attended' | 'upcoming' | 'wishlist';
      rating?: number;
      isOutdoor?: boolean;
      isFestival?: boolean;
      endDate?: string;
      festivalDays?: FestivalDayAttendance[];
    },
  ): PopulatedEvent {
    // 1. Resolve or Insert Venue
    let venue = this.venues.find(
      (v) =>
        v.name.trim().toLowerCase() === manifest.venue.name.trim().toLowerCase() ||
        (v.city.trim().toLowerCase() === manifest.venue.city.trim().toLowerCase() &&
          v.name.toLowerCase().includes(manifest.venue.name.toLowerCase())),
    );

    if (!venue) {
      venue = {
        id: 'ven-' + crypto.randomUUID().slice(0, 8),
        name: manifest.venue.name,
        city: manifest.venue.city,
        state: manifest.venue.state,
        country: manifest.venue.country,
        isOutdoor: extra?.isOutdoor ?? false,
      };
      this.venues.push(venue);
    } else {
      // update state/country if empty
      if (!venue.state && manifest.venue.state) venue.state = manifest.venue.state;
      if (!venue.country && manifest.venue.country) venue.country = manifest.venue.country;
    }

    // 2. Insert Event
    const isFestival = extra?.isFestival ?? manifest.isFestival ?? Boolean(manifest.endDate || (manifest.festivalDays && manifest.festivalDays.length > 0));
    const endDate = extra?.endDate ?? manifest.endDate;
    const festivalDays = extra?.festivalDays ?? manifest.festivalDays?.map((d) => ({
      date: d.date,
      day_index: d.dayIndex,
      label: d.label,
      attended: d.attended ?? true,
      notes: d.notes,
    }));

    const eventId = 'evt-' + crypto.randomUUID().slice(0, 8);
    const newEvent: ConcertEvent = {
      id: eventId,
      name: manifest.eventName,
      tour_name: manifest.tourName || undefined,
      event_date: manifest.eventDate,
      is_festival: isFestival,
      end_date: endDate,
      festival_days: festivalDays,
      venue_id: venue.id,
      created_at: new Date().toISOString(),
      notes: manifest.notes,
      setlist_confirmed: manifest.setlistConfirmed,
      confidence_score: manifest.confidenceScore,
      source_urls: manifest.sourceUrls || [],
      ticket_price: extra?.ticketPrice,
      seating_tier: extra?.seatingTier,
      companions: extra?.companions || [],
      attendance_status: extra?.attendanceStatus || 'attended',
      rating: extra?.rating || 5,
      engine_metadata: manifest.engineMetadata,
      setlist_tracks: manifest.suggestedSetlist || undefined,
    };
    this.events.unshift(newEvent);

    // 3. Resolve or Insert Artists & Appearances
    manifest.artists.forEach((art, idx) => {
      let artist = this.artists.find(
        (a) => a.name.trim().toLowerCase() === art.name.trim().toLowerCase(),
      );

      if (!artist) {
        artist = {
          id: 'art-' + crypto.randomUUID().slice(0, 8),
          name: art.name,
          musicbrainz_id: null,
        };
        this.artists.push(artist);
      }

      const appearance: EventAppearance = {
        id: 'app-' + crypto.randomUUID().slice(0, 8),
        event_id: eventId,
        artist_id: artist.id,
        billing_role: art.role as BillingRole,
        billing_order: art.billingOrder || idx + 1,
        stage_name: art.stage || 'Main Stage',
      };
      this.appearances.push(appearance);
    });

    this.persistAll();
    return this.getEventById(eventId)!;
  }

  // Update existing event
  public updateEvent(
    eventId: string,
    updates: Partial<ConcertEvent> & {
      venueDetails?: Partial<Venue>;
    },
  ): PopulatedEvent | null {
    const idx = this.events.findIndex((e) => e.id === eventId);
    if (idx === -1) return null;

    this.events[idx] = { ...this.events[idx], ...updates };

    if (updates.venueDetails && this.events[idx].venue_id) {
      const vIdx = this.venues.findIndex((v) => v.id === this.events[idx].venue_id);
      if (vIdx !== -1) {
        this.venues[vIdx] = { ...this.venues[vIdx], ...updates.venueDetails };
      }
    }

    this.persistAll();
    return this.getEventById(eventId);
  }

  // Assign MusicBrainz MBID to artist
  public updateArtistMbid(artistId: string, mbid: string, disambiguation?: string): void {
    const artist = this.artists.find((a) => a.id === artistId);
    if (artist) {
      artist.musicbrainz_id = mbid;
      if (disambiguation) artist.disambiguation = disambiguation;
      this.persistAll();
    }
  }

  // Update festival days attendance for an event
  public updateFestivalAttendance(
    eventId: string,
    festivalDays: FestivalDayAttendance[],
  ): PopulatedEvent | null {
    const idx = this.events.findIndex((e) => e.id === eventId);
    if (idx === -1) return null;
    this.events[idx].festival_days = festivalDays;
    this.events[idx].is_festival = true;
    this.persistAll();
    return this.getEventById(eventId);
  }

  // Toggle specific festival day attendance
  public toggleFestivalDayAttendance(
    eventId: string,
    dayIndex: number,
  ): PopulatedEvent | null {
    const idx = this.events.findIndex((e) => e.id === eventId);
    if (idx === -1 || !this.events[idx].festival_days) return null;
    const days = this.events[idx].festival_days!.map((d) =>
      d.day_index === dayIndex ? { ...d, attended: !d.attended } : d,
    );
    this.events[idx].festival_days = days;
    this.persistAll();
    return this.getEventById(eventId);
  }

  // Delete event and cascade appearances
  public deleteEvent(eventId: string): void {
    this.events = this.events.filter((e) => e.id !== eventId);
    this.appearances = this.appearances.filter((a) => a.event_id !== eventId);
    this.persistAll();
  }

  // Import / Merge records pulled from Supabase
  public importFromSupabase(remoteEvents: PopulatedEvent[]): number {
    let importedCount = 0;
    for (const rEvt of remoteEvents) {
      // 1. Reconcile Venue
      if (rEvt.venue) {
        const vIdx = this.venues.findIndex(
          (v) => v.id === rEvt.venue.id || v.name.trim().toLowerCase() === rEvt.venue.name.trim().toLowerCase()
        );
        if (vIdx === -1) {
          this.venues.push({
            id: rEvt.venue.id,
            name: rEvt.venue.name,
            city: rEvt.venue.city,
            state: rEvt.venue.state,
            country: rEvt.venue.country,
            isOutdoor: rEvt.venue.isOutdoor ?? false,
            capacity: rEvt.venue.capacity,
          });
        }
      }

      // 2. Reconcile Artists & Appearances
      if (rEvt.appearances) {
        for (const app of rEvt.appearances) {
          if (app.artist) {
            const aIdx = this.artists.findIndex(
              (a) => a.id === app.artist.id || a.name.trim().toLowerCase() === app.artist.name.trim().toLowerCase()
            );
            if (aIdx === -1) {
              this.artists.push({
                id: app.artist.id,
                name: app.artist.name,
                musicbrainz_id: app.artist.musicbrainz_id,
                disambiguation: app.artist.disambiguation,
                genres: app.artist.genres || [],
              });
            }
          }

          const existingApp = this.appearances.find(
            (a) => a.event_id === rEvt.id && a.artist_id === app.artist_id
          );
          if (!existingApp) {
            this.appearances.push({
              id: app.id || ('app-' + crypto.randomUUID().slice(0, 8)),
              event_id: rEvt.id,
              artist_id: app.artist_id,
              billing_role: app.billing_role,
              billing_order: app.billing_order,
              stage_name: app.stage_name,
            });
          }
        }
      }

      // 3. Reconcile Event
      const eIdx = this.events.findIndex(
        (e) => e.id === rEvt.id || (e.name.trim().toLowerCase() === rEvt.name.trim().toLowerCase() && e.event_date === rEvt.event_date)
      );

      const eventRecord: ConcertEvent = {
        id: rEvt.id,
        name: rEvt.name,
        tour_name: rEvt.tour_name,
        event_date: rEvt.event_date,
        is_festival: rEvt.is_festival ?? false,
        end_date: rEvt.end_date,
        festival_days: rEvt.festival_days,
        venue_id: rEvt.venue_id,
        created_at: rEvt.created_at || new Date().toISOString(),
        notes: rEvt.notes,
        setlist_confirmed: rEvt.setlist_confirmed ?? false,
        confidence_score: rEvt.confidence_score,
        source_urls: rEvt.source_urls || [],
        ticket_price: rEvt.ticket_price,
        seating_tier: rEvt.seating_tier,
        companions: rEvt.companions || [],
        attendance_status: rEvt.attendance_status || 'attended',
        rating: rEvt.rating || 5,
      };

      if (eIdx === -1) {
        this.events.push(eventRecord);
        importedCount++;
      } else {
        this.events[eIdx] = eventRecord;
      }
    }

    this.persistAll();
    return importedCount;
  }

  // Restore defaults
  public resetToDefaults(): void {
    this.venues = [...SEED_VENUES];
    this.artists = [...SEED_ARTISTS];
    this.events = [...SEED_EVENTS];
    this.appearances = [...SEED_APPEARANCES];
    this.persistAll();
  }
}

export const concertStore = new RelationalConcertStore();
