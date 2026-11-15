import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseManageParams,
  buildManageSearch,
  buildManageQuery,
  buildManageUrl,
  editionUrl,
  seriesUrl,
  canonicalArtistUrl,
  entityUrl,
  isModifiedClick,
  rememberManageSearch,
  rememberedManageSearch,
  MANAGE_QUERY_STORAGE_KEY,
} from '../src/services/manageNav.ts';
import type { NavStorage } from '../src/services/nav.ts';

const memoryStorage = (initial: Record<string, string> = {}): NavStorage & { data: Record<string, string> } => {
  const data = { ...initial };
  return {
    data,
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
  };
};

test('parseManageParams defaults to scope mine with empty or bare search', () => {
  assert.deepEqual(parseManageParams(''), { scope: 'mine' });
  assert.deepEqual(parseManageParams('?'), { scope: 'mine' });
  assert.deepEqual(parseManageParams('?view=manage'), { scope: 'mine' });
  assert.deepEqual(parseManageParams('/app?view=manage'), { scope: 'mine' });
  assert.deepEqual(parseManageParams('?scope=mine'), { scope: 'mine' });
  assert.deepEqual(parseManageParams('?scope=unexpected'), { scope: 'mine' });
});

test('parseManageParams sets scope archive and defaults section to editions', () => {
  assert.deepEqual(parseManageParams('?scope=archive'), { scope: 'archive', section: 'editions' });
  assert.deepEqual(parseManageParams('/app?view=manage&scope=archive'), { scope: 'archive', section: 'editions' });
  assert.deepEqual(parseManageParams('?scope=archive&section=unknown_section'), { scope: 'archive', section: 'editions' });
});

test('parseManageParams accepts valid archive sections', () => {
  for (const section of ['artists', 'series', 'editions', 'lookups', 'changes'] as const) {
    const res = parseManageParams(`?scope=archive&section=${section}`);
    assert.equal(res.scope, 'archive');
    assert.equal(res.section, section);
  }
});

test('parseManageParams extracts series slug and seriesUrl builds archive series link', () => {
  const res = parseManageParams('?scope=archive&section=series&series=coachella&q=fest');
  assert.deepEqual(res, {
    scope: 'archive',
    section: 'series',
    series: 'coachella',
    q: 'fest',
  });
  assert.equal(seriesUrl('coachella'), '/app?view=manage&scope=archive&section=series&series=coachella');
});

test('parseManageParams extracts and trims entity kind and id', () => {
  assert.deepEqual(parseManageParams('?view=manage&kind=venue&id=v-123'), {
    scope: 'mine',
    kind: 'venue',
    id: 'v-123',
  });
  assert.deepEqual(parseManageParams('?kind=%20artist%20&id=%20a-456%20'), {
    scope: 'mine',
    kind: 'artist',
    id: 'a-456',
  });
  // Empty or whitespace-only params are omitted
  assert.deepEqual(parseManageParams('?kind=&id=%20'), { scope: 'mine' });
});

test('parseManageParams extracts valid edition status and filters invalid status', () => {
  for (const status of ['all', 'verified', 'provisional', 'draft'] as const) {
    const res = parseManageParams(`?scope=archive&status=${status}`);
    assert.equal(res.status, status);
  }
  const invalid = parseManageParams('?scope=archive&status=bogus');
  assert.equal(invalid.status, undefined);
});

test('parseManageParams extracts edition, artist, and q queries with trimming', () => {
  const res = parseManageParams('?scope=archive&section=editions&edition=ed-99&artist=Radiohead&q=Glastonbury');
  assert.deepEqual(res, {
    scope: 'archive',
    section: 'editions',
    edition: 'ed-99',
    artist: 'Radiohead',
    q: 'Glastonbury',
  });

  const emptyStrings = parseManageParams('?scope=archive&edition=%20&artist=&q=%20%20');
  assert.deepEqual(emptyStrings, {
    scope: 'archive',
    section: 'editions',
  });
});

test('buildManageSearch and buildManageUrl generate clean query strings omitting default values', () => {
  assert.equal(buildManageSearch(), '?view=manage');
  assert.equal(buildManageSearch({ scope: 'mine' }), '?view=manage');
  assert.equal(buildManageSearch({ status: 'all' }), '?view=manage');
  assert.equal(buildManageSearch({ q: '' }), '?view=manage');
  assert.equal(buildManageSearch({ q: '   ' }), '?view=manage');

  assert.equal(buildManageUrl(), '/app?view=manage');
  assert.equal(buildManageUrl({}, '/custom'), '/custom?view=manage');
  assert.equal(buildManageQuery(), '?view=manage');
});

