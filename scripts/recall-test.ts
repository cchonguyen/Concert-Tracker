#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config();

import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { SCHEMA, SYSTEM, buildExtractionContents, createGeminiClient } from '../src/server/lineup/gemini.ts';
import { htmlToText } from '../src/server/lineup/text.ts';
import { thinkingConfigFor } from '../src/server/reader/geminiAdapter.ts';
import {
  BENCH_MODELS,
  BenchHttpError,
  benchJson,
  parseBenchArgs,
  parseWorkersAiEnvelope,
  redact,
  renderBenchMarkdown,
  reportsFor,
  passVerdict,
  runBenchmark,
  selectPages,
  toJsonSchema,
  workersAiErrorCode,
} from '../src/server/reader/recall.ts';
import type { BenchCaller, BenchEdition, BenchModelSpec, RawReply } from '../src/server/reader/recall.ts';

function printHelp() {
  console.log(`
Usage: npx tsx scripts/recall-test.ts [options]

Local recall benchmark. Read only: never writes to lineups or any database.
Runs gemini-3.5-flash-lite, gemini-4-hydrogen, gemini-flash-lite-latest (production, fallback price),
@cf/zai-org/glm-4.7-flash and @cf/google/gemma-4-26b-a4b-it at LOW reasoning over confirmed editions' stored source pages.

Input (one of):
  --fixture <path>      JSON: { "editions": BenchEdition[] } (see src/server/reader/recall.ts)
  (default)             Supabase, select only, tables: event_editions, performances,
                        lookup_jobs, performer_claims, source_documents

Options:
  --limit <n>           Pages to test (default 8: newest first, largest always included, one per edition)
  --window <chars>      Characters of page text shown to the model (default 180000)
  --max-calls <n>       Abort after this many model calls, retries included (default 40)
                        Gemini 503/UNAVAILABLE and Workers AI 5xx/timeouts retry up to 3 times; quota errors never retry.
  --max-usd <n>         Abort before a call that could pass this estimated spend (default 2)
  --max-output-tokens <n>  Output-token cap for every model (default 8192, same as production)
  --models <a,b>        Only these model ids
  --out-json <path>     Write the JSON result (default recall-result.json). It holds page-derived text:
                        each page's raw model reply (cut at 20000 chars, flagged), finishReason and thinking tokens.
                        The Markdown never holds raw replies. API keys are redacted from both.
  --out-md <path>       Write the Markdown result (default recall-result.md)

Env: GEMINI_API_KEY (Gemini models); CF_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI models);
     SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (only without --fixture).
`);
}

function loadFixture(path: string): BenchEdition[] {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const list = Array.isArray(data) ? data : data.editions;
  if (!Array.isArray(list)) throw new Error('Fixture must be an array of editions or { "editions": [...] }');
  return list as BenchEdition[];
}

