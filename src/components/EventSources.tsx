import React from 'react';
import { ExternalLink, Info, MapPin, Tag } from 'lucide-react';
import { Popover } from './ui/Popover';
import type { EditionPerformance, SourceType } from '../server/lineup/types';
import type { EventField } from '../server/events/types';
import { dateConfirmations } from '../services/format';
import { FIELD_SOURCE_LABELS, type LoggedEvent } from '../services/lineupApi';
import { editionUrl, isModifiedClick, rememberManageSearch } from '../services/manageNav';
import { useIsOwner } from './MeContext';
import { SourceIcon } from './ui/SourceIcon';

const FIELD_WORDS: Record<string, string> = {
  name: 'name',
  year: 'year',
  startDate: 'date',
  endDate: 'last day',
  venue: 'venue',
  city: 'city',
  region: 'state',
  country: 'country',
  ticketPrice: 'ticket price',
};

interface SourceEntry {
  key: string;
  kind: 'source' | 'edition' | 'venue';
  sourceType: SourceType | 'edition' | 'venue';
  url?: string;
  fields: string[];
  actKeys: Set<string>;
  timedActKeys: Set<string>;
  quote?: string;
  readBy?: string;
}

export function sourceHighlightKey(source?: LoggedEvent['sources'][keyof LoggedEvent['sources']]): string | null {
  if (!source || source.sourceType === 'user') return null;
  if (source.sourceType === 'edition') return 'edition';
  if (source.sourceType === 'venue' && !source.sourceUrl) return 'venue';
  return source.sourceUrl ?? source.sourceType;
}

interface EventSourcesProps {
  event: LoggedEvent;
  confirmations: ReturnType<typeof dateConfirmations>;
  lineupActs: EditionPerformance[];
  editionId?: string;
  highlightedKey?: string | null;
  // The Check details button, shown beside the heading, and its results (Check details and Deep search).
  action?: React.ReactNode;
  // What Check details and Deep search do, shown from an info icon beside the heading.
  help?: React.ReactNode;
  children?: React.ReactNode;
}

