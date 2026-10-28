# @livearchive/ticket-scanner

A headless, zero-dependency engine that reads concert ticket emails and proposes
events. It runs in browsers, Cloudflare Workers and Node, and works only in memory.
It has no knowledge of any database. The host app writes the results.

## Boundary rules

- No imports from outside `packages/ticket-scanner/` (no `../../`).
- Web Standard APIs only. No `fs`, `net`, `crypto` module, `stream`, `buffer` or Worker bindings.
- Deterministic code only. There is no model call anywhere in the package.
- Every extracted value carries the verbatim quote it came from (`isVerbatim`).

## Status

Built:

- Layer 1: Stream A and Stream B Gmail queries with watermarks.
- Layer 2: schema.org `EventReservation` (JSON-LD and microdata), Apple Wallet
  `.pkpass` (only `eventTicket` passes) and `.ics` invites, read by
  `scanEmails`. Markup fills what the body lacks; the body's values win.
- Layer 3: the nine Tier 1 seller readers, 15 boutique and resale readers
  (`src/readers/boutique.ts`, `src/readers/resale.ts`), and the forward
  unwrapper (Gmail, Apple Mail, Outlook, Yahoo, multi-hop, and name-only
  senders such as "From: Ticketmaster").
- Layer 4: the verbatim reader for everyone else, with an order-anchor gate,
  non-show filters, and an `unreadable` fallback for ticket subjects.
- A per-ticket price is never claimed when a parking, merch or other add-on
  line has a price.

The boutique and resale layouts were written from public samples, not real
mail, so expect to adjust their labels once real messages arrive.

## The corpus

`tests/fixtures/corpus.ts` builds 100 synthetic messages (50 Tier 1, 20
boutique and resale, 15 forwards, 10 long tail and wallet or calendar
attachments, 5 traps) with messy HTML, `&nbsp;`, names split across inline
markup, overnight and multi-day dates, and add-on fees. `tests/corpus.test.ts`
enforces the PRD gate: at least 92% exact structured extraction, at least 98%
surfacing, no output at all from the traps, and every quote verbatim.

This is an invariant and regression harness. The fixtures and the readers were
written together, so passing it does not predict recall on a real inbox. Add
anonymized real messages to measure that.

## Tests

    npm test
