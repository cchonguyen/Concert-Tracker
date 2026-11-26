import type { CleanupStep } from './seriesCleanup';

// The approved series cleanup list (/mnt/project-files/series-cleanup/cleanup-list.md, approved by Charlie
// 2026-11-26), as steps for runSeriesCleanup. One-time data, like a data migration: slugs and edition ids come
// from the live records read on 2026-11-26. It is not a list the app matches against, and it is removed once
// it has run and the read-only check passes.
const tour = 'tour' as const;
const festival = 'festival' as const;

const festivals: CleanupStep[] = [
  // Lost In Dreams: one series per city; the two editions of 2025-07-11 become one.
  { op: 'series', slug: 'lost-in-dreams-las-vegas', create: true, brand: 'Lost In Dreams', qualifier: 'Las Vegas', kind: festival },
  { op: 'edition', id: 'a91de4e5-09fd-4030-9a33-6b76c08ac8c8', seriesSlug: 'lost-in-dreams-las-vegas' },
  { op: 'series', slug: 'lost-in-dreams', qualifier: 'Los Angeles', aliases: ['Lost in Dreams LA', 'Lost In Dreams SoCal'] },
  { op: 'mergeEditions', ids: ['f7a14859-355e-4c1d-ba71-e43edc24edac', '773a3842-706e-4e18-af55-1fdf92bc1e61'] },
  // Zedd in the Park: Los Angeles and New York City.
  { op: 'series', slug: 'zedd-in-the-park', qualifier: 'Los Angeles' },
  { op: 'series', slug: 'zedd-in-the-park-new-york-city', create: true, brand: 'Zedd in the Park', qualifier: 'New York City', kind: festival },
  { op: 'edition', id: '52a34da7-2d23-47da-8af9-554d5a4a2b36', seriesSlug: 'zedd-in-the-park-new-york-city' },
  // A State of Trance: Los Angeles ("1000"), Rotterdam, Mexico City (the empty duplicate reused).
  { op: 'series', slug: 'a-state-of-trance', qualifier: 'Los Angeles', aliases: ['A State of Trance 1000'] },
  { op: 'edition', id: '34955a9d-ca56-4374-96cf-4fba68b12f84', subtitle: '1000' },
  { op: 'series', slug: 'a-state-of-trance-rotterdam', create: true, brand: 'A State of Trance', qualifier: 'Rotterdam', kind: festival },
  { op: 'edition', id: '01aa7db0-42ae-4df4-b882-0c85d9b31ff8', seriesSlug: 'a-state-of-trance-rotterdam' },
  { op: 'series', slug: 'a-state-of-trance-mexico-city', brand: 'A State of Trance', qualifier: 'Mexico City', kind: festival },
  { op: 'edition', id: '91b6bcd7-06f6-42e5-8094-73bcf77c7bdc', seriesSlug: 'a-state-of-trance-mexico-city' },
  // Renames and fixes.
  { op: 'series', slug: 'head-in-the-clouds', name: 'Head in the Clouds', aliases: ['Head in the Clouds Los Angeles'] },
  { op: 'series', slug: 'atlantis-cruise', name: 'Atlantis Cruise', aliases: ['Atlantis Cruise Carribean'] },
  { op: 'series', slug: 'outloud-music-festival-in-west-hollywood', name: 'OUTLOUD Music Festival in West Hollywood', brand: 'OUTLOUD Music Festival' },
  {
    op: 'series',
    slug: 'above-and-beyond-group-therapy-700',
    name: 'Above & Beyond Group Therapy Weekender',
    brand: 'Above & Beyond',
    aliases: ['ABGT Weekender', 'Above & Beyond: Group Therapy'],
  },
  { op: 'edition', id: 'c9d20e64-d97a-4971-87f4-2dc166b407d0', subtitle: '700' },
  { op: 'series', slug: 'isoknock-4', name: 'ISOKNOCK', brand: 'ISOKNOCK', aliases: ['ISOKNOCK 4'] },
  { op: 'edition', id: '043dc0fb-640a-477d-a4d3-b6a0d58ea7b1', subtitle: '4' },
  { op: 'series', slug: 'dreamstate-socal', aliases: ['Dreamstate Long Beach', 'Dreamstate'] },
  { op: 'series', slug: 'countdown-nye', aliases: ['Countdown', 'Countdown NYE', 'Countdown SoCal'] },
  { op: 'series', slug: 'edc-pool-party', brand: 'EDC' },
  // Missing brands: the name without its place word, which becomes the qualifier.
  { op: 'series', slug: 'boo-seattle', brand: 'BOO!', qualifier: 'Seattle' },
  { op: 'series', slug: 'electric-zoo', brand: 'Electric Zoo' },
  { op: 'series', slug: 'everything-always', brand: 'Everything Always' },
  { op: 'series', slug: 'experts-only', brand: 'Experts Only' },
  { op: 'series', slug: 'fvded-in-the-park', brand: 'FVDED in the Park' },
  { op: 'series', slug: 'stacked-vancouver', brand: 'STACKED', qualifier: 'Vancouver' },
  { op: 'series', slug: 'together-as-one', brand: 'Together As One' },
  { op: 'series', slug: 'unreal-san-francisco', brand: 'Unreal', qualifier: 'San Francisco' },
];

