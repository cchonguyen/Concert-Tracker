import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hintSeen,
  markHintSeen,
  NavStorage,
  pageFromView,
  rememberedPage,
  rememberPage,
  REMEMBER_KEY,
  sectionOf,
  subPagesFor,
  viewFor,
  buildManageSearch,
  parseManageParams,
  rememberManageSearch,
  rememberedManageSearch,
} from '../src/services/nav.ts';

const OWNER = { canManage: true };
const MEMBER = { canManage: false };

const memoryStorage = (initial: Record<string, string> = {}): NavStorage & { data: Record<string, string> } => {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
};

test('every page belongs to one section, and Home to none', () => {
  assert.equal(sectionOf('home'), null);
  assert.equal(sectionOf('summary'), 'library');
  assert.equal(sectionOf('table'), 'library');
  assert.equal(sectionOf('manage'), 'library');
  for (const p of ['agenda', 'month', 'heatmap', 'river', 'map', 'stats', 'ranking'] as const) assert.equal(sectionOf(p), 'explore');
});

const EXPLORE = ['agenda', 'month', 'heatmap', 'river', 'map', 'stats', 'ranking'];

test('owners see all four Library subtabs and all seven Explore subtabs', () => {
  assert.deepEqual(subPagesFor('library', OWNER), ['summary', 'table', 'manage', 'log']);
  assert.deepEqual(subPagesFor('explore', OWNER), EXPLORE);
});

test('members who cannot see Manage keep Summary, Table and Log', () => {
  assert.deepEqual(subPagesFor('library', MEMBER), ['summary', 'table', 'log']);
  assert.deepEqual(subPagesFor('explore', MEMBER), EXPLORE);
});

test('no view, and the old ?view=events, open Home', () => {
  assert.equal(pageFromView(null, OWNER), 'home');
  assert.equal(pageFromView('', OWNER), 'home');
  assert.equal(pageFromView('events', OWNER), 'home');
  assert.equal(pageFromView('nonsense', OWNER), 'home');
  assert.equal(pageFromView('home', OWNER), 'home');
});

test('each page is named in the address by its page name', () => {
  assert.equal(pageFromView('table', OWNER), 'table');
  assert.equal(pageFromView('map', OWNER), 'map');
  assert.equal(pageFromView('agenda', OWNER), 'agenda');
  assert.equal(pageFromView('river', OWNER), 'river');
  assert.equal(pageFromView('summary', OWNER), 'summary');
  assert.equal(pageFromView('stats', OWNER), 'stats');
  assert.equal(pageFromView('ranking', OWNER), 'ranking');
  assert.equal(pageFromView('manage', OWNER), 'manage');
  assert.equal(viewFor('map'), 'view=map');
  assert.equal(viewFor('summary'), 'view=summary');
  assert.equal(viewFor('home'), '');
});

test('the retired names timeline and artists open Home, with no redirect', () => {
  assert.equal(pageFromView('timeline', OWNER), 'home');
  assert.equal(pageFromView('artists', OWNER), 'home');
  assert.equal(pageFromView('timeline', MEMBER), 'home');
});

test('a member opening ?view=manage lands on Summary', () => {
  assert.equal(pageFromView('manage', MEMBER), 'summary');
});

test('the address round-trips for every page the viewer can see', () => {
  for (const p of [...subPagesFor('library', OWNER), ...subPagesFor('explore', OWNER)]) {
    const view = viewFor(p).replace('view=', '');
    assert.equal(pageFromView(view, OWNER), p);
  }
});

test('the first visit to a section opens its first page', () => {
  assert.equal(rememberedPage('library', OWNER, memoryStorage()), 'summary');
  assert.equal(rememberedPage('explore', OWNER, memoryStorage()), 'agenda');
  assert.equal(rememberedPage('library', OWNER, null), 'summary');
});

