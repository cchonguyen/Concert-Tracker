import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { FillGaps } from '../src/components/FillGaps';

// Regression: Fill gaps went blank on mount (a useState initializer read `counts` before it was declared).
// Rendering a batch result (a candidate waiting for a tap) must not throw.
test('Fill gaps renders with a batch result waiting for a tap', () => {
  const candidate = {
    id: 'cand-1',
    startDate: '2015-05-01',
    sources: [{ quote: 'May 1, 2015', fields: ['startDate'], sourceUrl: 'https://example.com/a', sourceType: 'discovered' }],
  };
  const waiting = {
    id: 'ev-1', city: 'Washington', kind: null, name: 'Dash Berlin', seen: [], year: 2015, input: 'Dash Berlin',
    month: null, notes: null, venue: 'Echostage', format: null, rating: null, region: 'DC', series: null, country: 'USA',
    weekend: null, captured: {}, endDate: null, startDate: undefined, overrides: {}, seriesId: null, attendance: null,
    companions: [], editionId: null, personIds: [], ticketPrice: null, companionIds: [], daysAttended: [], lineupJobId: null,
    details: { status: 'choose', notes: [], candidates: [candidate] }, weather: null,
  };
  const props = {
    events: [waiting], all: [waiting], lineups: {}, editions: {},
    onChanged() {}, onRefresh() {}, onOpen() {}, onClose() {},
  };
  const html = renderToString(React.createElement(FillGaps as never, props as never));
  assert.ok(html.includes('Results to confirm'));
});