const festivalToTour: CleanupStep[] = [
  { op: 'mergeSeries', keep: 'illenium-gorge', drop: 'illenium-the-gorge' },
  { op: 'series', slug: 'illenium-gorge', name: 'Illenium at the Gorge', brand: 'Illenium', kind: tour, aliases: ['Illenium @ the Gorge'] },
  { op: 'series', slug: 'timmy-trumpet', brand: 'Timmy Trumpet', qualifier: 'Freakshow Tour', kind: tour },
  { op: 'series', slug: 'tritonal', brand: 'Tritonal', qualifier: 'Coalesce Tour', kind: tour },
  { op: 'series', slug: 'vini-vici', brand: 'Vini Vici', kind: tour },
  { op: 'series', slug: 'telykast-x-dubvision', kind: tour },
];

const tours: CleanupStep[] = [
  // Split where a stop names its own tour.
  { op: 'series', slug: 'andrew-bayer', brand: 'Andrew Bayer' },
  { op: 'series', slug: 'andrew-bayer-duality-tour', create: true, brand: 'Andrew Bayer', qualifier: 'Duality Tour', kind: tour },
  { op: 'edition', id: '7ebc5359-319e-4929-8ed9-e0787065c96f', seriesSlug: 'andrew-bayer-duality-tour' },
  { op: 'series', slug: 'andrew-rayel', brand: 'Andrew Rayel' },
  { op: 'series', slug: 'andrew-rayel-lifeline-tour', create: true, brand: 'Andrew Rayel', qualifier: 'Lifeline Tour', kind: tour },
  { op: 'edition', id: 'be8ed2f5-6b78-400e-b3d6-72bb1dc1ac01', seriesSlug: 'andrew-rayel-lifeline-tour' },
  { op: 'series', slug: 'jason-ross', brand: 'Jason Ross' },
  { op: 'series', slug: 'jason-ross-atlas-tour', create: true, brand: 'Jason Ross', qualifier: 'Atlas Tour', kind: tour },
  { op: 'edition', id: '1cb68815-aea3-4d2e-94df-cda32a921086', seriesSlug: 'jason-ross-atlas-tour' },
  { op: 'edition', id: 'bf21ddbf-0991-4a65-8748-dc9e306cd2e7', subtitle: 'Album Release' },
  { op: 'series', slug: 'seven-lions', brand: 'Seven Lions' },
  { op: 'series', slug: 'seven-lions-higher-love', create: true, brand: 'Seven Lions', qualifier: 'Higher Love', kind: tour },
  { op: 'edition', id: 'e57cb079-a033-4511-a01e-6bb85f2ebb72', seriesSlug: 'seven-lions-higher-love' },
  { op: 'series', slug: 'sara-landry', brand: 'Sara Landry', qualifier: 'HEKATE' },
  { op: 'series', slug: 'sara-landry-b2b-nico-moreno', name: 'Sara Landry', brand: 'Sara Landry', aliases: ['Sara Landry b2b Nico Moreno'] },
  { op: 'edition', id: 'f561e107-ec2d-4d6c-9f48-124bb37a2061', subtitle: 'b2b Nico Moreno' },
  { op: 'series', slug: 'gareth-emery-lsr-city', brand: 'Gareth Emery', qualifier: 'LSR/CITY', aliases: ['LSR/CITY'] },
  { op: 'edition', id: '85f692ae-e48b-46b9-8982-eb8f7954d02a', subtitle: 'Cyberpunk' },
  { op: 'series', slug: 'gareth-emery-club-afterparty', brand: 'Gareth Emery' },
  { op: 'edition', id: '29b13c17-8657-44cb-9e98-237bcfceac70', subtitle: 'Club afterparty' },
  { op: 'series', slug: 'lady-gaga', brand: 'Lady Gaga' },
  { op: 'series', slug: 'lady-gaga-the-chromatica-ball', brand: 'Lady Gaga', qualifier: 'The Chromatica Ball' },
  // "Artist: Tour name", the artist from the stored acts or the ticket title.
  { op: 'series', slug: 'taylor-swift-the-eras-tour', brand: 'Taylor Swift', qualifier: 'The Eras Tour', aliases: ['Taylor Swift | The Eras Tour'] },
  { op: 'series', slug: 'tove-lo-dirt-femme-tour-with-special-guest-slayyyter', brand: 'Tove Lo', qualifier: 'Dirt Femme Tour' },
  { op: 'series', slug: 'renaissance-world-tour', brand: 'Beyonce', qualifier: 'Renaissance World Tour' },
  { op: 'series', slug: 'blue-babu-tour', brand: 'Jai Wolf', qualifier: 'Blue Babu Tour' },
  { op: 'series', slug: 'heaven-hell-tour', brand: 'keshi', qualifier: 'Hell & Back Tour' },
  { op: 'series', slug: 'lucky-me-tour', brand: 'Hilary Duff', qualifier: 'Lucky Me Tour' },
  { op: 'series', slug: 'madeon', brand: 'Madeon', qualifier: 'Victory Live', aliases: ['Victory Live'] },
  { op: 'series', slug: 'illenium-trilogy-los-angeles-ages-18-w-valid-i-d', brand: 'Illenium', qualifier: 'Trilogy' },
  { op: 'series', slug: 'our-house-meduza-and-james-hype-ages-18-with-valid-id', brand: 'MEDUZA & James Hype' },
  { op: 'series', slug: 'kx5-la-memorial-coliseum', brand: 'Kaskade & deadmau5' },
  // Names cleaned only.
  { op: 'series', slug: 'k-d-w-special-guest-1788-l', name: 'K?D', brand: 'K?D' },
  { op: 'series', slug: 'pls-and-ty-clinic-thanksgiving-food-drive', name: 'PLS&TY', brand: 'PLS&TY' },
  { op: 'edition', id: '23a2b8a4-7072-4c31-b1cd-3d4a380bf2c3', subtitle: 'Clinic Thanksgiving Food Drive' },
  { op: 'series', slug: 'sabai-presents-ikigai-live-hollywood-palladium', brand: 'SABAI', qualifier: 'IKIGAI LIVE' },
  { op: 'series', slug: 'sneijder-pres-alt1', brand: 'Sneijder', qualifier: 'ALT1' },
  { op: 'edition', id: 'cc2cb88e-c4d8-47b3-be96-c8649f82adc0', subtitle: 'Monstercat 15 Year: LA' },
  { op: 'edition', id: 'c6e1f6fb-7077-4b56-b54f-2b76da57809e', subtitle: 'No Phone Zone' },
  { op: 'series', slug: 'jeff-mills', brand: 'Jeff Mills' },
  { op: 'edition', id: '67a45dbd-baa0-4f8e-9ee2-4f73aff445f2', subtitle: '30 Year Anniversary Liquid Room Mix' },
];

