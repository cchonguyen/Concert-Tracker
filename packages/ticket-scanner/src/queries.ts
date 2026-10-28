// Gmail search strings. Stream A sweeps known sellers by sender. Stream B
// catches forwarded tickets, wallet passes and box offices by content. Every
// exclusion in Stream B wraps the whole query, so `filename:pkpass` cannot let
// boarding passes or movie tickets through.

export const STREAM_A_QUERY =
  'from:(ticketmaster.com OR livenation.com OR axs.com OR dice.fm OR eventbrite.com OR tixr.com OR residentadvisor.net OR frontgatetickets.com OR ticketweb.com OR seetickets.us OR seetickets.com OR shotgun.live OR posh.vip OR etix.com OR universe.com OR showclix.com OR prekindle.com OR venuepilot.com OR seated.com OR feverup.com OR stubhub.com OR seatgeek.com OR vividseats.com OR tickpick.com OR cashortrade.org)';

export const STREAM_B_QUERY =
  '-cinema -movie -fandango -airline -flight -"boarding pass" ((subject:(ticket OR tickets OR "order confirmation" OR "your order" OR "e-ticket" OR guestlist OR rsvp OR wristband) AND (venue OR doors OR "general admission" OR section OR barcodes OR "will call" OR "presented by" OR lineup OR admission)) OR filename:pkpass)';

// Watermarks: each stream keeps its own cursor, and a 1-day lookback covers
// late deliveries.
export const LOOKBACK_DAYS = 1;

export function queriesSince(scannedThrough: string | undefined): { streamA: string; streamB: string } {
  const after = scannedThrough ? ` after:${scannedThrough.slice(0, 10).replaceAll('-', '/')}` : '';
  return {
    streamA: `${STREAM_A_QUERY}${after}`,
    streamB: `${STREAM_B_QUERY}${after}`,
  };
}
