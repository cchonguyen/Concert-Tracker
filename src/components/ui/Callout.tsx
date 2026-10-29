import { useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Notice, type NoticeTone } from './Notice';

const KEY_PREFIX = 'liveArchive.callout.';

// A dismissible explainer for one page. The dismissal is remembered in this browser only; a failed write just shows it again.
export function Callout({ id, tone = 'info', children }: { id: string; tone?: NoticeTone; children: ReactNode }) {
  const key = `${KEY_PREFIX}${id}`;
  const [gone, setGone] = useState(() => {
    try {
      return window.localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  if (gone) return null;
  const dismiss = () => {
    try {
      window.localStorage.setItem(key, '1');
    } catch {
      // The callout stays hidden for this visit only.
    }
    setGone(true);
  };
  return (
    <div className="relative">
      <Notice tone={tone} className="pr-9">
        {children}
      </Notice>
      <button
        onClick={dismiss}
        aria-label="Dismiss this tip"
        className="absolute right-2 top-2 rounded-md p-1 text-zinc-400 hover:text-zinc-100"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