// Other one-artist series get the artist as brand: named in the stored acts or the ticket title.
const ONE_ARTIST: Array<[string, string]> = [
  ['a-teens', 'A*Teens'], ['acraze', 'ACRAZE'], ['armin-van-buuren', 'Armin van Buuren'], ['beauz', 'BEAUZ'],
  ['ben-nicky', 'Ben Nicky'], ['blastoyz', 'Blastoyz'], ['cash-cash', 'Cash Cash'], ['cosmic-gate', 'Cosmic Gate'],
  ['d-block-and-s-te-fan', 'D-Block & S-Te-Fan'], ['devault', 'Devault'], ['dj-hyo', 'DJ Hyo'], ['dom-dolla', 'Dom Dolla'],
  ['dubvision', 'DubVision'], ['eli-brown', 'Eli Brown'], ['embrz-at-harbor-house-rooftop', 'EMBRZ'], ['fantasm', 'Fantasm'],
  ['forester-dj-set', 'Forester'], ['fred-again', 'Fred again..'], ['gryffin', 'GRYFFIN'], ['inzo', 'INZO'],
  ['kream', 'KREAM'], ['laszewo', 'Laszewo'], ['layton-giordani', 'Layton Giordani'], ['lilly-palmer', 'Lilly Palmer'],
  ['loud-luxury', 'Loud Luxury'], ['maddix', 'Maddix'], ['manila-killa', 'Manila Killa'], ['marie-vaunt', 'Marie Vaunt'],
  ['marina', 'MARINA'], ['martin-garrix', 'Martin Garrix'], ['mau-p', 'Mau P'], ['max-styler', 'Max Styler'], ['maz', 'Maz'],
  ['midnight-kids', 'Midnight Kids'], ['morten', 'Morten'], ['nifra', 'Nifra'], ['ninajirachi-2nd-show-added', 'Ninajirachi'],
  ['nora-en-pure', 'Nora En Pure'], ['odesza', 'ODESZA'], ['oliver-smith', 'Oliver Smith'], ['restricted', 'Restricted'],
  ['rufus-du-sol', 'RÜFÜS DU SOL'], ['sam-feldt', 'Sam Feldt'], ['san-holo', 'San Holo'],
];

