#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config();

import { createStore } from '../src/server/lineup/service.ts';
import { isNonMusicProgramming, isSilentDiscoSlot } from '../src/server/lineup/actName.ts';
import { normalizeName } from '../src/server/lineup/text.ts';
import type { Edition, EditionPerformance } from '../src/server/lineup/types.ts';

const COACHELLA_EDITIONS = [
  { id: '0de5b120-6394-4322-8e96-5d9dbf5e2cca', year: 2023, correctName: 'Coachella 2023 Weekend 1', eventId: 'b4e8525d-0054-460e-8f8b-bfd947a5dd99' },
  { id: '559e735f-ade2-48fd-9de4-938ebe0923db', year: 2025, correctName: 'Coachella 2025 Weekend 1', eventId: 'c415f831-6e7a-42f9-9d0a-d16d921c765c' },
];

const ALIAS_MAP: Record<string, string> = {
  'keleena zanders': 'Kaleena Zanders',
  wavegroove: 'Wave Groove',
};

function parseArgs() {
  const args = process.argv.slice(2);
  const yearIdx = args.indexOf('--year');
  const targetYear = yearIdx >= 0 && args[yearIdx + 1] ? parseInt(args[yearIdx + 1], 10) : null;
  return {
    apply: args.includes('--apply'),
    targetYear,
  };
}

async function cleanEdition(store: any, target: typeof COACHELLA_EDITIONS[number], apply: boolean) {
  console.log(`\n-------------------------------------------------------------`);
  console.log(`  Cleaning Coachella ${target.year} (Edition ID: ${target.id})`);
  console.log(`-------------------------------------------------------------`);

  const edition: Edition | null = await store.getEdition(target.id);
  if (!edition || !edition.performances) {
    console.error(`Error: Edition ${target.id} not found in store.`);
    return;
  }

  const initialCount = edition.performances.length;
  console.log(`Loaded edition: "${edition.name}" (Key: ${edition.key})`);
  console.log(`Initial performance count: ${initialCount}`);

  // 1. Identify junk performances to remove
  const dropped: EditionPerformance[] = [];
  const kept: EditionPerformance[] = [];

  for (const p of edition.performances) {
    const raw = p.name;
    if (isNonMusicProgramming(raw) || isSilentDiscoSlot(raw)) {
      dropped.push(p);
    } else {
      kept.push(p);
    }
  }

  console.log(`\nFound ${dropped.length} non-music / silent disco entries to drop:`);
  for (const d of dropped) {
    const stage = d.stages?.join(', ') || 'Unknown Stage';
    console.log(`  - [${stage}] "${d.name}"`);
  }

  // 2. Fix/clean known typos and malformed artist names
  let cleanedCount = 0;
  const cleaned: EditionPerformance[] = kept.map((p) => {
    let name = p.name;
    let artistKey = p.artistKey;
    let b2b = p.b2b;

    // Check alias mapping
    if (ALIAS_MAP[artistKey]) {
      name = ALIAS_MAP[artistKey];
      artistKey = normalizeName(name);
      cleanedCount++;
    }

    // Fix b2b references to aliases
    if (b2b && b2b.some((partner) => ALIAS_MAP[partner])) {
      b2b = b2b.map((partner) => (ALIAS_MAP[partner] ? normalizeName(ALIAS_MAP[partner]) : partner));
      cleanedCount++;
    }

    // Fix malformed concept show names
    if (name.includes('Sara Landry presents Blood Oath (Indira Paganotto')) {
      name = 'Indira Paganotto';
      artistKey = normalizeName(name);
      cleanedCount++;
    }
    if (name.endsWith(')') && !name.includes('(')) {
      name = name.replace(/\)+$/, '').trim();
      artistKey = normalizeName(name);
      cleanedCount++;
    }

    return {
      ...p,
      name,
      artistKey,
      b2b,
    };
  });

  // 3. Deduplicate performances that merged under identical artistKey and slotId/day/stage
  const deduped: EditionPerformance[] = [];
  const seenKeys = new Set<string>();

  for (const p of cleaned) {
    const sig = `${p.artistKey}::${p.slotId ?? 'solo'}::${(p.days || []).join(',')}::${(p.stages || []).join(',')}`;
    if (seenKeys.has(sig)) {
      console.log(`  - Merging duplicate performance: "${p.name}" on [${p.stages?.join(', ')}]`);
      continue;
    }
    seenKeys.add(sig);
    deduped.push(p);
  }

  console.log(`\nCleaned ${cleanedCount} performance names / references.`);
  console.log(`Final performance count: ${deduped.length} (reduced by ${initialCount - deduped.length})`);

  if (apply) {
    console.log(`Applying updates to Supabase...`);

    const updatedEdition: Edition = {
      ...edition,
      name: target.correctName,
      performances: deduped,
      updatedAt: new Date().toISOString(),
    };
    await store.upsertEdition(updatedEdition);
    console.log(`  ✓ Saved cleaned edition "${target.correctName}" with ${deduped.length} performances.`);

    // If event name had a typo (e.g. Coachella 2024 instead of 2023), update event name
    if (target.eventId) {
      const event = await store.getEvent(target.eventId);
      if (event && event.name !== target.correctName) {
        console.log(`  ✓ Updating event title from "${event.name}" to "${target.correctName}"`);
        await store.putEvent({
          ...event,
          name: target.correctName,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }
}

async function main() {
  const opts = parseArgs();
  console.log(`\n=============================================================`);
  console.log(`  Coachella Lineup Audit & Cleanup Tool (2023 & 2025)`);
  console.log(`  Mode: ${opts.apply ? 'APPLY (writing changes)' : 'DRY RUN (pass --apply to execute)'}`);
  console.log(`=============================================================`);

  const store = await createStore();

  const targets = opts.targetYear
    ? COACHELLA_EDITIONS.filter((t) => t.year === opts.targetYear)
    : COACHELLA_EDITIONS;

  for (const target of targets) {
    await cleanEdition(store, target, opts.apply);
  }

  if (opts.apply) {
    await store.putAliases(ALIAS_MAP);
    console.log(`\n✓ Learned ${Object.keys(ALIAS_MAP).length} aliases in artist_aliases.`);
    console.log(`\nDone! All targeted Coachella lineups are fully cleaned in Supabase.`);
  } else {
    console.log(`\nDry run complete. No database changes written. Pass --apply to execute.`);
  }
}

main().catch((err) => {
  console.error('Error running Coachella cleanup:', err);
  process.exit(1);
});
