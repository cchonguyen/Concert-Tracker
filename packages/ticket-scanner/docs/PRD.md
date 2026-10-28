# Open-Source Ticket Email Scanner (`@livearchive/ticket-scanner`) PRD & Architecture Specification

**Document Status:** Final Draft for Open-Source Release & Security Audit  
**Date:** October 28, 2026  
**Owner:** Charlie  
**Package Name:** `@livearchive/ticket-scanner`  
**License:** MIT (Permissive Open Source)  
**Target Recall:** $\ge 92\%$ structured extraction across primary, boutique, resale, and forwarded ticket emails; $\ge 98\%$ total surfacing (including `unreadable` fallback links)  
**Runtime Environments:** Pure TypeScript / Web-Standard ES Module (runs in Web Browser RAM, Chrome/Firefox WebExtension, Cloudflare Email Worker, and Node.js CLI)

---

## 1. Purpose & Open-Source Trust Philosophy

Ticket confirmation emails are the richest, most accurate record of a music lover's concert history—containing exact event dates, venues, cities, order numbers, and per-ticket prices going back 10 to 15 years. However, asking users to grant a remote server permanent read access to their email inbox creates an unacceptable security and privacy hazard.

**`@livearchive/ticket-scanner`** solves this by decoupling ticket email scanning into a **standalone, 100% open-source, zero-server-storage application and library**.

### Core Trust Guarantees (Verifiable in Code)
1. **Local-Only Execution:** When run in the LiveArchive Web App or Browser Extension, raw email messages are fetched directly from Gmail into the user's browser memory (RAM), parsed into structured concert proposals, and **immediately garbage-collected**. Raw email bodies, non-ticket emails, and OAuth tokens are **never transmitted to or stored on any server**.
2. **Ephemeral 60-Minute Permissions:** Access tokens exist only ephemerally in browser memory, expire within 60 minutes, and are explicitly revoked via the OAuth revocation endpoint immediately upon scan completion. The web scanner uses Google Identity Services' Implicit Token model (no refresh token).
3. **No Claim Without Verbatim Evidence:** Every extracted field (`name`, `date`, `venue`, `city`, `ticketPrice`) must carry the exact character-for-character substring (`quote`) from the email text (`isVerbatim`), plus a direct link (`messageLink`) back to the user's email so the user can verify it in one click.
4. **Incremental Watermark Cursors:** The scanner tracks per-query watermarks (`scannedThrough` timestamps and seen message IDs) so subsequent scans only read new emails arrived since the last check (plus a 1-day lookback buffer for late deliveries).

---

## 2. Three Deployment Modes (One Shared Engine)

Because `@livearchive/ticket-scanner` is written in pure, dependency-free TypeScript using Web Standard APIs (`fetch`, `DOMParser` / `htmlToLines`, `DecompressionStream` for `.pkpass`), the exact same core powers three user experiences:

```
                  ┌────────────────────────────────────────────┐
                  │   @livearchive/ticket-scanner (Core SDK)   │
                  │  • Layer 1: Semantic + Seller Query Builder │
                  │  • Layer 2: Schema.org & .pkpass Extractor  │
                  │  • Layer 3: 24+ Deterministic Layout Readers│
                  │  • Layer 4: Verbatim Heuristic Extractor    │
                  └──────┬───────────────┬──────────────┬──────┘
                         │               │              │
         ┌───────────────┘               │              └───────────────┐
         ▼                               ▼                              ▼
[ Mode A: Web App Ephemeral ]   [ Mode B: Browser Extension ]  [ Mode C: Inbound Email Worker ]
1-click Google popup in app;    Reads open Gmail/Yahoo/Outlook Parses single emails forwarded
scans 10 yrs in browser RAM;    or Ticketmaster/DICE tabs  to `tickets+<token>@concert...`
posts proposals to server.      with zero OAuth setup.         and discards raw message.
```

---

## 3. The 4-Layer "95% Catch Rate" Extraction Architecture

To surpass the **90% catch-rate bar** across diverse music fans (catching not just the "Big 9" vendors, but forwarded emails from friends, boutique electronic/indie platforms, resale marketplaces, and local box offices), the scanner processes messages through a 4-Layer Funnel:

