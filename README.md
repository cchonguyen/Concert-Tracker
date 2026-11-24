# LiveArchive (`Concert-Tracker`)

LiveArchive is a personal concert and festival log that helps you remember which events you went to and who you saw there. It reads dates, venues, and lineups from primary sources with quoted spans and never guesses or fabricates missing data.

## Documentation

- [REQUIREMENTS.md](REQUIREMENTS.md) — What the app is for and the core principles that govern every feature.
- [ARCHITECTURE.md](ARCHITECTURE.md) — System architecture, data model, two-stage capture, lineup lookup pipeline, and multi-user isolation.
- [AGENTS.md](AGENTS.md) — Engineering and contributor rules.
- [docs/README.md](docs/README.md) — Index of design specifications and architecture sections.

## Local Development

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy [`.env.example`](.env.example) to `.env` and configure any optional API keys (`GEMINI_API_KEY`, `TICKETMASTER_API_KEY`, `SETLISTFM_API_KEY`, `BRAVE_SEARCH_API_KEY`, or `LOCAL_DEV_OWNER="on"` for local development). Without Supabase configured, the server uses a local file store under `./data`.
3. Start the local development server:
   ```bash
   npm run dev
   ```
4. Run lint and unit tests:
   ```bash
   npm run lint
   npm test
   ```

## License

All Rights Reserved — Copyright (c) 2026 Charlie Cho Nguyen. See [LICENSE](LICENSE).