const yours: CleanupStep[] = [
  {
    op: 'removeOwnSeries',
    names: [
      'Co', 'Ex', 'ze', 'Vi', 'LS', 'LSR', 'outl', 'Victory', 'Victory Li', 'Victory Live Los Angeles', 'Day Trip L',
      'White arty Bangkok', 'White party Bangkok', 'White Party', 'Dreamstate Long Beach', 'Dreamstate SoCal Long Beach',
      'Zedd in the Park', 'A State of Trance: Mexico City',
    ],
  },
  { op: 'linkEvents' },
];

// Added after the first run (Charlie's choice, 2026-11-26): the last events with no shared series to link to.
// Breakaway, VELD and Planet Pride editions get a series; Head in the Clouds takes the place he typed.
const lastLinks: CleanupStep[] = [
  { op: 'series', slug: 'breakaway-music-festival-bay-area', create: true, brand: 'Breakaway Music Festival', qualifier: 'Bay Area' },
  { op: 'edition', id: '11f6dcd3-2067-4c4d-9adb-410f187bec47', seriesSlug: 'breakaway-music-festival-bay-area' },
  { op: 'series', slug: 'veld', create: true, name: 'VELD', brand: 'VELD' },
  { op: 'edition', id: '14e37ffe-1e94-4675-85ec-878abd4577bf', seriesSlug: 'veld' },
  { op: 'series', slug: 'planet-pride', create: true, name: 'Planet Pride', brand: 'Planet Pride' },
  { op: 'edition', id: '482e4eaf-f4bb-4169-9b6f-2ae69ac07ab7', seriesSlug: 'planet-pride' },
  { op: 'series', slug: 'head-in-the-clouds', qualifier: 'Pasadena' },
  { op: 'linkEvents' },
];

export const SERIES_CLEANUP_PLAN: CleanupStep[] = [
  ...festivals,
  ...festivalToTour,
  ...tours,
  ...ONE_ARTIST.map(([slug, brand]): CleanupStep => ({ op: 'series', slug, brand })),
  ...yours,
  ...lastLinks,
];