// Select only. Confirmed editions, their performance names (the expected lineup), and the documents that
// stored performer claims point at (performer_claims.document_id, reached through lookup_jobs.edition_key).
async function loadFromSupabase(url: string, key: string): Promise<BenchEdition[]> {
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const ok = <T>(r: { data: T | null; error: { message: string } | null }, what: string): T => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`);
    return (r.data ?? []) as T;
  };
  const eds = ok(await db.from('event_editions').select('id, key, name, year, confirmed_at, updated_at').eq('status', 'confirmed').order('confirmed_at', { ascending: false }).limit(200), 'event_editions');
  const out: BenchEdition[] = [];
  for (const e of eds as any[]) {
    const perfs = ok(await db.from('performances').select('name, status').eq('edition_id', e.id).neq('status', 'cancelled'), 'performances') as any[];
    const jobs = ok(await db.from('lookup_jobs').select('id').eq('edition_key', e.key).limit(50), 'lookup_jobs') as any[];
    const jobIds = jobs.map((j) => j.id);
    const claims = jobIds.length ? (ok(await db.from('performer_claims').select('document_id').in('job_id', jobIds), 'performer_claims') as any[]) : [];
    const docIds = [...new Set(claims.map((c) => c.document_id as string))];
    const docs = docIds.length ? (ok(await db.from('source_documents').select('id, url, content_type, body').in('id', docIds), 'source_documents') as any[]) : [];
    out.push({
      key: e.key,
      name: e.name,
      year: e.year,
      date: e.confirmed_at ?? e.updated_at,
      expectedNames: perfs.map((p) => p.name),
      documents: docs.map((d) => ({ id: d.id, url: d.url, text: d.content_type === 'html' ? htmlToText(d.body) : d.body, hasLineup: true })),
    });
  }
  return out;
}

function geminiCaller(apiKey: string, model: string): BenchCaller {
  const client = createGeminiClient(apiKey, model);
  return async (page, { window, maxOutputTokens }): Promise<RawReply> => {
    const res = await client.generate({
      contents: buildExtractionContents({ eventName: page.eventName, year: page.year }, page.text, [], window),
      systemInstruction: SYSTEM,
      schema: SCHEMA,
      maxOutputTokens,
      thinkingConfig: thinkingConfigFor(model, 'LOW'),
    });
    return {
      text: res.text,
      truncated: res.finishReason === 'MAX_TOKENS',
      finishReason: res.finishReason ?? null,
      inputTokens: res.promptTokens,
      outputTokens: res.candidatesTokens === null && res.thoughtsTokens === null ? null : (res.candidatesTokens ?? 0) + (res.thoughtsTokens ?? 0),
      thinkingTokens: res.thoughtsTokens,
    };
  };
}

function workersAiCaller(accountId: string, token: string, model: string): BenchCaller {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
  return async (page, { window, maxOutputTokens }): Promise<RawReply> => {
    const body = {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildExtractionContents({ eventName: page.eventName, year: page.year }, page.text, [], window) },
      ],
      max_tokens: maxOutputTokens,
      reasoning_effort: 'low',
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: 'json_schema', json_schema: toJsonSchema(SCHEMA) },
    };
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    const raw = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(raw);
    } catch {
      /* non-JSON error body */
    }
    const failed = !res.ok || (json as { success?: boolean } | null)?.success === false;
    if (failed) {
      const errs = (json as { errors?: Array<{ message?: string }> } | null)?.errors;
      const message = errs?.map((e) => e.message).filter(Boolean).join('; ') || raw.slice(0, 300);
      throw new BenchHttpError(res.status, `HTTP ${res.status}: ${message}`, workersAiErrorCode(json, message));
    }
    return parseWorkersAiEnvelope(json);
  };
}

async function main() {
  const args = parseBenchArgs(process.argv.slice(2));
  if (args.help) return printHelp();

  const geminiKey = process.env.GEMINI_API_KEY;
  const cfAccount = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  const cfToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  const secrets = [geminiKey, cfToken, process.env.SUPABASE_SERVICE_ROLE_KEY];

  let editions: BenchEdition[];
  if (args.fixture) editions = loadFixture(args.fixture);
  else {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or pass --fixture <path>.');
    editions = await loadFromSupabase(url, key);
  }
  const pages = selectPages(editions, args.limit);
  if (pages.length === 0) throw new Error('No confirmed edition with a lineup document was found.');
  console.log(`Pages (${pages.length}):`);
  for (const p of pages) console.log(`  ${p.pageId}: ${p.text.length} chars, ${p.expectedNames.length} expected names`);

  const specs: BenchModelSpec[] = [];
  const skipped: string[] = [];
  for (const m of BENCH_MODELS) {
    if (args.models && !args.models.includes(m.model)) continue;
    if (m.provider === 'gemini') {
      if (!geminiKey) skipped.push(`${m.model}: GEMINI_API_KEY is not set`);
      else specs.push({ ...m, call: geminiCaller(geminiKey, m.model) });
    } else if (!cfAccount || !cfToken) skipped.push(`${m.model}: CF_ACCOUNT_ID or CLOUDFLARE_API_TOKEN is not set`);
    else specs.push({ ...m, call: workersAiCaller(cfAccount, cfToken, m.model) });
  }
  for (const s of skipped) console.log(`Skipped ${s}`);
  if (specs.length === 0) throw new Error('No model can run: set GEMINI_API_KEY and/or CF_ACCOUNT_ID with CLOUDFLARE_API_TOKEN.');

  const result = await runBenchmark(specs, pages, {
    window: args.window,
    maxCalls: args.maxCalls,
    maxUsd: args.maxUsd,
    maxOutputTokens: args.maxOutputTokens,
    secrets: secrets.filter((s): s is string => Boolean(s)),
    log: (line) => console.log(redact(line, secrets)),
  });

  console.log('');
  for (const r of reportsFor(result, pages)) {
    const v = passVerdict(r);
    const p = (x: number | null) => (x === null ? 'n/a' : (x * 100).toFixed(1) + '%');
    console.log(
      `${r.provider}:${r.model}  recall ${p(r.overallRecall)}  on page ${p(r.overallRecallOnPage)}  ` +
        `calls retried ${r.retriedCalls}  pages truncated ${r.truncatedPages}/${r.pageCount}  ` +
        `cost ${r.costUsd === null ? 'n/a' : '$' + r.costUsd.toFixed(4)}${r.priceIsFallback ? ' (fallback price)' : ''}  ${v.pass ? 'PASS' : 'FAIL'}`,
    );
  }
  console.log('Names missing from the page text are a ground-truth issue, not a model miss; the verdict uses recall on page.');
  for (const m of result.models) if (m.stopped) console.log(`${m.model} stopped (${m.stopped.kind}): ${m.stopped.message}`);
  if (result.aborted) console.log(`ABORTED: ${result.aborted}`);
  console.log(`Window used: ${args.window} characters. Max output tokens: ${result.maxOutputTokens}. Calls (retries included): ${result.calls}. Estimated spend: $${result.spentUsd.toFixed(4)}.`);

  const json = redact(JSON.stringify(benchJson(result, pages), null, 2), secrets);
  const md = redact(renderBenchMarkdown(result, pages), secrets);
  const jsonPath = args.outJson ?? 'recall-result.json';
  const mdPath = args.outMd ?? 'recall-result.md';
  writeFileSync(jsonPath, json);
  writeFileSync(mdPath, md);
  console.log(`Wrote ${jsonPath} and ${mdPath}.`);
}

main().catch((err) => {
  console.error(redact(err instanceof Error ? err.message : String(err), [process.env.GEMINI_API_KEY, process.env.CLOUDFLARE_API_TOKEN, process.env.CF_API_TOKEN, process.env.SUPABASE_SERVICE_ROLE_KEY]));
  process.exit(1);
});
