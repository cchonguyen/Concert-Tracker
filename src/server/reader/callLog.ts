import type { AiCallRow, LineupStore } from '../lineup/store/types';
import { hasReaderRpc, takePendingSettle } from './guard';

// One insert per call. Counts and sizes only: never page text, prompts, quotes or names.
// A failed write never fails the read; it is counted under reader:logfail:<YYYY-MM-DD> (best effort).
//
// Supabase store: the row goes out inside reader_settle together with the ledger update that recordOutcome
// parked for this call (one request; 0040_reader_rpcs.sql). A refused call has no parked update, so the
// same function writes the row alone. Other stores keep the single addAiCall insert.
export async function logCall(store: LineupStore, row: AiCallRow, now: Date = new Date()): Promise<void> {
  try {
    if (hasReaderRpc(store)) {
      const pending = takePendingSettle(now);
      await store.readerSettle({ record_ledger: false, ...pending, row: rowPayload(row) });
    } else {
      await store.addAiCall(row);
    }
    return;
  } catch {
    console.warn('ai call log write failed');
  }
  try {
    const key = `reader:logfail:${now.toISOString().slice(0, 10)}`;
    const cur = (await store.getQuota(key)) ?? { key, used: 0 };
    await store.setQuota({ ...cur, used: cur.used + 1 });
  } catch {
    // best effort
  }
}

// Explicit column list: only these counts, sizes and ids can ever leave for the database.
function rowPayload(r: AiCallRow): Record<string, unknown> {
  return {
    id: r.id,
    created_at: r.createdAt,
    feature: r.feature,
    job_id: r.jobId,
    event_id: r.eventId,
    user_id: r.userId,
    provider: r.provider,
    model: r.model,
    source_document_id: r.sourceDocumentId,
    input_chars: r.inputChars,
    input_tokens: r.inputTokens,
    output_tokens: r.outputTokens,
    est_cost_usd: r.estCostUsd,
    duration_ms: r.durationMs,
    outcome: r.outcome,
    error_code: r.errorCode,
    guard_reason: r.guardReason,
    names_returned: r.namesReturned,
    names_verbatim: r.namesVerbatim,
    names_rejected: r.namesRejected,
  };
}
