import { useState } from 'react';
import { lineupAnnouncement, lineupSteps } from '../services/lineupProgress';
import type { LookupJob } from '../server/lineup/types';
import { Button } from './ui/Button';
import { Stepper } from './ui/Stepper';

const HEADLINE: Partial<Record<LookupJob['status'], string>> = {
  queued: 'Looking through sources',
  running: 'Looking through sources',
  failed: 'The lookup failed',
  no_data: 'No source listed a lineup',
};

// The card for a lineup lookup in progress or waiting for you. Polling stays in the caller.
export function LineupProgress({ job, busy, onRetry, onReview }: { job: LookupJob; busy: boolean; onRetry: () => void; onReview: () => void }) {
  const [showLog, setShowLog] = useState(false);
  const steps = lineupSteps(job);
  const acts = job.candidate?.performers.length ?? 0;
  const headline =
    job.status === 'needs_review'
      ? `Ready to review · ${acts} acts`
      : job.status === 'waiting_quota'
        ? (job.waitingReason ?? 'Paused: waiting for capacity.')
        : (HEADLINE[job.status] ?? '');

  return (
    <div className="space-y-3 rounded-card border border-line p-3">
      <div className="space-y-0.5">
        <p className="text-sm font-semibold text-text">{headline}</p>
        <p className="text-xs text-text-muted">Find the lineup reads the sources and cites every act. You can close this; it keeps going.</p>
      </div>
      {job.status === 'waiting_quota' && (
        <p className="rounded-control border border-warn/45 bg-warn/10 p-2 text-xs text-warn">
          Continues on its own{job.nextAttemptAt ? ` after ${new Date(job.nextAttemptAt).toLocaleString()}` : ''}. Nothing found is lost.
        </p>
      )}
      <Stepper steps={steps} label="Lineup lookup steps" />
      {acts > 0 && job.status !== 'needs_review' && <p className="text-xs text-text-muted">{acts} acts found so far.</p>}
      <p role="status" aria-live="polite" className="sr-only">
        {lineupAnnouncement(steps)}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {(job.status === 'needs_review' || job.status === 'no_data') && (
          <Button variant="primary" onClick={onReview}>
            {job.status === 'no_data' ? 'Enter acts by hand' : 'Review lineup'}
          </Button>
        )}
        {(job.status === 'waiting_quota' || job.status === 'failed') && (
          <Button onClick={onRetry} disabled={busy}>
            {job.status === 'waiting_quota' ? 'Try now' : 'Look it up again'}
          </Button>
        )}
        <Button variant="ghost" onClick={() => setShowLog((s) => !s)} aria-expanded={showLog}>
          {showLog ? 'Hide' : 'Show'} what it did
        </Button>
      </div>
      {showLog && (
        <ol className="max-h-60 space-y-1 overflow-y-auto text-xs text-text-muted">
          {job.log.map((entry, i) => (
            <li key={i}>{entry.message}</li>
          ))}
        </ol>
      )}
    </div>
  );
}