### Layer 1: The High-Recall Inbox Query Net (`src/queries.ts`)
Instead of relying solely on `from:` domains (which misses forwarded emails whose sender changed, or boutique platforms), the scanner executes two coordinated query streams with independent watermarks:

1. **Stream A — Known Seller & Marketplace Sweep (24 Curated Domains):**
   * *Tier 1 Primary (Existing 9):* `ticketmaster.com`, `livenation.com`, `axs.com`, `dice.fm`, `eventbrite.com`, `tixr.com`, `residentadvisor.net` (`ra.co`), `frontgatetickets.com`, `ticketweb.com`.
   * *Tier 2 Boutique & Indie (10 Added):* `seetickets.us` (`seetickets.com`), `shotgun.live`, `posh.vip`, `etix.com`, `universe.com`, `showclix.com`, `prekindle.com`, `venuepilot.com`, `seated.com`, `feverup.com`.
   * *Tier 3 Verified Resale (5 Added):* `stubhub.com`, `seatgeek.com`, `vividseats.com`, `tickpick.com`, `cashortrade.org`.
   * Query string:
     ```text
     from:(ticketmaster.com OR livenation.com OR axs.com OR dice.fm OR eventbrite.com OR tixr.com OR residentadvisor.net OR frontgatetickets.com OR ticketweb.com OR seetickets.us OR seetickets.com OR shotgun.live OR posh.vip OR etix.com OR universe.com OR showclix.com OR prekindle.com OR venuepilot.com OR seated.com OR feverup.com OR stubhub.com OR seatgeek.com OR vividseats.com OR tickpick.com OR cashortrade.org)
     ```
2. **Stream B — Universal Semantic & Forwarded Ticket Sweep:**
   Catches forwarded tickets (regardless of whether the original `.com` domain survived in the body), Apple Wallet pass emails, and independent venue box offices. Exclusions wrap the whole query, so `filename:pkpass` cannot admit boarding passes or movie tickets. The reader also rejects any `.pkpass` whose `pass.json` lacks `eventTicket` (see `src/markup.ts`).
   ```text
   -cinema -movie -fandango -airline -flight -"boarding pass" ((subject:(ticket OR tickets OR "order confirmation" OR "your order" OR "e-ticket" OR guestlist OR rsvp OR wristband) AND (venue OR doors OR "general admission" OR section OR barcodes OR "will call" OR "presented by" OR lineup OR admission)) OR filename:pkpass)
   ```

---

### Layer 2: Embedded Machine Markup & Wallet Pass Extractor (`src/markup.ts`)
Before running layout-specific text parsers, the scanner inspects the raw email payload for structured machine metadata that ticketing platforms embed for Gmail/Apple Wallet:

1. **JSON-LD & Microdata (`schema.org/EventReservation` & `FoodEstablishmentReservation`):**
   * Parses `<script type="application/ld+json">` and HTML `itemtype="http://schema.org/EventReservation"` blocks inside the email HTML.
   * Extracts `reservationFor.name`, `reservationFor.startDate` (full ISO-8601 timestamp with year!), `reservationFor.endDate`, `reservationFor.location.name` (Venue), `reservationFor.location.address` (City, Region, Country), `reservationNumber`, `underName`, and `reservationStatus` (detecting cancelled/refunded orders automatically).
2. **Apple Wallet Pass (`.pkpass`) & iCalendar (`.ics`) Attachments:**
   * If an email includes a `.pkpass` attachment (used by DICE, Eventbrite, See Tickets, Shotgun, Posh, AXS, Universe, Etix), the scanner unzips `pass.json` in memory and reads `eventTicket` fields (`primaryFields`, `secondaryFields`, `auxiliaryFields`, `relevantDate`, `locations`) alongside any attached `.ics` (`SUMMARY`, `DTSTART`, `LOCATION`).
3. **Cross-Layer Enrichment:** Even when Layer 2 provides the exact Event Name, ISO Date, Venue, and City, the message still passes through Layer 3 or Layer 4 to extract the **per-ticket price (`ticketPrice`) and verbatim text quotes** from the visible email body.

