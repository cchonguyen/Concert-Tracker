# Configuration

Part of [ARCHITECTURE.md](../../ARCHITECTURE.md).


See [`.env.example`](../../.env.example). Each source is optional; the app reports which ones are off and works with whatever is configured. `IMPORT_TOKEN` turns on posting ticket emails; it is a secret (`wrangler secret put IMPORT_TOKEN` on Cloudflare). `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` turn on Check email and Google Sheets sync (secrets too; Sheets also needs the Google Sheets API turned on in that Google Cloud project); `APP_URL` is the site's address, used for Google's redirect. `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` turn on the Worker's own Access token check (see Share page), and `/api` needs them (see Access gate, under Multi-user). `OWNER_EMAIL` is the one Access identity allowed in single-owner mode; it is needed only while `MULTI_USER` is not `on`. `MULTI_USER=on` (with those two, `SUPABASE_ANON_KEY` and `SUPABASE_JWT_SECRET`) turns on members (see Multi-user); half set is closed (503). `GEMINI_USER_DAILY` and `GEMINI_OWNER_RESERVE` set per-member limits.
