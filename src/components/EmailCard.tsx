import React, { useState } from 'react';
import { Mail } from 'lucide-react';
import { copy } from '../services/copy';
import { Button } from './ui/Button';
import { Notice } from './ui/Notice';

const { emailCard } = copy;

// The Home card for the ticket email check. The steps and the privacy list are copied from copy.ts and must match the code.
export const EmailCard: React.FC<{ waiting: number; onCheck: () => void }> = ({ waiting, onCheck }) => {
  const [open, setOpen] = useState(false);
  return (
    <section className="space-y-4 rounded-card border border-accent-tint-line bg-accent-tint p-5">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-accent">{emailCard.eyebrow}</p>
        <h2 className="poster-head text-2xl text-text">{emailCard.title}</h2>
        <p className="text-sm text-text-muted">{emailCard.line}</p>
        <ul className="flex flex-wrap gap-2 pt-1">
          {emailCard.badges.map((b) => (
            <li key={b} className="rounded-full border border-line-strong px-2.5 py-0.5 text-xs text-text-muted">
              {b}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={onCheck}>
          <Mail className="h-3.5 w-3.5" /> Check my email
        </Button>
        <Button variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          How it works
        </Button>
        {waiting > 0 && <p className="text-xs text-warn">{waiting === 1 ? '1 show waiting for you to review.' : `${waiting} shows waiting for you to review.`}</p>}
      </div>

      {open && (
        <div className="space-y-4 border-t border-line pt-4 text-sm text-text-muted">
          <ol className="list-decimal space-y-3 pl-5">
            <li>{emailCard.steps[0]}</li>
            <li>
              <Notice tone="warning">{emailCard.warning}</Notice>
            </li>
            <li>{emailCard.steps[1]}</li>
            <li>{emailCard.steps[2]}</li>
          </ol>

          <details open className="space-y-2">
            <summary className="cursor-pointer font-semibold text-text">What&rsquo;s saved</summary>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">Saved to your LiveArchive</h3>
                <ul className="list-disc space-y-1 pl-5">
                  {emailCard.savedHere.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">Never leaves your browser</h3>
                <ul className="list-disc space-y-1 pl-5">
                  {emailCard.neverLeaves.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </div>
            </div>
          </details>

          <ul className="list-disc space-y-1 pl-5 text-xs text-text-muted">
            {emailCard.smallPrint.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
};
