import React, { useState } from 'react';
import { canonicalApi } from '../services/lineupApi';
import { formatPlaceLabel } from '../services/placeAutofill';
import type { VenueFillPlan } from '../server/canon/venueFill';
import type { VenueLocation } from '../server/canon/venueLocation';
import { Ledger } from './ui/Ledger';

const BATCH = 40;
const label = (p: { city?: string; region?: string; country?: string }) => formatPlaceLabel(p) || 'Nothing yet';
const FROM: Record<'city' | 'venue', string> = { city: 'split from the city', venue: 'from venue records' };

// Global Editions: fill editions' empty city, state and country from their own "City, ST" text and their venue's one
// known location (docs/specs/venue-location-fill.md). Only empty fields; each fill is logged and undoable in Changes.
export const VenueFillPanel: React.FC = () => {
  const [plan, setPlan] = useState<VenueFillPlan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    setBusy('load');
    try {
      setPlan(await canonicalApi.venueFillPlan());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not check the editions.');
    } finally {
      setBusy(null);
    }
  };

  const fillAll = async () => {
    if (!plan?.fills.length) return;
    setBusy('all');
    setNotice(null);
    const ids = plan.fills.map((f) => f.editionId);
    let filled = 0;
    let left = 0;
    try {
      for (let i = 0; i < ids.length; i += BATCH) {
        const r = await canonicalApi.venueFillApply({ editionIds: ids.slice(i, i + BATCH) });
        filled += r.filled.length;
        left += r.left;
      }
      setNotice(left ? `Filled ${filled}. ${left} more need another press.` : `Filled ${filled}. Each one can be undone in Changes.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not fill the editions.');
    } finally {
      setBusy(null);
    }
  };

  const pick = async (editionId: string, location: VenueLocation) => {
    setBusy(editionId);
    try {
      const r = await canonicalApi.venueFillApply({ picks: [{ editionId, location }] });
      setNotice(r.filled.length ? `Filled with ${label(location)}.` : 'Nothing was filled: the edition changed since the check.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not fill the edition.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label="Fill locations from venues" className="space-y-2 rounded-card border border-line bg-surface-1 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-base font-normal text-text">Fill locations from venues</h3>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void load()}
          className="min-h-11 rounded-control border border-line-strong px-2.5 py-1 text-xs text-text hover:bg-surface-2 disabled:opacity-50 sm:min-h-9"
        >
          {busy === 'load' ? 'Checking…' : plan ? 'Check again' : 'Check editions'}
        </button>
      </div>
      {!plan && <p className="text-xs text-text-muted">Finds editions with an empty city, state or country that their venue or their own city already gives. Nothing is changed until you press Fill.</p>}
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      {notice && <p role="status" className="text-sm text-text-muted">{notice}</p>}
      {plan && plan.unchecked > 0 && <p className="font-mono text-xs tabular-nums text-text-muted">{plan.unchecked} more editions were not checked this time. Press Check again after filling.</p>}
      {plan && plan.fills.length === 0 && plan.choices.length === 0 && <p className="text-sm text-text-muted">Nothing to fill.</p>}
      {plan && plan.fills.length > 0 && (
        <>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void fillAll()}
            className="min-h-11 rounded-control border border-accent-tint-line bg-accent-tint px-2.5 py-1 font-mono text-xs tabular-nums text-accent hover:underline disabled:opacity-50 sm:min-h-9"
          >
            {busy === 'all' ? 'Filling…' : `Fill all (${plan.fills.length})`}
          </button>
          <Ledger>
            {plan.fills.map((f) => (
              <Ledger.Row key={f.editionId} edge="none" className="flex-col items-stretch gap-0.5 px-3 py-2 text-sm">
                <span className="block text-text">
                  <span className="font-medium">{f.name}</span>
                  {f.venue && <span className="text-text-muted"> at {f.venue}</span>}
                </span>
                <span className="block text-xs text-text-muted">
                  {label(f.before)} → <span className="text-text">{label(f.after)}</span> ({f.from.map((k) => FROM[k]).join(', ')})
                </span>
              </Ledger.Row>
            ))}
          </Ledger>
        </>
      )}
      {plan && plan.choices.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs uppercase text-text-muted">Venue in more than one place: pick one</h4>
          <Ledger>
            {plan.choices.map((c) => (
              <Ledger.Row key={c.editionId} edge="needs" className="flex-col items-stretch gap-1.5 px-3 py-2 text-sm">
                <span className="block text-text">
                  <span className="font-medium">{c.name}</span>
                  <span className="text-text-muted"> at {c.venue}</span>
                </span>
                <span className="flex flex-wrap gap-2">
                  {c.choices.map((loc) => (
                    <button
                      key={label(loc)}
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void pick(c.editionId, loc)}
                      className="min-h-11 rounded-control border border-line-strong px-2.5 py-1 text-xs text-text hover:bg-surface-2 disabled:opacity-50 sm:min-h-9"
                    >
                      {busy === c.editionId ? 'Filling…' : label(loc)}
                    </button>
                  ))}
                </span>
              </Ledger.Row>
            ))}
          </Ledger>
        </div>
      )}
    </section>
  );
};
