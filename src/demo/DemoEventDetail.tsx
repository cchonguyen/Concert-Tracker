import { useState } from 'react';
import type { LoggedEvent } from '../server/events/types';
import { Dialog } from '../components/ui/Dialog';
import { DemoPrompt } from './DemoPrompt';

// The event screen in the demo. It is read-only: the app's EventDetail still
// asks the server for lineups and places when it opens, so the demo shows the
// same facts without that call. Every action opens a short explainer instead.
export function DemoEventDetail({ event, onClose }: { event: LoggedEvent; onClose: () => void }) {
  const [prompt, setPrompt] = useState<string | null>(null);
  const when = [event.startDate, event.endDate].filter(Boolean).join(' to ');
  const where = [event.venue, event.city, event.region].filter(Boolean).join(', ');
  const quote = event.sources.startDate?.quote;
  const source = event.sources.startDate?.sourceUrl;
  return (
    <section aria-label="Event detail (sample)" className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4 text-zinc-100">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{event.name}</h2>
          <p className="text-sm text-zinc-400">{when || 'Date not known'}</p>
          <p className="text-sm text-zinc-400">{where || 'Venue not known'}</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm">
          Back
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setPrompt('lookup')} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm">
          Look up lineup
        </button>
        <button type="button" onClick={() => setPrompt('share')} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm">
          Share
        </button>
        <button type="button" onClick={() => setPrompt('edit')} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm">
          Edit
        </button>
      </div>

      <div>
        <h3 className="mb-1 text-sm font-semibold text-zinc-300">Acts you saw</h3>
        <ul className="space-y-1 text-sm">
          {event.seen.map((a) => (
            <li key={a.key}>
              {a.favourite ? '★ ' : ''}
              {a.name}
              {a.role === 'headliner' ? ' · headliner' : a.role === 'support' ? ' · support' : ''}
              {a.set === 'dj' ? ' · DJ set' : ''}
              {a.b2b?.length ? ' · B2B' : ''}
            </li>
          ))}
        </ul>
      </div>

      {quote && (
        <blockquote className="rounded-lg border-l-2 border-violet-400 bg-zinc-900 px-3 py-2 text-sm text-zinc-300">
          “{quote}”
          {source && (
            <a className="mt-1 block text-xs text-violet-300" href={source} target="_blank" rel="noreferrer">
              Read at the source
            </a>
          )}
        </blockquote>
      )}

      {event.companions.length > 0 && <p className="text-sm text-zinc-400">Went with: {event.companions.join(', ')}</p>}
      {event.rating !== undefined && <p className="text-sm text-zinc-400">Rating: {event.rating} / 5</p>}
      {event.notes && <p className="text-sm text-zinc-400">Notes: {event.notes}</p>}
      {event.weather && (
        <p className="text-sm text-zinc-400">
          Weather at {event.weather.place}: {event.weather.days.map((d) => `${d.high}°C / ${d.low}°C`).join(', ')}
        </p>
      )}

      {prompt && (
        <Dialog title="Sample data" onClose={() => setPrompt(null)}>
          <DemoPrompt action={prompt} onBack={() => setPrompt(null)} />
        </Dialog>
      )}
    </section>
  );
}