---

### Layer 3: Multi-Client Forward Unwrapper & Deterministic Seller Readers (`src/forwarded.ts`, `src/readers/`)
1. **Upgraded Forwarded-Email Unwrapper (`src/forwarded.ts`):**
   * Detects and unwraps nested forward headers across **Gmail** (`"---------- Forwarded message ---------"`), **Apple Mail / iOS** (`"Begin forwarded message:"`), **Outlook** (`"-----Original Message-----"` or `"From: ... Sent: ... To: ... Subject:"`), and **Yahoo Mail**.
   * Extracts the innermost `originalSentAt` date so yearless dates (`"Sat Aug 29, 10:00 PM"`) are resolved relative to when the ticket was originally bought, not when the friend forwarded it.
   * Identifies the original seller by domain (`@ticketmaster.com`), or—when mobile mail clients strip the email address—by **Sender Display Name + Layout Fingerprint** (e.g., `From: Ticketmaster`, `From: AXS Guest Services`, `From: DICE`).
2. **Deterministic Seller Readers (`src/readers/*.ts`):**
   * Dedicated, zero-AI layout readers for all Tier 1, Tier 2, and Tier 3 sellers.
   * Strips ticket-tier suffixes (`withoutTicketType`: `" - 3-Day GA Experience Pass"`, `" - Artist Presale"`, `" - Tier 2"`, `" - VIP"`).
   * Computes `ticketPrice` by dividing the order total (fees included, USD) by the ticket count when explicitly stated on a single ticket line (excluding parking/shuttle add-ons).
   * Detects refunds, cancellations, and outbound ticket transfers, emitting `status: 'flag'` rows that attach to the corresponding order.

---

### Layer 4: Universal Verbatim Ticket Reader for Long-Tail Venues (`src/verbatimReader.ts`)
When an email matched by Stream B comes from an independent venue box office or regional promoter with no `schema.org` markup and no dedicated seller reader:

1. **Promo/Newsletter Gate (Zero False Positives):**
   * Rejects the email immediately if it lacks an order/confirmation anchor (`Order #`, `Confirmation #`, `Receipt`, `Ticket #`, `Qty`, `Total Paid`, `You're going to`, `Your tickets for`) or contains marketing unsubscribe footprints without a transaction marker.
