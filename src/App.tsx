import React, { useState, useEffect } from 'react';
import {
  Artist,
  ExtractedEventManifest,
  PopulatedEvent,
  StagingInput,
} from './types/schema';
import { concertStore } from './services/storage';
import { computeHabitTelemetry } from './services/analytics';
import { Navbar, NavTab } from './components/Navbar';
import { EnrichmentForm } from './components/EnrichmentForm';
import { VerificationModal } from './components/VerificationModal';
import { EventsList } from './components/EventsList';
import { AnalyticsView } from './components/AnalyticsView';
import { SupabaseSchemaModal } from './components/SupabaseSchemaModal';
import { SheetsSyncModal } from './components/SheetsSyncModal';
import { SetlistModal } from './components/SetlistModal';
import { MusicBrainzModal } from './components/MusicBrainzModal';
import { CheckCircle2, RotateCcw, Sparkles } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('staging');
  const [events, setEvents] = useState<PopulatedEvent[]>([]);
  const [artists, setArtists] = useState<Artist[]>([]);

  // Verification Modal State
  const [pendingManifest, setPendingManifest] = useState<ExtractedEventManifest | null>(null);
  const [pendingStagingInput, setPendingStagingInput] = useState<StagingInput | null>(null);
  const [isVerificationOpen, setIsVerificationOpen] = useState(false);

  // Setlist Modal State
  const [selectedSetlistEvent, setSelectedSetlistEvent] = useState<PopulatedEvent | null>(null);
  const [isSetlistOpen, setIsSetlistOpen] = useState(false);

  // MusicBrainz Modal State
  const [selectedArtistMbid, setSelectedArtistMbid] = useState<Artist | null>(null);
  const [isMbidModalOpen, setIsMbidModalOpen] = useState(false);

  // Sync Sheets State
  const [syncTargetEvent, setSyncTargetEvent] = useState<PopulatedEvent | null>(null);

  // Toast notification
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 4000);
  };

  const refreshState = () => {
    setEvents(concertStore.getAllEvents());
    setArtists(concertStore.getAllArtists());
  };

  useEffect(() => {
    refreshState();
  }, []);

  const telemetry = computeHabitTelemetry(events);

  // Handle Extraction Output from Gemini
  const handleManifestReady = (manifest: ExtractedEventManifest, stagingInput: StagingInput) => {
    setPendingManifest(manifest);
    setPendingStagingInput(stagingInput);
    setIsVerificationOpen(true);
  };

  // Handle Human-in-the-Loop Commit
  const handleCommitManifest = (
    finalManifest: ExtractedEventManifest,
    extra: {
      ticketPrice?: number;
      seatingTier?: string;
      companions?: string[];
      attendanceStatus?: 'attended' | 'upcoming' | 'wishlist';
      rating?: number;
      isOutdoor?: boolean;
      isFestival?: boolean;
      endDate?: string;
      festivalDays?: import('./types/schema').FestivalDayAttendance[];
    },
  ) => {
    const committed = concertStore.commitManifest(finalManifest, extra);
    refreshState();
    setIsVerificationOpen(false);
    setPendingManifest(null);
    setPendingStagingInput(null);
    showToast(`Committed "${committed.name}" to Supabase Relational Core.`);
    setActiveTab('archive');
  };

  const handleResetData = () => {
    if (
      window.confirm(
        'Reset relational database to initial seeded events (Porter Robinson, Coachella, Kendrick Lamar, etc.)?',
      )
    ) {
      concertStore.resetToDefaults();
      refreshState();
      showToast('Database reset to seeded sample manifest library.');
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 font-sans text-zinc-100 selection:bg-violet-600 selection:text-white flex flex-col">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed top-16 right-4 z-50 flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-zinc-900/95 px-4 py-3 text-xs font-semibold text-emerald-300 shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-top-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Main Navbar */}
      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        eventCount={events.length}
        artistCount={artists.length}
      />

      {/* Main View Container */}
      <main className="mx-auto flex-1 w-full max-w-7xl px-4 py-4 sm:px-6">
        {activeTab === 'staging' && (
          <EnrichmentForm
            onManifestReady={handleManifestReady}
            onViewArchive={() => setActiveTab('archive')}
          />
        )}

        {activeTab === 'archive' && (
          <EventsList
            events={events}
            onSelectSetlist={(evt) => {
              setSelectedSetlistEvent(evt);
              setIsSetlistOpen(true);
            }}
            onSelectArtistMbid={(art) => {
              setSelectedArtistMbid(art);
              setIsMbidModalOpen(true);
            }}
            onSyncSheets={(evt) => {
              setSyncTargetEvent(evt);
              setActiveTab('sheets');
            }}
            onRefresh={refreshState}
            onGoToExtraction={() => setActiveTab('staging')}
          />
        )}

        {activeTab === 'analytics' && (
          <AnalyticsView
            telemetry={telemetry}
            events={events}
            onSelectArtistMbid={(art) => {
              const fullArtist = artists.find((a) => a.id === art.id) || {
                id: art.id,
                name: art.name,
              };
              setSelectedArtistMbid(fullArtist);
              setIsMbidModalOpen(true);
            }}
          />
        )}

        {activeTab === 'supabase' && <SupabaseSchemaModal />}

        {activeTab === 'sheets' && (
          <SheetsSyncModal
            events={events}
            selectedEventForSync={syncTargetEvent}
          />
        )}
      </main>

      {/* Verification Modal (Human-In-The-Loop) */}
      {isVerificationOpen && pendingManifest && pendingStagingInput && (
        <VerificationModal
          isOpen={isVerificationOpen}
          manifest={pendingManifest}
          stagingInput={pendingStagingInput}
          onClose={() => setIsVerificationOpen(false)}
          onCommit={handleCommitManifest}
        />
      )}

      {/* Setlist Modal */}
      {isSetlistOpen && (
        <SetlistModal
          isOpen={isSetlistOpen}
          event={selectedSetlistEvent}
          onClose={() => {
            setIsSetlistOpen(false);
            setSelectedSetlistEvent(null);
          }}
        />
      )}

      {/* Canonical MusicBrainz Modal */}
      {isMbidModalOpen && (
        <MusicBrainzModal
          isOpen={isMbidModalOpen}
          artist={selectedArtistMbid}
          onClose={() => {
            setIsMbidModalOpen(false);
            setSelectedArtistMbid(null);
          }}
          onUpdated={refreshState}
        />
      )}

      {/* Footer */}
      <footer className="mt-auto border-t border-zinc-900 bg-zinc-950 py-6 text-zinc-500 text-xs">
        <div className="mx-auto flex max-w-7xl flex-col sm:flex-row items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-zinc-400">LiveArchive</span>
            <span>·</span>
            <span>Google AI Studio Gemini Grounded Intelligence</span>
            <span>·</span>
            <span>Supabase Relational Core</span>
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={handleResetData}
              className="inline-flex items-center gap-1.5 text-zinc-400 hover:text-zinc-200 transition-colors"
              title="Reset seeded demo dataset"
            >
              <RotateCcw className="h-3 w-3" />
              <span>Reset Seed Data</span>
            </button>
            <span className="text-zinc-700">|</span>
            <span className="font-mono text-[11px] text-zinc-500">
              Dual Persistence Governance Active
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