test('buildManageSearch includes explicit scope archive and archive sections', () => {
  const search = buildManageSearch({ scope: 'archive', section: 'artists', artist: 'LCD Soundsystem' });
  assert.equal(search, '?view=manage&scope=archive&section=artists&artist=LCD+Soundsystem');

  const withStatus = buildManageSearch({
    scope: 'archive',
    section: 'editions',
    status: 'verified',
    q: 'Coachella',
  });
  assert.equal(withStatus, '?view=manage&scope=archive&section=editions&status=verified&q=Coachella');
});

test('editionUrl produces canonical shared edition URL with optional extra state', () => {
  assert.equal(
    editionUrl('ed-101'),
    '/app?view=manage&scope=archive&section=editions&edition=ed-101'
  );
  assert.equal(
    editionUrl('ed-101', { status: 'verified', q: 'fest' }),
    '/app?view=manage&scope=archive&section=editions&edition=ed-101&status=verified&q=fest'
  );
});

test('canonicalArtistUrl produces canonical artist URL with optional extra state', () => {
  assert.equal(
    canonicalArtistUrl('Portishead'),
    '/app?view=manage&scope=archive&section=artists&artist=Portishead'
  );
  assert.equal(
    canonicalArtistUrl('Portishead', { q: 'Roseland' }),
    '/app?view=manage&scope=archive&section=artists&artist=Portishead&q=Roseland'
  );
});

test('entityUrl produces local entity inspector URL under default mine scope', () => {
  assert.equal(
    entityUrl('artist', 'art-50'),
    '/app?view=manage&kind=artist&id=art-50'
  );
  assert.equal(
    entityUrl('venue', 'ven-77'),
    '/app?view=manage&kind=venue&id=ven-77'
  );
  assert.equal(
    entityUrl('series', 'ser-1', { q: 'summer' }),
    '/app?view=manage&kind=series&id=ser-1&q=summer'
  );
});

test('isModifiedClick detects modifier keys and non-left clicks correctly', () => {
  // Normal primary click
  assert.equal(isModifiedClick({ button: 0 }), false);
  assert.equal(isModifiedClick({}), false);
  assert.equal(isModifiedClick({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }), false);

  // Non-primary clicks
  assert.equal(isModifiedClick({ button: 1 }), true); // middle click
  assert.equal(isModifiedClick({ button: 2 }), true); // right click

  // Modifiers
  assert.equal(isModifiedClick({ button: 0, metaKey: true }), true);
  assert.equal(isModifiedClick({ button: 0, ctrlKey: true }), true);
  assert.equal(isModifiedClick({ button: 0, shiftKey: true }), true);
  assert.equal(isModifiedClick({ button: 0, altKey: true }), true);
  assert.equal(isModifiedClick({ metaKey: true }), true);
  assert.equal(isModifiedClick({ ctrlKey: true }), true);
});

test('rememberManageSearch and rememberedManageSearch save and restore manage query string', () => {
  const store = memoryStorage();
  assert.equal(rememberedManageSearch(store), null);

  const query = '?view=manage&scope=archive&section=editions&edition=ed-42';
  rememberManageSearch(query, store);
  assert.equal(store.data[MANAGE_QUERY_STORAGE_KEY], query);
  assert.equal(rememberedManageSearch(store), query);

  // Overwriting with new query
  const query2 = '?view=manage&kind=artist&id=art-9';
  rememberManageSearch(query2, store);
  assert.equal(rememberedManageSearch(store), query2);
});

test('rememberManageSearch handles null and throwing storage gracefully', () => {
  assert.doesNotThrow(() => rememberManageSearch('?view=manage', null));
  assert.equal(rememberedManageSearch(null), null);

  const blocked: NavStorage = {
    getItem: () => {
      throw new Error('Storage blocked');
    },
    setItem: () => {
      throw new Error('Storage blocked');
    },
  };

  assert.doesNotThrow(() => rememberManageSearch('?view=manage', blocked));
  assert.equal(rememberedManageSearch(blocked), null);
});
