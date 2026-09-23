import React from 'react';
import { X, Disc, ExternalLink, Music, Sparkles } from 'lucide-react';
import { PopulatedEvent } from '../types/schema';

interface SetlistModalProps {
  event: PopulatedEvent | null;
  isOpen: boolean;
  onClose: () => void;
}

export const SetlistModal: React.FC<SetlistModalProps> = ({ event, isOpen, onClose }) => {
  if (!isOpen || !event) return null;

  const setlist = event.setlist_tracks || [];
  const headliner =
    event.appearances.find((a) => a.billing_role === 'headliner')?.artist.name ||
    event.name;

  const setlistFmSearchUrl = `https://www.setlist.fm/search?query=${encodeURIComponent(
    `${headliner} ${event.venue.name} ${event.event_date}`,
  )}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
      <div className="relative w-full max-w-lg rounded-2xl border border-zinc-700 bg-zinc-900 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-600/20 text-violet-400 border border-violet-500/30">
              <Disc className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Setlist Manifest</h3>
              <p className="text-xs text-zinc-400">{event.name}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
          <div className="flex items-center justify-between text-xs text-zinc-400 border-b border-zinc-800/80 pb-3">
            <div>
              <span className="font-medium text-zinc-300">{event.venue.name}</span> ·{' '}
              <span>{event.event_date}</span>
            </div>
            <a
              href={setlistFmSearchUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-violet-400 hover:underline text-[11px]"
            >
              <span>Setlist.fm Record</span>
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>

          {setlist.length > 0 ? (
            <div className="space-y-1.5">
              {setlist.map((track) => (
                <div
                  key={track.order}
                  className={`flex items-center justify-between rounded-lg px-3 py-2 text-xs border ${
                    track.isEncore
                      ? 'border-violet-800/60 bg-violet-950/30 text-violet-200'
                      : 'border-zinc-800/80 bg-zinc-950/60 text-zinc-200'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <span className="font-mono text-[11px] text-zinc-500 w-5 text-right">
                      {track.order}.
                    </span>
                    <span className="font-medium">{track.title}</span>
                    {track.isCover && (
                      <span className="rounded bg-amber-950/60 border border-amber-500/30 px-1.5 py-0.5 text-[9px] font-semibold text-amber-300">
                        Cover {track.originalArtist ? `(${track.originalArtist})` : ''}
                      </span>
                    )}
                  </div>
                  {track.isEncore && (
                    <span className="rounded bg-violet-900/60 px-1.5 py-0.5 text-[10px] font-semibold text-violet-300">
                      Encore
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 space-y-2">
              <Music className="h-8 w-8 text-zinc-600 mx-auto" />
              <p className="text-xs text-zinc-400">
                Detailed track-by-track setlist is being aggregated or not yet publicly confirmed for this date.
              </p>
              <a
                href={setlistFmSearchUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-violet-700/50 bg-violet-950/40 px-3 py-1.5 text-xs text-violet-300 hover:bg-violet-900/40 transition-colors"
              >
                <span>Search Community Setlists on Setlist.fm</span>
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-zinc-800 bg-zinc-950 px-6 py-3 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
