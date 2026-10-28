import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LoggedEvent } from '../src/server/events/types.ts';
import { artistGaps, personInsights, seriesStreak, spanLabel } from '../src/services/insights.ts';
import { FileLineupStore } from '../src/server/lineup/store/fileStore.ts';
import { withEntityLinks } from '../src/server/entities/linkingStore.ts';
import { entityIdFor } from '../src/server/entities/link.ts';
import { addLink, ManageError, undoEntry } from '../src/server/entities/manage.ts';

const AT = '2026-10-28T00:00:00.000Z';
const refs = (o: Partial<NonNullable<LoggedEvent['refs']>> = {}) => ({ venueId: null, placeId: null, seriesId: null, companionIds: [], ...o });
const event = (id: string, over: Partial<LoggedEvent> = {}): LoggedEvent => ({
  id,
  input: '',
  name: `Night ${id}`,
  sources: {},
  details: { status: 'resolved', candidates: [], notes: [] },
  seen: [],
  daysAttended: [],
  companions: [],
  createdAt: AT,
  updatedAt: AT,
  ...over,
});
const act = (name: string) => ({ key: name.toLowerCase(), name, from: 'you' as const });

test('artist gaps use only events dated to the day, and say so', () => {
  const g = artistGaps(
    [event('a', { startDate: '2019-04-12' }), event('b', { startDate: '2023-04-14' }), event('c', { startDate: '2023-10-01' }), event('d', { year: 2024 })],
    '2026-10-28',
  );
  assert.equal(g.dated, 3);
  assert.equal(g.total, 4);
  assert.equal(g.lastDate, '2023-10-01');
  assert.equal(g.sinceLast, 1123);
  assert.deepEqual(g.longest, { days: 1463, from: '2019-04-12', to: '2023-04-14' });
  assert.deepEqual(artistGaps([event('x', { year: 2020 })], '2026-10-28'), { dated: 0, total: 1 });
  assert.equal(artistGaps([event('y', { startDate: '2024-01-01' })], '2026-10-28').longest, undefined);
  assert.equal(spanLabel(1463), '4 years');
  assert.equal(spanLabel(120), '3 months');
  assert.equal(spanLabel(1), '1 day');
});

test('shows with a person: count, first show and acts seen only with them', () => {
  const mike = 'p-mike';
  const went = [
    event('a', { startDate: '2022-05-01', seen: [act('Bonobo'), act('Tycho')], refs: refs({ companionIds: [mike] }) }),
    event('b', { year: 2018, seen: [act('Bonobo')], refs: refs({ companionIds: [mike, 'p-sam'] }) }),
    event('c', { startDate: '2023-01-01', seen: [act('Tycho')], refs: refs({ companionIds: [] }) }),
  ];
  const p = personInsights(went, mike);
  assert.equal(p.together, 2);
  assert.equal(p.first?.id, 'b');
  assert.deepEqual(p.onlyWith, [{ key: 'bonobo', name: 'Bonobo', times: 2 }]);
  assert.deepEqual(personInsights(went, 'nobody'), { together: 0, first: undefined, onlyWith: [] });
});

test('series streaks: consecutive years, longest and latest run', () => {
  const s = 's-edc';
  const went = [2016, 2017, 2018, 2021, 2022, 2022].map((y, i) => event(String(i), { year: y, refs: refs({ seriesId: s }) }));
  const r = seriesStreak([...went, event('x', { year: 2019 })], s);
  assert.deepEqual(r.years, [2016, 2017, 2018, 2021, 2022]);
  assert.deepEqual(r.longest, { from: 2016, to: 2018, length: 3 });
  assert.deepEqual(r.latest, { from: 2021, to: 2022, length: 2 });
  assert.deepEqual(seriesStreak(went, 'other'), { years: [] });
});

test('a person can be marked as having introduced you to an artist', async () => {
  const store = withEntityLinks(new FileLineupStore(await mkdtemp(path.join(tmpdir(), 'insights-'))));
  await store.putEvents([event('a', { companions: ['Mike'], seen: [act('Bonobo')] })]);
  const mike = entityIdFor('person', 'mike');
  const bonobo = entityIdFor('artist', 'bonobo');
  const entry = await addLink(store, mike, bonobo, 'introduced_me_to', AT);
  assert.match(entry.summary, /"Mike" introduced you to "Bonobo"/);
  assert.ok((await store.listEntityLinks()).some((l) => l.role === 'introduced_me_to' && l.toId === bonobo));
  await assert.rejects(addLink(store, bonobo, mike, 'introduced_me_to'), ManageError);
  await undoEntry(store, entry.id);
  assert.equal((await store.listEntityLinks()).length, 0);
});
