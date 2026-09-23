import React, { useState, useEffect } from 'react';
import { X, Search, CheckCircle2, ExternalLink, Globe, Sparkles, AlertCircle } from 'lucide-react';
import { Artist } from '../types/schema';
import { lookupMusicBrainz, MusicBrainzArtistResult } from '../services/api';
import { concertStore } from '../services/storage';

interface MusicBrainzModalProps {
  artist: Artist | null;
  isOpen: boolean;
  onClose: () => void;
  onUpdated: () => void;
}

export const MusicBrainzModal: React.FC<MusicBrainzModalProps> = ({
  artist,
  isOpen,
  onClose,
  onUpdated,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState<MusicBrainzArtistResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (artist) {
      setSearchQuery(artist.name);
      handleSearch(artist.name);
    }
  }, [artist]);

  if (!isOpen || !artist) return null;

  const handleSearch = async (queryToSearch: string) => {
    if (!queryToSearch.trim()) return;
    setIsLoading(true);
    setError(null);
    try {
      const found = await lookupMusicBrainz(queryToSearch);
      setResults(found);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Lookup failed';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectMbid = (selected: MusicBrainzArtistResult) => {
    concertStore.updateArtistMbid(artist.id, selected.id, selected.disambiguation);
    onUpdated();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
      <div className="relative w-full max-w-xl rounded-2xl border border-zinc-700 bg-zinc-900 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-600/20 text-violet-400 border border-violet-500/30">
              <Globe className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Canonical MusicBrainz Resolution</h3>
              <p className="text-xs text-zinc-400">
                Eliminate naming ambiguities & link persistent MBID for {artist.name}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Search Bar */}
        <div className="p-6 space-y-4 max-h-[65vh] overflow-y-auto">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSearch(searchQuery);
            }}
            className="flex items-center gap-2"
          >
            <div className="relative flex-1">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-zinc-500">
                <Search className="h-4 w-4" />
              </div>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search canonical artist on MusicBrainz..."
                className="w-full rounded-xl border border-zinc-700 bg-zinc-950/70 py-2 pl-9 pr-3 text-xs text-zinc-100 placeholder-zinc-500 focus:border-violet-500 focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={isLoading}
              className="rounded-xl bg-violet-600 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-500 transition-colors disabled:opacity-50"
            >
              {isLoading ? 'Querying...' : 'Search'}
            </button>
          </form>

          {/* Current Status */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 text-xs">
            <span className="text-zinc-400">Current Assigned MBID: </span>
            {artist.musicbrainz_id ? (
              <a
                href={`https://musicbrainz.org/artist/${artist.musicbrainz_id}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-violet-400 hover:underline inline-flex items-center gap-1 ml-1"
              >
                <span>{artist.musicbrainz_id}</span>
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : (
              <span className="text-amber-400 font-medium ml-1">Unassigned</span>
            )}
          </div>

          {/* Results List */}
          <div className="space-y-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
              MusicBrainz Candidate Entities:
            </span>

            {isLoading ? (
              <div className="py-8 text-center text-xs text-zinc-400 space-y-2">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-violet-500 border-t-transparent mx-auto" />
                <p>Querying MusicBrainz live registry API...</p>
              </div>
            ) : results.length > 0 ? (
              <div className="space-y-2">
                {results.map((res) => {
                  const isCurrent = artist.musicbrainz_id === res.id;
                  return (
                    <div
                      key={res.id}
                      className={`flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 rounded-xl border p-3 text-xs transition-colors ${
                        isCurrent
                          ? 'border-emerald-500/40 bg-emerald-950/30'
                          : 'border-zinc-800 bg-zinc-950/40 hover:border-zinc-700'
                      }`}
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-white">{res.name}</span>
                          {res.country && (
                            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300">
                              {res.country}
                            </span>
                          )}
                          {res.disambiguation && (
                            <span className="text-[11px] text-zinc-400 italic">
                              ({res.disambiguation})
                            </span>
                          )}
                        </div>
                        <div className="font-mono text-[10px] text-zinc-500">{res.id}</div>
                        {res.tags && res.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 pt-0.5">
                            {res.tags.map((t, idx) => (
                              <span
                                key={idx}
                                className="rounded bg-zinc-900 border border-zinc-800 px-1.5 py-0.2 text-[9px] text-zinc-400"
                              >
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                        <a
                          href={`https://musicbrainz.org/artist/${res.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
                          title="Open on MusicBrainz"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                        <button
                          type="button"
                          onClick={() => handleSelectMbid(res)}
                          disabled={isCurrent}
                          className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                            isCurrent
                              ? 'bg-emerald-900/60 text-emerald-300 cursor-default'
                              : 'bg-violet-600 text-white hover:bg-violet-500'
                          }`}
                        >
                          {isCurrent ? 'Assigned' : 'Assign MBID'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="py-6 text-center text-xs text-zinc-500 space-y-1">
                <AlertCircle className="h-6 w-6 mx-auto text-zinc-600" />
                <p>No exact candidate entities returned from query.</p>
                <p className="text-[11px]">You can refine your search query above.</p>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-zinc-800 bg-zinc-950 px-6 py-3 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
