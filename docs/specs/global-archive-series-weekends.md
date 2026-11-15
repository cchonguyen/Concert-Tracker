# Global Archive: Series, Multi-Weekend Editions & Egress Optimization

Approved design specification (2026-11-15; see `DECISIONS.md` ADR-005 and `.spec/SYSTEM_SPEC.md` section 3).

---

## 1. 4-Tier Event Hierarchy & Schema

Events in the canonical catalog follow a four-tier hierarchy:

```
Brand (optional grouping text on series, e.g. "Insomniac" or "Coachella")
  └── Series (`event_series`: recurring festival/tour across years, e.g. "EDC Las Vegas")
        └── Edition (`event_editions`: one canonical occurrence, with optional `weekends[]`)
              └── Event / Weekend (`logged_events`: a member's log entry + optional `weekend` 1..9)
```

### Nullable `series_slug`
- `event_editions.series_slug` is **nullable** (`text null references event_series(slug) on delete set null`).
- Standalone concerts and one-off shows have `series_slug = null` and do **not** generate stub `event_series` rows.
- In TypeScript (`EventEdition`, `EditionHeader`, `NewEditionInput`), `seriesSlug` is `string | null | undefined`.

### Tables & Columns
- **`event_series`**:
  - `slug` (`text` primary key)
  - `name` (`text not null`)
  - `brand` (`text null`) — optional parent brand/promoter label
  - `aliases` (`text[] not null default '{}'`) — alternate names/abbreviations matched during suggestions and disambiguation
  - `city` (`text null`), `region` (`text null`), `country` (`text null`)
  - `created_at`, `updated_at`
- **`event_editions`**:
  - `series_slug` (`text null references event_series(slug) on delete set null`)
  - `region` (`text null`) — state or province alongside `city` and `country`
  - `weekends` (`jsonb null default '[]'::jsonb`) — array of `EditionWeekend` entries for multi-weekend festivals/runs

### Core TypeScript Contracts

```typescript
export interface EditionWeekend {
  weekendNumber: number; // 1-based index (e.g. 1 for Weekend 1)
  name?: string;         // Optional label, e.g. "Weekend 1" or "Spring Edition"
  startDate: string;     // ISO date YYYY-MM-DD
  endDate: string;       // ISO date YYYY-MM-DD
  ticketTypes?: string[]; // e.g. ["GA", "VIP"]
  lineupActs?: string[];  // acts specific to this weekend if split
}

export interface EditionHeader {
  id: string;
  title: string;
  seriesSlug?: string | null;
  brand?: string | null;
  editionType?: 'festival' | 'concert' | 'tour';
  startDate?: string | null;
  endDate?: string | null;
  venue?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  actCount: number;
  weekends?: EditionWeekend[];
  status?: 'draft' | 'provisional' | 'verified';
}

export interface SeriesSummary {
  slug: string;
  name: string;
  brand?: string | null;
  aliases?: string[];
  city?: string | null;
  region?: string | null;
  country?: string | null;
  editionCount: number;
}
```

---

## 2. Global Archive Management (Owner Only)

### Canonical Series Management
Mounted under `/api/manage/canonical/series*`:
- **Create** (`POST /api/manage/canonical/series`): create a canonical `event_series` record with `name`, optional `brand`, `aliases`, `city`, `region`, and `country`.
- **Edit** (`PATCH /api/manage/canonical/series/:slug`): update `name`, `brand`, `aliases`, and place fields on the canonical series.
- **Merge** (`POST /api/manage/canonical/series/:slug/merge` via `merge_canonical_series`): merge a source series into a target series, re-pointing all attached `event_editions.series_slug` to the target and absorbing the source's name and aliases into the target's `aliases`.
- **Attach / Detach on Editions**: assign `event_editions.series_slug` to link an edition to a series, or set it to `null` to detach a standalone edition without deleting the series.

### Canonical Edition Merging (`mergeCanonicalEditions`)
Mounted at `POST /api/manage/canonical/editions/:id/merge`:
- Merges a duplicate edition into a kept canonical edition, moving performances (deduplicated), external IDs, lookup jobs, review rows, and `logged_events.edition_id` references.
- **Optional "Combine dates into Weekend 1 & Weekend 2" mode**:
  - When two duplicate editions represent separate weekends of the same festival edition (e.g. Weekend 1 and Weekend 2), merging builds/updates `weekends` (`EditionWeekend[]`) on the kept edition with each weekend's `weekendNumber`, `startDate`, and `endDate`.
  - Preserves each member's `logged_events.weekend` (setting or keeping `1`, `2`, etc. based on the edition they had linked) so personal attendance records stay accurate without manual cleanup.

---

