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

Built: query strings, HTML-to-lines, the weekday year rule, the verbatim
check, the `.pkpass` reader, the nine seller layout readers (Ticketmaster, Live
Nation, Tixr, DICE, Resident Advisor, Eventbrite, AXS, Front Gate, TicketWeb),
the forwarded-email unwrapper, the Layer 4 verbatim reader for other senders,
and `readRawEmails(RawEmailMessage[]) -> EmailImportProposal[]`.

Not yet built:

- Dedicated readers for the 15 boutique and resale sellers. Mail from them goes
  through the Layer 4 reader until real samples exist to write layouts from.
- `.pkpass` and schema.org results are not yet fed into `readRawEmails`
  (`readPkpass` exists on its own).
- The 100-message golden corpus. `tests/corpus/fixtures.ts` holds 10 synthetic
  show emails and 5 non-show traps, so the 92% / 0% false-positive gate runs
  but proves little until real, anonymized mail is added.

The host app still reads email with its own copy under
`src/server/events/email/`; nothing imports this package yet. Both copies must
be kept in step until the host switches over.

## Tests

    npm test
