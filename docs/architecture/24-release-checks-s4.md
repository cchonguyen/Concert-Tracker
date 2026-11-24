# Release checks (S4)

Part of [ARCHITECTURE.md](../../ARCHITECTURE.md).


Checked before turning on the share link and Access for a release. Nothing here adds code; each item names the setting or file that already does the work.

- **Access bypass for `/s/*`**: the Cloudflare Access application covers `/app`, `/app.html` and `/api/*`, and its bypass policy covers `/s/*` only. Set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (wrangler.jsonc vars and Access application audience) before creating the bypass. Without both, the Worker's second lock is off.
- **Rate limiting**: the Worker has no rate-limit binding. Add a Cloudflare rate-limit rule on the base hostname for `/s/*` (for example, 60 requests per minute per IP), and one on `/api/access-requests` POST. Until then, the one-request-per-email rule and the request cap are the only bounds (see Multi-user).
- **Injection**: "injection-off" means the share page never runs or embeds injected content. The page is plain HTML with inline styles, a CSP of `default-src 'none'`, and escaped values (`src/server/share/page.ts`). No environment switch controls this; the rule is enforced by the code and its tests. Gemini reading of fetched page text is unchanged and is guarded by the quote and verbatim checks (AGENTS.md).
- **Migrations**: the share page needs migration 0015 (`share_links`) applied. Every migration a release depends on must be applied by the owner first; the next free number is the one after the highest file in `supabase/migrations/`.
- **Checks**: `npm run lint` and `npm test` pass on the release commit.
