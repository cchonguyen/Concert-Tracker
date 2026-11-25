import type { LucideIcon } from 'lucide-react';
import { Archive, CalendarRange, ClipboardPaste, Globe, ListMusic, Mail, Megaphone, Music, Ticket, Tag, User } from 'lucide-react';
import type { SourceType } from '../../server/lineup/types';
import { SOURCE_LABELS } from '../../services/lineupApi';

// One small glyph per source, so a candidate's sources read at a glance. The name
// is always written next to it, so the icon never carries the meaning alone.
const ICONS: Record<SourceType, LucideIcon> = {
  clashfinder: CalendarRange,
  ticketmaster: Ticket,
  setlistfm: ListMusic,
  musicbrainz: Music,
  discovered: Globe,
  promoter: Megaphone,
  wayback: Archive,
  email: Mail,
  user: User,
  'edition name': Tag,
  pasted: ClipboardPaste,
};

// A source's glyph and name, with its label as the tooltip. Pass `readBy` to add
// "(read by AI)" the way the candidate lists already do.
export function SourceIcon({ source, readBy }: { source: SourceType; readBy?: string }) {
  const Icon = ICONS[source] ?? Globe;
  const label = SOURCE_LABELS[source] ?? source;
  const suffix = readBy === 'gemini' ? ' (read by AI)' : '';
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap" title={`${label}${suffix}`}>
      <Icon className="h-3 w-3 shrink-0 text-text-muted" aria-hidden="true" />
      <span>{label}{suffix}</span>
    </span>
  );
}