## 3. Capture, Stage 1 Inheritance & Event Detail

### Deterministic Weekend Parsing (`src/server/events/parse.ts`)
- Extracts explicit weekend tokens (`weekend N`, `wknd N`, `WN`, case-insensitive, 1–9) deterministically in code without a model call.
- **Preservation rules**:
  - Artist and event names containing the word `"Weekend"` (e.g. `"Vampire Weekend"`, `"The Weeknd"`) are never stripped or misread as a weekend number.
  - Bare or ambiguous tokens (such as a literal `"W2"` inside a title when not acting as an explicit weekend marker, or text the parser cannot cleanly place) remain preserved so typed titles are never corrupted.

### Canonical Edition Suggestions (`suggestEditions`)
- Matches across edition `name`, attached series `name`, `brand`, and `aliases` using normalized word-prefix matching (no fuzzy/LLM scoring).
- **Multi-weekend re-selection**: editions with multiple `weekends` remain selectable/re-selectable in suggestions even if the caller already logged another weekend of the same edition, allowing someone who attended both Weekend 1 and Weekend 2 to link both events to the same canonical edition with distinct `weekend` numbers.

### Option 3B Fast-Enter Auto-Link vs. Multi-Match Disambiguation
When the user submits the capture line by pressing Enter without tapping a dropdown suggestion:
1. Run the pure normalized matcher against verified series editions.
2. **Exactly 1 unambiguous match** (title/series match, typed date falls within the edition's dates or one of its `weekends`, and venue/city matches or is empty in the typed input, with no conflicts):
   - **Auto-link immediately** (`logged_events.edition_id = edition.id`, plus `weekend` set if a specific weekend matched).
   - Apply canonical inheritance (see below) and skip Stage 1 web research.
3. **2 or more matches** (e.g. multi-weekend W1 vs. W2 with no weekend specified, or multi-city editions sharing a series name):
   - **Do NOT auto-link.**
   - Surface the matching canonical editions as 1-tap disambiguation candidates under the capture bar.
   - Provide an explicit escape hatch: **`"None of these — search web / keep mine"`**, which saves/keeps the user's typed entry and proceeds with normal Stage 1 handling.
4. **0 matches**: proceed with standard Stage 1 capture and research without linking.

### Inheritance & Personal Overrides
When an event links to a canonical edition:
- Pre-fills **`series`** (from the attached `event_series.name`, when `series_slug` is set), **`region`** / `country`, **`venue`**, **`city`**, and **`weekends`**:
  - Single-weekend edition (or multi-weekend with a weekend token typed/picked): populates that weekend's `startDate` and `endDate` (sourced `{ sourceType: 'edition', editionId }`).
  - Multi-weekend edition with no weekend chosen yet: leaves `startDate`/`endDate` empty so dates are never guessed.
- **Personal overrides stay local**: editing `series`, dates, or any field on `logged_events` overrides only your personal log entry and never mutates `event_series` or `event_editions`.

### Event Detail `"Which weekend did you go?"` Soft-Prompt
- When a linked event points to a multi-weekend canonical edition and has no `weekend` (or unresolved dates), Event Detail displays a non-blocking soft-prompt: **`"Which weekend did you go?"`** listing each `EditionWeekend` as a 1-tap choice (which sets `weekend` and fills that weekend's `startDate`/`endDate`).
- Includes an **`"Other dates"`** escape hatch so the member can dismiss the prompt and enter custom dates directly.

---

## 4. Egress Optimization Architecture

To stay well within Supabase free-tier egress and Cloudflare Worker subrequest limits:

- **`getEditionHeaders(filter?)`** (`LineupStore`): returns lean `EditionHeader[]` rows (`seriesSlug`, `brand`, `region`, `weekends`, `actCount`, dates, venue, city, status) without loading full act lists, set times, or source quotes.
- **`edition_lineup_facts(p_edition_id uuid)` SQL RPC**: database function returning unified JSON `{ edition: EditionHeader, acts: PerformanceFact[] }` in a single query/subrequest, eliminating N+1 fetches during event inspection and Global Archive edition detail views.
- **`listEditionHeaders(query)`**: replaces full-table edition scans in `src/server/events/match.ts` (and `src/server/canon/match.ts`) and `dedupeProvisional.ts`.
- **Lean `listEditionArtistRefs`**: fetches minimal `(edition_id, artist_key)` reference pairs instead of full `performances` rows when checking artist links across editions.
- **Debounced archive search**: client requests to `/api/editions/suggest` and Global Archive search debounce user typing by at least **300ms**.
- **Lazy-loaded artists list**: Global Archive does not eagerly fetch the full canonical artists catalog on tab mount; the artists list loads only when the Artists section is opened or searched.
