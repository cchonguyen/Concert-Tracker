import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NavStorage, pageFromView, rememberedPage, rememberPage, REMEMBER_KEY, sectionOf, subPagesFor, viewFor } from '../src/services/nav.ts';

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
  assert.equal(sectionOf('timeline'), 'explore');
  assert.equal(sectionOf('map'), 'explore');
  assert.equal(sectionOf('stats'), 'explore');
  assert.equal(sectionOf('artists'), 'explore');
});

test('owners see all three Library subtabs and all four Explore subtabs', () => {
  assert.deepEqual(subPagesFor('library', OWNER), ['summary', 'table', 'manage']);
  assert.deepEqual(subPagesFor('explore', OWNER), ['timeline', 'map', 'stats', 'artists']);
});

test('members who cannot see Manage keep Summary and Table only', () => {
  assert.deepEqual(subPagesFor('library', MEMBER), ['summary', 'table']);
  assert.deepEqual(subPagesFor('explore', MEMBER), ['timeline', 'map', 'stats', 'artists']);
});

test('no view, and the old ?view=events, open Home', () => {
  assert.equal(pageFromView(null, OWNER), 'home');
  assert.equal(pageFromView('', OWNER), 'home');
  assert.equal(pageFromView('events', OWNER), 'home');
  assert.equal(pageFromView('nonsense', OWNER), 'home');
  assert.equal(pageFromView('home', OWNER), 'home');
});

test('each page is named in the address the way the old views were', () => {
  assert.equal(pageFromView('table', OWNER), 'table');
  assert.equal(pageFromView('map', OWNER), 'map');
  assert.equal(pageFromView('timeline', OWNER), 'timeline');
  assert.equal(pageFromView('summary', OWNER), 'summary');
  assert.equal(pageFromView('stats', OWNER), 'stats');
  assert.equal(pageFromView('artists', OWNER), 'artists');
  assert.equal(pageFromView('manage', OWNER), 'manage');
  assert.equal(viewFor('map'), 'view=map');
  assert.equal(viewFor('summary'), 'view=summary');
  assert.equal(viewFor('home'), '');
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
  assert.equal(rememberedPage('explore', OWNER, memoryStorage()), 'timeline');
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

test('a corrupt or blocked store is ignored instead of breaking the header', () => {
  assert.equal(rememberedPage('explore', OWNER, memoryStorage({ [REMEMBER_KEY]: '{not json' })), 'timeline');
  assert.equal(rememberedPage('explore', OWNER, memoryStorage({ [REMEMBER_KEY]: '"text"' })), 'timeline');
  const blocked: NavStorage = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
  };
  assert.equal(rememberedPage('explore', OWNER, blocked), 'timeline');
  assert.doesNotThrow(() => rememberPage('map', blocked));
});

test("remembering one section keeps the other section's choice", () => {
  const storage = memoryStorage();
  rememberPage('stats', storage);
  rememberPage('summary', storage);
  assert.equal(rememberedPage('explore', OWNER, storage), 'stats');
  assert.equal(rememberedPage('library', OWNER, storage), 'summary');
});