2. **Labeled Block & Verbatim Extraction:**
   * Scans `htmlToLines(html)` for labeled key-value blocks (`Event:`, `Show:`, `Artist:`, `Date:`, `When:`, `Doors:`, `Venue:`, `Where:`, `Location:`, `Total:`, `Tickets:`) and headline patterns (`"Your tickets for <Event> at <Venue>"`).
   * Resolves dates with the vendored weekday-year congruence rule (`src/dates.ts`, a copy of LiveArchive's `email/dates.ts`, so the package has no host dependency).
   * **Strict `isVerbatim` Enforcement:** Every extracted value is rejected unless its `quote` is a character-for-character substring of `htmlToLines(html)` and the parsed value is contained within that quote.
3. **Graceful `unreadable` Fallback:**
   * If an email clearly has a ticket confirmation subject (`hasTicketSubject`) but fails structured date/name extraction, it is emitted with `status: 'unreadable'` and a direct `messageLink` to the email so the user never silently loses a show.

---

## 4. Data Contracts & Public SDK Interface

```typescript
export interface RawEmailMessage {
  id: string;
  threadId?: string;
  link: string;         // e.g., "https://mail.google.com/mail/u/0/#inbox/<id>"
  from: string;
  to?: string;
  subject: string;
  sentAt: string;       // ISO-8601 timestamp
  html?: string;
  text?: string;
  attachments?: Array<{
    filename: string;
    mimeType: string;
    dataBase64: string; // Used only for .pkpass / .ics in-memory parsing
  }>;
}

export interface FieldEvidence {
  value: string;
  quote: string;        // Verbatim substring from email lines or schema.org JSON
  messageId: string;
  messageLink: string;
  readBy: 'layout' | 'schema_org' | 'pkpass' | 'verbatim_heuristic';
}

export interface EmailImportProposal {
  key: string;          // Normalized "<name>|<startDate>" or "<seller>|<orderNumber>"
  status: 'new' | 'flag' | 'unreadable';
  seller: string;       // e.g., "ticketmaster", "dice", "shotgun", "forwarded:axs", "indie"
  orderNumber?: string;
  name?: FieldEvidence;
  date?: FieldEvidence; // YYYY-MM-DD
  endDate?: FieldEvidence;
  venue?: FieldEvidence;
  city?: FieldEvidence;
  region?: FieldEvidence;
  country?: FieldEvidence;
  ticketPrice?: {
    amount: number;     // Per-ticket USD price (total / count)
    total: number;
    count: number;
    quote: string;      // e.g., "$124.50 for 2 tickets"
    messageLink: string;
  };
  flags: Array<{
    kind: 'refunded' | 'cancelled' | 'transferred';
    quote: string;
    messageLink: string;
    sentAt: string;
  }>;
  rawSubject?: string;  // Kept on 'unreadable' rows so user can identify the email
  messageLinks: string[];
}
```

---

## 5. User Experience Flows

### Flow 1: 1-Click Ephemeral Historical Scan in the Web App
1. User clicks **"Scan Gmail for Tickets"** in LiveArchive.
2. A transparent privacy card explains: *"Scanning happens 100% inside your browser. LiveArchive never stores your Gmail login and never uploads your raw emails."*
3. User approves the 1-hour Google popup (`gmail.readonly` implicit token kept strictly in a local JS closure variable).
4. The browser executes Stream A and Stream B queries against `https://gmail.googleapis.com/gmail/v1/users/me/messages`, fetching messages in parallel batches of 10 with automatic exponential backoff on `429`.
5. A live progress bar displays: *"Scanned 140 of 210 ticket emails... Found 78 concerts (6 forwarded, 4 refunded)."*
6. Once complete, the browser posts only the `EmailImportProposal[]` array and updated `email_scan_cursors` to `POST /api/imports/proposals`, then revokes the temporary token (`google.accounts.oauth2.revoke`).

### Flow 2: Companion Open-Source Browser Extension
1. For users who prefer zero Google OAuth popups (or use Yahoo/Outlook/iCloud Mail), the standalone Browser Extension runs the exact same `@livearchive/ticket-scanner` package.
2. Plus, when a user visits their **"My Tickets / Past Events"** page on `ticketmaster.com`, `dice.fm`, or `eventbrite.com`, the extension can optionally read their past ticket history directly from the rendered page DOM and send the proposals to LiveArchive. AXS is not scraped in any mode: AXS tickets come only from purchase confirmations and "You Received Tickets" transfer emails.

---

## 6. Validation Benchmark & Test Suite Requirements

To guarantee the **$\ge 90\%$ catch rate** requirement before release, the repository includes an anonymized **Golden Corpus Benchmark (`tests/corpus/`)**:
* **100 Real-World Ticket Fixtures** covering:
  * 50 Tier-1 seller confirmations (Ticketmaster, Live Nation, AXS, DICE, Eventbrite, Tixr, RA, Front Gate, TicketWeb across 2014–2026 layouts).
  * 20 Tier-2/Tier-3 boutique & resale confirmations (See Tickets, Shotgun, Posh, Etix, Universe, Fever, StubHub, SeatGeek, TickPick).
  * 15 Forwarded emails across Gmail, iPhone Mail, Outlook, and Yahoo (including stripped sender addresses and multi-hop forwards).
  * 10 Long-tail indie venue confirmations and `.pkpass` attachments.
  * 5 Non-ticket false-positive traps (marketing newsletters, presale announcements, flight boarding passes, movie tickets, parking-only receipts).
* **CI Gate:** `npm test` in `@livearchive/ticket-scanner` must achieve:
  * **$\ge 92\%$ exact structured extraction** on the 95 concert fixtures.
  * **$\ge 98\%$ total surfacing** (structured + `unreadable` fallback with link).
  * **$0\%$ false positives** on the 5 non-concert traps.
  * **$100\%$ `isVerbatim` quote compliance** on every extracted field.