test('a remembered subtab is reopened per section, not across sections', () => {
  const storage = memoryStorage();
  rememberPage('table', storage);
  rememberPage('map', storage);
  assert.equal(rememberedPage('library', OWNER, storage), 'table');
  assert.equal(rememberedPage('explore', OWNER, storage), 'map');
});

test('a remembered Manage falls back to Summary for a member', () => {
  const storage = memoryStorage();
  rememberPage('manage', storage);
  assert.equal(rememberedPage('library', OWNER, storage), 'manage');
  assert.equal(rememberedPage('library', MEMBER, storage), 'summary');
});

test('a remembered subtab from before the rename falls back to the first page', () => {
  assert.equal(rememberedPage('explore', OWNER, memoryStorage({ [REMEMBER_KEY]: JSON.stringify({ explore: 'timeline' }) })), 'agenda');
  assert.equal(rememberedPage('explore', OWNER, memoryStorage({ [REMEMBER_KEY]: JSON.stringify({ explore: 'artists' }) })), 'agenda');
  assert.equal(rememberedPage('library', OWNER, memoryStorage({ [REMEMBER_KEY]: JSON.stringify({ library: 'timeline' }) })), 'summary');
  assert.equal(rememberedPage('explore', OWNER, memoryStorage({ [REMEMBER_KEY]: JSON.stringify({ explore: 'ranking' }) })), 'ranking');
});

test('a corrupt or blocked store is ignored instead of breaking the header', () => {
  assert.equal(rememberedPage('explore', OWNER, memoryStorage({ [REMEMBER_KEY]: '{not json' })), 'agenda');
  assert.equal(rememberedPage('explore', OWNER, memoryStorage({ [REMEMBER_KEY]: '"text"' })), 'agenda');
  const blocked: NavStorage = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
  };
  assert.equal(rememberedPage('explore', OWNER, blocked), 'agenda');
  assert.doesNotThrow(() => rememberPage('map', blocked));
});

test("remembering one section keeps the other section's choice", () => {
  const storage = memoryStorage();
  rememberPage('stats', storage);
  rememberPage('summary', storage);
  assert.equal(rememberedPage('explore', OWNER, storage), 'stats');
  assert.equal(rememberedPage('library', OWNER, storage), 'summary');
});

test('the icon-tab hint shows once: unseen until marked, and blocked storage never shows it again', () => {
  const storage = memoryStorage();
  assert.equal(hintSeen(storage), false);
  markHintSeen(storage);
  assert.equal(hintSeen(storage), true);
  assert.equal(hintSeen(null), false);
  assert.equal(hintSeen({ getItem: () => { throw new Error('denied'); }, setItem: () => undefined }), true);
});

test('pageFromView identifies manage view from complex query parameters', () => {
  const searchMine = '?view=manage&kind=venue&id=ven-99';
  const searchArchive = '?view=manage&scope=archive&section=editions&status=verified';
  assert.equal(pageFromView(new URLSearchParams(searchMine).get('view'), OWNER), 'manage');
  assert.equal(pageFromView(new URLSearchParams(searchArchive).get('view'), OWNER), 'manage');
  assert.equal(pageFromView(new URLSearchParams(searchArchive).get('view'), MEMBER), 'summary');
});

test('manage query persistence round trips via rememberedManageSearch and integrates with buildManageSearch', () => {
  const store = memoryStorage();
  assert.equal(rememberedManageSearch(store), null);

  const search = buildManageSearch({ scope: 'archive', section: 'editions', status: 'verified', q: 'fest' });
  rememberManageSearch(search, store);
  assert.equal(rememberedManageSearch(store), search);

  const parsed = parseManageParams(rememberedManageSearch(store)!);
  assert.equal(parsed.scope, 'archive');
  assert.equal(parsed.section, 'editions');
  assert.equal(parsed.status, 'verified');
  assert.equal(parsed.q, 'fest');

  // Verify pageFromView still extracts manage correctly from the stored query
  assert.equal(pageFromView(new URLSearchParams(search).get('view'), OWNER), 'manage');
});
