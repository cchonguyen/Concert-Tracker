# Quota and the queue

Part of [ARCHITECTURE.md](../../ARCHITECTURE.md).


- `QuotaLedger` (`src/server/lineup/quota.ts`) counts Gemini calls per model per Pacific day, against `GEMINI_DAILY_LIMIT` and `GEMINI_PER_MINUTE`. It refuses a call before it is made when the budget is spent.
- A Gemini 429 is parsed: a per-day quota parks the job until midnight Pacific; otherwise the job waits for the `retryDelay` Google returns (60 s if none).
- Parked jobs keep everything collected so far. Under Node, the worker (`LookupWorker` in `service.ts`) checks for due jobs every 20 seconds, one at a time. On Cloudflare a Cron Trigger sends due jobs to a Queue every minute and the queue consumer runs them one at a time (see Hosting). "Try now" in the UI retries immediately, past an earlier 429 pause but not past your own daily budget.
