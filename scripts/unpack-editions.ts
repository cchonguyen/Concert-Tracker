#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config();

import { randomUUID } from 'node:crypto';
import { createStore } from '../src/server/lineup/service.ts';
import { readActName, preferredSpelling } from '../src/server/lineup/actName.ts';
import { normalizeName } from '../src/server/lineup/text.ts';
import type { Edition, EditionPerformance } from '../src/server/lineup/types.ts';
import type { LoggedEvent, SeenAct } from '../src/server/events/types.ts';

const SINGLE_ENTITY_EXCEPTIONS = new Set([
  'niiko x swae',
  'sob x rbe',
  'truth x lies',
]);

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    apply: args.includes('--apply'),
  };
}

interface ParsedSet {
  alias?: string;
  parts: string[];
}

function parsePerformanceName(rawName: string): ParsedSet | null {
  const norm = normalizeName(rawName);
  if (SINGLE_ENTITY_EXCEPTIONS.has(norm)) return null;

  // Check pattern: "Alias (Artist A b2b Artist B)" or "STARSIGNS (MANILLA KILLA B3B YETEP B3B MYRNE)"
  const parenMatch = rawName.match(/^([^(]+)\s*\(([^)]+)\)$/);
  if (parenMatch) {
    const aliasCandidate = parenMatch[1].trim();
    const inner = parenMatch[2].trim();
    // Verify inner is a B2B/B3B
    const innerRead = readActName(inner);
    if (innerRead.parts.length > 1) {
      return {
        alias: aliasCandidate,
        parts: innerRead.parts,
      };
    }
    // Check if inner is an alias like "Tchami X Malaa (No Redemption)"
    const outerRead = readActName(aliasCandidate);
    if (outerRead.parts.length > 1) {
      return {
        alias: inner,
        parts: outerRead.parts,
      };
    }
  }

  // Check pattern: "Odd Mob X Omnom: Hyperbeam" or "Space 92 X Popof Present: Turbulences"
  const colonMatch = rawName.match(/^(.+?):\s*(.+)$/);
  if (colonMatch) {
    const leftRead = readActName(colonMatch[1].trim());
    if (leftRead.parts.length > 1) {
      return {
        alias: colonMatch[2].trim(),
        parts: leftRead.parts.map((p) => p.replace(/\s+presents?$/i, '').trim()),
      };
    }
  }

  // Standard B2B / B3B / B4B / x
  const read = readActName(rawName);
  if (read.parts.length > 1) {
    return {
      parts: read.parts,
    };
  }

  return null;
}

async function main() {
  const { apply } = parseArgs();

  console.log('=============================================================');
  console.log('  LiveArchive Edition & Seen B2B/B3B Unpacker');
  console.log(`  Mode: ${apply ? '⚡ LIVE APPLY (Updates DB)' : '🔍 DRY RUN (Read-only)'}`);
  console.log('=============================================================\n');

  const store = await createStore();
  const allEvents = await store.listEvents();
  const eventsWithEdition = allEvents.filter((e) => Boolean(e.editionId));

  console.log(`Scanning ${eventsWithEdition.length} events with confirmed editions...\n`);

  let modifiedEditionsCount = 0;
  let modifiedEventsSeenCount = 0;
  const learnedAliases: Record<string, string> = {};

  for (const event of eventsWithEdition) {
    if (!event.editionId) continue;
    const edition = await store.getEdition(event.editionId);
    if (!edition || !edition.performances?.length) continue;

    let editionNeedsUpdate = false;
    const newPerformances: EditionPerformance[] = [];
    const unpackedOldKeys = new Map<string, { slotId: string; alias?: string; partners: string[]; names: string[] }>();

    for (const perf of edition.performances) {
      const parsed = parsePerformanceName(perf.name);
      if (!parsed || parsed.parts.length <= 1) {
        newPerformances.push(perf);
        continue;
      }

      editionNeedsUpdate = true;
      const slotId = randomUUID();
      const partnerKeys = parsed.parts.map((p) => normalizeName(p)).filter(Boolean);
      const oldKey = perf.artistKey;

      unpackedOldKeys.set(oldKey, {
        slotId,
        alias: parsed.alias,
        partners: partnerKeys,
        names: parsed.parts,
      });

      console.log(`  [${event.name}] Unpacking "${perf.name}"`);
      if (parsed.alias) {
        console.log(`     ↳ Alias: "${parsed.alias}"`);
        const aKey = normalizeName(parsed.alias);
        if (aKey) learnedAliases[aKey] = parsed.parts.join(' b2b ');
      }
      console.log(`     ↳ Parts (${parsed.parts.length}): ${parsed.parts.join('  •  ')}`);

      for (const part of parsed.parts) {
        const key = normalizeName(part);
        const properName = preferredSpelling(part, {});
        newPerformances.push({
          ...perf,
          artistKey: key,
          name: properName,
          slotId,
          alias: parsed.alias,
          b2b: partnerKeys.filter((k) => k !== key),
        });
      }
    }

    if (editionNeedsUpdate) {
      modifiedEditionsCount++;
      const updatedEdition: Edition = {
        ...edition,
        performances: newPerformances,
        updatedAt: new Date().toISOString(),
      };

      if (apply) {
        await store.upsertEdition(updatedEdition);
        console.log(`  💾 Updated edition "${edition.name}" (${edition.id})\n`);
      } else {
        console.log(`  🔍 [Dry Run] Would update edition "${edition.name}" (${edition.id})\n`);
      }
    }

    // Check if event.seen contains any of the unpacked old keys
    if (unpackedOldKeys.size > 0 && event.seen && event.seen.length > 0) {
      let seenNeedsUpdate = false;
      const nextSeen: SeenAct[] = [];

      for (const s of event.seen) {
        const matched = unpackedOldKeys.get(s.key) ?? unpackedOldKeys.get(normalizeName(s.name));
        if (!matched) {
          nextSeen.push(s);
          continue;
        }

        seenNeedsUpdate = true;
        console.log(`  [${event.name}] Updating seen act "${s.name}" -> ${matched.names.length} B2B acts`);

        for (const name of matched.names) {
          const key = normalizeName(name);
          nextSeen.push({
            id: randomUUID(),
            slotId: matched.slotId,
            alias: matched.alias,
            key,
            name: preferredSpelling(name, {}),
            from: s.from,
            role: s.role,
            roleFrom: s.roleFrom,
            favourite: s.favourite,
            set: s.set,
            b2b: matched.partners.filter((k) => k !== key),
          });
        }
      }

      if (seenNeedsUpdate) {
        modifiedEventsSeenCount++;
        if (apply) {
          await store.putEvent({
            ...event,
            seen: nextSeen,
          });
          console.log(`  💾 Updated seen acts for event "${event.name}"\n`);
        } else {
          console.log(`  🔍 [Dry Run] Would update seen acts for event "${event.name}"\n`);
        }
      }
    }
  }

  if (apply && Object.keys(learnedAliases).length > 0) {
    await store.putAliases(learnedAliases);
    console.log(`  💾 Saved ${Object.keys(learnedAliases).length} collaboration aliases to artist_aliases.`);
  }

  console.log('-------------------------------------------------------------');
  console.log(`Summary:`);
  console.log(`  Editions to update: ${modifiedEditionsCount}`);
  console.log(`  Events seen list to update: ${modifiedEventsSeenCount}`);
  console.log(`  Collaboration aliases learned: ${Object.keys(learnedAliases).length}`);
  if (!apply) {
    console.log(`\nTo apply these updates to the database, run:`);
    console.log(`  npx tsx scripts/unpack-editions.ts --apply\n`);
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
