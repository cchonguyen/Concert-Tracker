#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config();

import { randomUUID } from 'node:crypto';
import { createStore, createDeps } from '../src/server/lineup/service.ts';
import { runJob, validateInput } from '../src/server/lineup/pipeline.ts';
import { confirmLookup } from '../src/server/lineup/learning.ts';
import { cityWithRegion } from '../src/server/events/regions.ts';
import type { LoggedEvent } from '../src/server/events/types.ts';
import type { LookupJob, Edition } from '../src/server/lineup/types.ts';

function printHelp() {
  console.log(`
Usage: npx tsx scripts/recheck-lineups.ts [options]

Operator-only tool to re-run Stage 2 lineup lookups using the updated lineup pipeline,
bypassing the confirmed edition cache for comparison.

Options:
  --event <name>        Filter event by name (case-insensitive substring)
  --id <uuid>           Target a specific event by its ID
  --all-confirmed       Evaluate all events that currently have a confirmed lineup
  --all                 Evaluate all events regardless of lineup status
  --limit <n>           Maximum number of events to process (default: 1)
  --apply               Apply and confirm the new lineup to the event (default: dry run)
  --help                Show this help message

Examples:
  npx tsx scripts/recheck-lineups.ts --event "Portola"
  npx tsx scripts/recheck-lineups.ts --event "Coachella" --apply
  npx tsx scripts/recheck-lineups.ts --all-confirmed --limit 3
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    eventQuery: '',
    eventId: '',
    allConfirmed: false,
    all: false,
    limit: 1,
    apply: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--apply') opts.apply = true;
    else if (arg === '--all-confirmed') opts.allConfirmed = true;
    else if (arg === '--all') opts.all = true;
    else if (arg === '--event' && i + 1 < args.length) opts.eventQuery = args[++i];
    else if (arg === '--id' && i + 1 < args.length) opts.eventId = args[++i];
    else if (arg === '--limit' && i + 1 < args.length) opts.limit = parseInt(args[++i], 10) || 1;
  }
  return opts;
}

async function main() {
  const opts = parseArgs();
  if (opts.help) {
    printHelp();
    return;
  }

  const store = await createStore();
  const deps = createDeps(store);
  const allEvents = await store.listEvents();

  let targets: LoggedEvent[] = [];

  if (opts.eventId) {
    targets = allEvents.filter((e) => e.id === opts.eventId);
    if (!targets.length) {
      console.error(`Error: Event with ID "${opts.eventId}" not found.`);
      process.exit(1);
    }
  } else if (opts.eventQuery) {
    const q = opts.eventQuery.toLowerCase();
    targets = allEvents.filter((e) => e.name.toLowerCase().includes(q));
    if (!targets.length) {
      console.error(`Error: No events matching query "${opts.eventQuery}" found.`);
      process.exit(1);
    }
  } else if (opts.allConfirmed) {
    targets = allEvents.filter((e) => Boolean(e.editionId));
  } else if (opts.all) {
    targets = allEvents;
  } else {
    // Default: find first festival or event with an edition
    targets = allEvents.filter((e) => Boolean(e.editionId));
    if (!targets.length) targets = allEvents.slice(0, 1);
  }

  targets = targets.slice(0, opts.limit);

  console.log(`\n=============================================================`);
  console.log(`  LiveArchive Lineup Recheck & Comparison Tool (Operator Only)`);
  console.log(`  Mode: ${opts.apply ? '⚡ LIVE APPLY (Updates DB)' : '🔍 DRY RUN (Read-only)'}`);
  console.log(`  Selected events: ${targets.length}`);
  console.log(`=============================================================\n`);

  for (let i = 0; i < targets.length; i++) {
    const event = targets[i];
    const year = event.year ?? (event.startDate ? Number(event.startDate.slice(0, 4)) : undefined);

    if (!year) {
      console.log(`[${i + 1}/${targets.length}] Skipping "${event.name}" (no year/date).`);
      continue;
    }

    console.log(`[${i + 1}/${targets.length}] Analyzing "${event.name}" (${event.startDate ?? year})`);
    if (event.venue || event.city) {
      console.log(`     Location: ${[event.venue, event.city].filter(Boolean).join(', ')}`);
    }

    // 1. Fetch current confirmed edition if available
    let existingEdition: Edition | null = null;
    if (event.editionId) {
      existingEdition = await store.getEdition(event.editionId);
    }

    const prevActs = existingEdition?.performances?.map((p) => p.name) ?? [];
    console.log(`     Previous Lineup: ${existingEdition ? `${prevActs.length} act(s) (Edition ID: ${existingEdition.id})` : 'None (unconfirmed)'}`);

    // 2. Prepare ephemeral dry-run job bypassing findConfirmedEdition
    const input = validateInput({
      eventName: event.name,
      year,
      startDate: event.startDate,
      endDate: event.endDate,
      venue: event.venue,
      city: cityWithRegion(event.city, event.region),
      country: event.country,
    });

    const ephemeralEditionKey = `operator-recheck/${event.name.replace(/\//g, '-')}/${year}/${randomUUID().slice(0, 8)}`;
    const nowIso = new Date().toISOString();

    const dryRunJob: LookupJob = {
      id: randomUUID(),
      kind: 'lineup',
      input,
      editionKey: ephemeralEditionKey,
      status: 'queued',
      stage: 'collect',
      attempts: 0,
      pendingExtraction: [],
      discoveryDone: false,
      facts: {},
      eventId: event.id,
      log: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    await store.createJob(dryRunJob);

    // 3. Run the job through the new pipeline
    console.log(`     Running fresh lookup through updated pipeline...`);
    const completedJob = await runJob(deps, dryRunJob.id, { force: true });

    if (!completedJob || completedJob.status === 'failed') {
      console.log(`     ❌ Lookup failed: ${completedJob?.lastError ?? 'Unknown error'}`);
      continue;
    }

    // Print key adapter notes
    const adapterNotes = completedJob.log
      .map((l) => l.message)
      .filter((m) => m.startsWith('Clashfinder:') || m.startsWith('setlist.fm:') || m.startsWith('Web search') || m.startsWith('Read '));
    for (const note of adapterNotes) {
      console.log(`     ℹ️  ${note}`);
    }

    const newCandidates = completedJob.candidate?.performers ?? [];
    const newActs = newCandidates.map((p) => p.name);
    console.log(`     Fresh Pipeline Result: ${newActs.length} candidate act(s)`);

    // 4. Compute differences
    const prevSet = new Set(prevActs.map((a) => a.toLowerCase().trim()));
    const newSet = new Set(newActs.map((a) => a.toLowerCase().trim()));

    const added = newActs.filter((a) => !prevSet.has(a.toLowerCase().trim()));
    const removed = prevActs.filter((a) => !newSet.has(a.toLowerCase().trim()));

    console.log(`\n     📊 Comparison Breakdown:`);
    console.log(`        Total acts: ${prevActs.length} previously → ${newActs.length} now (delta: ${newActs.length - prevActs.length >= 0 ? '+' : ''}${newActs.length - prevActs.length})`);
    
    if (added.length > 0) {
      console.log(`        ➕ Newly captured acts (${added.length}):`);
      const preview = added.slice(0, 10).join(', ');
      console.log(`           ${preview}${added.length > 10 ? ` ...and ${added.length - 10} more` : ''}`);
    }

    if (removed.length > 0) {
      console.log(`        ➖ Filtered / absent acts (${removed.length}):`);
      const preview = removed.slice(0, 10).join(', ');
      console.log(`           ${preview}${removed.length > 10 ? ` ...and ${removed.length - 10} more` : ''}`);
    }

    const timedActs = newCandidates.filter((p) => p.sources.some((s) => (s.sets?.length ?? 0) > 0));
    if (timedActs.length > 0) {
      console.log(`        🕒 Timed sets captured: ${timedActs.length} acts have stages and set times.`);
    }

    // 5. Apply if requested
    if (opts.apply) {
      if (newCandidates.length === 0) {
        console.log(`     ⚠️ No acts found; skipping apply.`);
      } else {
        console.log(`     💾 Applying fresh lineup to event "${event.name}"...`);
        const confirmResult = await confirmLookup(store, completedJob, {
          performers: newCandidates.map((c) => ({
            key: c.key,
            name: c.name,
            accepted: true,
            billing: c.billing,
            seen: event.seen.some((s) => s.key === c.key),
          })),
        });

        console.log(`     ✅ Successfully updated event with Edition ID: ${confirmResult.edition.id}`);
      }
    } else {
      console.log(`     [Dry run complete — no changes written to database]`);
    }

    console.log(`-------------------------------------------------------------\n`);
  }

  console.log(`Done.\n`);
}

main().catch((err) => {
  console.error('Fatal error running comparison:', err);
  process.exit(1);
});