export const EventSources: React.FC<EventSourcesProps> = ({
  event,
  confirmations,
  lineupActs,
  editionId,
  highlightedKey,
  action,
  help,
  children,
}) => {
  const isOwner = useIsOwner();
  const entries = new Map<string, SourceEntry>();

  const ensure = (key: string, init: Omit<SourceEntry, 'key' | 'fields' | 'actKeys' | 'timedActKeys'>): SourceEntry => {
    const existing = entries.get(key);
    if (existing) return existing;
    const created: SourceEntry = {
      key,
      ...init,
      fields: [],
      actKeys: new Set(),
      timedActKeys: new Set(),
    };
    entries.set(key, created);
    return created;
  };

  for (const [fieldKey, src] of Object.entries(event.sources) as Array<[EventField | 'ticketPrice', LoggedEvent['sources'][keyof LoggedEvent['sources']]]>) {
    if (!src || src.sourceType === 'user') continue;
    const key = sourceHighlightKey(src);
    if (!key) continue;
    const entry = ensure(key, {
      kind: src.sourceType === 'edition' ? 'edition' : src.sourceType === 'venue' && !src.sourceUrl ? 'venue' : 'source',
      sourceType: src.sourceType,
      url: src.sourceUrl,
    });
    const word = FIELD_WORDS[fieldKey] ?? fieldKey;
    if (!entry.fields.includes(word)) entry.fields.push(word);
    if (!entry.quote && src.quote) entry.quote = src.quote;
  }

  for (const c of confirmations) {
    const key = c.sourceUrl || c.sourceType;
    const entry = ensure(key, {
      kind: 'source',
      sourceType: c.sourceType,
      url: c.sourceUrl,
      readBy: c.readBy,
    });
    if (!entry.fields.includes('date')) entry.fields.push('date');
    if (!entry.quote && c.quote) entry.quote = c.quote;
    if (!entry.readBy && c.readBy) entry.readBy = c.readBy;
  }

  for (const act of lineupActs) {
    for (const s of act.sources) {
      const key = s.sourceUrl || s.sourceType;
      const readBy = s.extractor?.startsWith('gemini') ? 'gemini' : undefined;
      const entry = ensure(key, {
        kind: 'source',
        sourceType: s.sourceType,
        url: s.sourceUrl,
        readBy,
      });
      entry.actKeys.add(act.artistKey);
      if (s.sets && s.sets.length > 0) entry.timedActKeys.add(act.artistKey);
      if (!entry.quote && s.quotedSpan) entry.quote = s.quotedSpan;
      if (!entry.readBy && readBy) entry.readBy = readBy;
    }
  }

  const list = Array.from(entries.values());

  return (
    <section id="event-sources" className="space-y-3 rounded-card border border-line bg-surface-1 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-0.5">
          <h3 className="font-display text-lg font-normal text-text">Where every detail came from</h3>
          {help && (
            <Popover label="About where every detail came from" content={<div className="max-w-xs space-y-2 text-xs leading-relaxed text-text">{help}</div>}>
              <span className="flex h-9 w-9 items-center justify-center rounded-control text-text-muted hover:text-text sm:h-7 sm:w-7">
                <Info className="h-4 w-4" aria-hidden="true" />
              </span>
            </Popover>
          )}
        </div>
        {action}
      </div>
      {children}
      {list.length === 0 ? (
        <p className="text-xs text-text-muted">Nothing here came from a source yet. What you typed is kept as you typed it.</p>
      ) : (
        <ul className="space-y-2">
          {list.map((entry) => {
            const gaveParts: string[] = [...entry.fields];
            if (entry.actKeys.size > 0) {
              gaveParts.push(`${entry.actKeys.size} act${entry.actKeys.size === 1 ? '' : 's'}`);
            }
            if (entry.timedActKeys.size > 0) {
              gaveParts.push(`set times for ${entry.timedActKeys.size} act${entry.timedActKeys.size === 1 ? '' : 's'}`);
            }
            const highlighted = highlightedKey === entry.key;

            return (
              // Phones: the source and its link share a line, with what it gave below. Once the card is wide
              // enough: three columns, the source, what it gave, and its link.
              <li
                key={entry.key}
                className={`grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1.5 rounded-control border p-3 text-xs @[760px]:grid-cols-[11rem_minmax(0,1fr)_auto] ${
                  highlighted ? 'border-accent-tint-line bg-accent-tint' : 'border-line bg-surface-2'
                }`}
              >
                <div className="font-medium text-text">
                  {entry.kind === 'edition' ? (
                    <span className="inline-flex items-center gap-1">
                      <Tag className="h-3 w-3 shrink-0 text-text-muted" aria-hidden="true" />
                      <span>{FIELD_SOURCE_LABELS.edition}</span>
                    </span>
                  ) : entry.kind === 'venue' ? (
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="h-3 w-3 shrink-0 text-text-muted" aria-hidden="true" />
                      <span>{FIELD_SOURCE_LABELS.venue}</span>
                    </span>
                  ) : (
                    <SourceIcon source={entry.sourceType as SourceType} readBy={entry.readBy} />
                  )}
                </div>

                <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 @[760px]:col-start-3 @[760px]:row-start-1">
                  {entry.kind === 'edition' && isOwner && editionId && (
                    <a
                      href={editionUrl(editionId)}
                      onClick={(e) => {
                        if (isModifiedClick(e)) return;
                        e.preventDefault();
                        const url = editionUrl(editionId);
                        window.history.pushState({ fromManageList: false }, '', url);
                        rememberManageSearch(new URL(url, window.location.origin).search);
                        window.dispatchEvent(new PopStateEvent('popstate'));
                      }}
                      className="inline-flex items-center gap-1 text-text-muted hover:text-accent hover:underline"
                    >
                      Open edition
                    </a>
                  )}

                  {entry.url && (
                    <a
                      href={entry.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-text-muted hover:text-accent hover:underline"
                    >
                      Source <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  )}
                </div>

                {(gaveParts.length > 0 || entry.quote) && (
                  <div className="col-span-2 min-w-0 space-y-1.5 @[760px]:col-span-1 @[760px]:col-start-2 @[760px]:row-start-1">
                    {gaveParts.length > 0 && (
                      <p className="text-text-muted">
                        <span className="font-medium text-text">Gave:</span> {gaveParts.join(', ')}
                      </p>
                    )}

                    {entry.quote && (
                      <blockquote className="line-clamp-3 font-display text-[13px] italic leading-snug text-text">
                        “{entry.quote}”
                      </blockquote>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
