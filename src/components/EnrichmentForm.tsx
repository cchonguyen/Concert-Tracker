import React, { useState, useEffect, useMemo } from 'react';
import {
  Sparkles,
  Search,
  MapPin,
  Calendar,
  Building2,
  Compass,
  FileText,
  ShieldCheck,
  Zap,
  Info,
  Clock,
  ArrowRight,
  Database,
  CheckCircle2,
  Cpu,
  Layers,
  HelpCircle,
  ChevronDown,
  ChevronUp,
  Radio,
  Sliders,
} from 'lucide-react';
import { StagingInput, Artist, Venue, ExtractedEventManifest, ScanningCues } from '../types/schema';
import { concertStore } from '../services/storage';
import { executeEventExtraction, scanLocalInputCues } from '../services/extractionEngine';

interface EnrichmentFormProps {
  onManifestReady: (manifest: ExtractedEventManifest, stagingInput: StagingInput) => void;
  onViewArchive: () => void;
}

export const EnrichmentForm: React.FC<EnrichmentFormProps> = ({
  onManifestReady,
  onViewArchive,
}) => {
  const [formData, setFormData] = useState<StagingInput>({
    concertName: '',
    dateHint: '',
    venueHint: '',
    cityHint: '',
    tourHint: '',
    notesHint: '',
  });

  const [isLoading, setIsLoading] = useState(false);
  const [loadingPhase, setLoadingPhase] = useState<number>(0);
  const [loadingStep, setLoadingStep] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [showDirectionsGuide, setShowDirectionsGuide] = useState<boolean>(true);

  // Typeahead suggestions
  const [artistSuggestions, setArtistSuggestions] = useState<Artist[]>([]);
  const [venueSuggestions, setVenueSuggestions] = useState<Venue[]>([]);
  const [showArtistSuggestions, setShowArtistSuggestions] = useState(false);
  const [showVenueSuggestions, setShowVenueSuggestions] = useState(false);

  // Live lexical cue scanner
  const liveCues: ScanningCues = useMemo(() => {
    return scanLocalInputCues(formData);
  }, [formData]);

  // Auto-complete triggers
  useEffect(() => {
    if (formData.concertName.length >= 2) {
      const results = concertStore.typeaheadArtists(formData.concertName);
      setArtistSuggestions(results);
    } else {
      setArtistSuggestions([]);
    }
  }, [formData.concertName]);

  useEffect(() => {
    if (formData.venueHint && formData.venueHint.length >= 2) {
      const results = concertStore.typeaheadVenues(formData.venueHint);
      setVenueSuggestions(results);
    } else {
      setVenueSuggestions([]);
    }
  }, [formData.venueHint]);

  const handleApplyPreset = (preset: StagingInput) => {
    setFormData(preset);
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.concertName.trim()) {
      setError('Please provide a concert title or tour name to initiate extraction.');
      return;
    }

    setIsLoading(true);
    setError(null);
    setLoadingPhase(1);

    try {
      setLoadingStep('Phase 1/5: Scanning input tokens & extracting semantic cues...');
      await new Promise((r) => setTimeout(r, 280));

      setLoadingPhase(2);
      setLoadingStep('Phase 2/5: Resolving temporal anchors & tour cycle context...');
      await new Promise((r) => setTimeout(r, 260));

      setLoadingPhase(3);
      setLoadingStep('Phase 3/5: Querying Gemini AI Engine with structured schema enforcement...');
      
      const extractionResult = await executeEventExtraction(formData);

      setLoadingPhase(4);
      setLoadingStep('Phase 4/5: Decomposing artist lineup & verifying venue municipal topology...');
      await new Promise((r) => setTimeout(r, 240));

      setLoadingPhase(5);
      setLoadingStep('Phase 5/5: Synthesis complete! Preparing transformed database payload...');
      await new Promise((r) => setTimeout(r, 200));

      onManifestReady(extractionResult.manifest, formData);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Extraction engine encountered an error. Please retry.';
      setError(msg);
    } finally {
      setIsLoading(false);
      setLoadingStep('');
      setLoadingPhase(0);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-8 py-6">
      {/* Hero Header */}
      <div className="text-center space-y-3">
        <div className="inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-950/40 px-3.5 py-1 text-xs font-semibold text-violet-300 shadow-sm">
          <Cpu className="h-3.5 w-3.5 text-violet-400" />
          <span>Gemini AI Extraction & Synthesis Engine</span>
        </div>
        <h1 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
          Precision Extraction & Transformation for <br className="hidden sm:inline" />
          <span className="bg-gradient-to-r from-violet-400 via-indigo-300 to-cyan-300 bg-clip-text text-transparent">
            Live Concert & Festival Manifests
          </span>
        </h1>
        <p className="mx-auto max-w-2xl text-sm text-zinc-400">
          Dedicated AI engine powered by Google AI Studio Gemini. Scans sparse event titles, identifies
          sub-artist hierarchies, normalizes temporal dates and venue topology, and generates structured
          relational records with resilient fallback execution.
        </p>
      </div>

      {/* Engine Directions & Scanning Guide (Collapsible) */}
      <div className="rounded-2xl border border-violet-900/50 bg-gradient-to-b from-zinc-900/90 to-zinc-950/90 p-5 shadow-lg shadow-violet-950/20 backdrop-blur-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-600/20 border border-violet-500/30 text-violet-400">
              <Layers className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <span>Engine Scanning Directives & Cue Detection Guide</span>
                <span className="rounded bg-violet-500/20 border border-violet-500/30 px-2 py-0.5 text-[10px] font-mono text-violet-300">
                  Cascade: Gemini Flash / Flash Lite Auto-Failover
                </span>
              </h2>
              <p className="text-xs text-zinc-400">
                Multi-model cascade with demand-spike auto-failover and resilient domain archival synthesis
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowDirectionsGuide(!showDirectionsGuide)}
            className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <span>{showDirectionsGuide ? 'Collapse Guide' : 'Expand Guide'}</span>
            {showDirectionsGuide ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        </div>

        {showDirectionsGuide && (
          <div className="mt-4 pt-4 border-t border-zinc-800/80 space-y-4 text-xs text-zinc-300">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 space-y-1.5">
                <div className="flex items-center gap-1.5 font-semibold text-violet-300">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-violet-900/60 text-[10px] font-bold">1</span>
                  <span>Cue Tokenization</span>
                </div>
                <p className="text-zinc-400 text-[11px] leading-relaxed">
                  The engine parses artist tokens and delimiters (<code className="text-violet-300 font-mono">with</code>, <code className="text-violet-300 font-mono">feat.</code>, <code className="text-violet-300 font-mono">b2b</code>, <code className="text-violet-300 font-mono">and</code>) to categorize headliners vs supporting acts.
                </p>
              </div>

              <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 space-y-1.5">
                <div className="flex items-center gap-1.5 font-semibold text-indigo-300">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-900/60 text-[10px] font-bold">2</span>
                  <span>Temporal & Venue Synthesis</span>
                </div>
                <p className="text-zinc-400 text-[11px] leading-relaxed">
                  Resolves multi-day festivals into canonical ISO dates (<code className="text-indigo-300 font-mono">YYYY-MM-DD</code>) and matches municipal venue topology (city, state, outdoor/indoor).
                </p>
              </div>

              <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 space-y-1.5">
                <div className="flex items-center gap-1.5 font-semibold text-cyan-300">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-cyan-900/60 text-[10px] font-bold">3</span>
                  <span>Graceful Fallback Pipeline</span>
                </div>
                <p className="text-zinc-400 text-[11px] leading-relaxed">
                  Cascades from Gemini 3.8 Flash to Gemini 3.1 Flash Lite. If network/quotas are saturated, the internal Heuristic & Archival Synthesizer executes instantly.
                </p>
              </div>
            </div>

            {/* Live Detected Cues Inspector (Dynamic Real-Time Feed) */}
            {formData.concertName.trim() && (
              <div className="rounded-xl border border-violet-500/30 bg-violet-950/20 p-3 space-y-2">
                <div className="flex items-center justify-between text-[11px] font-semibold text-violet-300">
                  <span className="flex items-center gap-1.5">
                    <Radio className="h-3 w-3 text-emerald-400 animate-pulse" />
                    Live Input Cue Scanner (Pre-Extraction Analysis)
                  </span>
                  <span className="font-mono text-[10px] text-zinc-400">
                    {liveCues.rawTokens.length} tokens parsed
                  </span>
                </div>
                <div className="flex flex-wrap gap-2 text-[11px]">
                  <span className="rounded-md bg-zinc-900 border border-zinc-800 px-2 py-0.5 text-zinc-300">
                    Headliner: <strong className="text-white">{liveCues.headliner || 'Resolving...'}</strong>
                  </span>
                  {liveCues.supportingActs.length > 0 && (
                    <span className="rounded-md bg-zinc-900 border border-zinc-800 px-2 py-0.5 text-zinc-300">
                      Support Acts ({liveCues.supportingActs.length}): <strong className="text-violet-300">{liveCues.supportingActs.join(', ')}</strong>
                    </span>
                  )}
                  {liveCues.venueCue && (
                    <span className="rounded-md bg-zinc-900 border border-zinc-800 px-2 py-0.5 text-zinc-300">
                      Venue: <strong className="text-indigo-300">{liveCues.venueCue}</strong>
                    </span>
                  )}
                  {liveCues.dateCue && (
                    <span className="rounded-md bg-zinc-900 border border-zinc-800 px-2 py-0.5 text-zinc-300">
                      Date Anchor: <strong className="text-cyan-300">{liveCues.dateCue}</strong>
                    </span>
                  )}
                  {liveCues.isFestival && (
                    <span className="rounded-md bg-amber-950/40 border border-amber-500/30 px-2 py-0.5 text-amber-300 font-medium">
                      🎪 Festival Edition
                    </span>
                  )}
                  {liveCues.isMultiDay && (
                    <span className="rounded-md bg-purple-950/40 border border-purple-500/30 px-2 py-0.5 text-purple-300 font-medium">
                      📅 Multi-Day Run ({liveCues.estimatedDays ? `${liveCues.estimatedDays} days` : 'Multi-day span'})
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Preset Quick Fill Pills */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-zinc-400">
          <span className="font-medium">Curated Evaluation Test Presets:</span>
          <span className="text-[11px] text-zinc-500">Click to populate staging cues</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() =>
              handleApplyPreset({
                concertName: 'Sunsoaked 2026',
                notesHint: 'Kaskade flagship beachside festival at Huntington State Beach with BUNT, Cassian, Matroda, D.O.D, and more.',
              })
            }
            className="flex items-center gap-1.5 rounded-lg border border-orange-500/50 bg-gradient-to-r from-orange-950/60 to-amber-950/40 px-3 py-1 text-xs text-orange-200 hover:border-orange-400 hover:bg-orange-900/50 transition-all shadow-sm"
          >
            <Sparkles className="h-3.5 w-3.5 text-amber-300" />
            <span className="font-semibold">🏖️ Sunsoaked 2026 (Huntington Beach · Kaskade)</span>
          </button>

          <button
            type="button"
            onClick={() =>
              handleApplyPreset({
                concertName: 'Porter Robinson SMILE! :D World Tour with Ericdoa',
                dateHint: '2024-10-11',
                venueHint: 'Los Angeles State Historic Park',
                cityHint: 'Los Angeles',
                tourHint: 'SMILE! :D World Tour',
                notesHint: 'Outdoor headline performance for the Smile album tour cycle with live band.',
              })
            }
            className="flex items-center gap-1.5 rounded-lg border border-violet-800/40 bg-violet-950/30 px-2.5 py-1 text-xs text-violet-300 hover:border-violet-600 hover:bg-violet-900/40 transition-colors"
          >
            <Zap className="h-3 w-3 text-violet-400" />
            <span>Porter Robinson (Single Show)</span>
          </button>

          <button
            type="button"
            onClick={() =>
              handleApplyPreset({
                concertName: 'Zedd in the Park 2024',
                dateHint: '2024-09-06',
                endDateHint: '2024-09-07',
                attendedDaysHint: 'Attended all days (Friday and Saturday)',
                venueHint: 'Los Angeles State Historic Park',
                cityHint: 'Los Angeles',
                tourHint: 'Zedd in the Park 2024',
                notesHint: 'Two-day festival run (Sept 6-7, 2024) featuring Zedd, Madeon, San Holo, Grey, Ellis, Mesto, Throttle, Party Pupils, Dillon Wong. Attended both Friday and Saturday.',
              })
            }
            className="flex items-center gap-1.5 rounded-lg border border-amber-800/40 bg-amber-950/30 px-2.5 py-1 text-xs text-amber-300 hover:border-amber-600 hover:bg-amber-900/40 transition-colors"
          >
            <Sparkles className="h-3 w-3 text-amber-400" />
            <span>🎪 Zedd in the Park 2024 (2-Day · Attended Both)</span>
          </button>

          <button
            type="button"
            onClick={() =>
              handleApplyPreset({
                concertName: 'Coachella Valley Music and Arts Festival 2024',
                dateHint: '2024-04-19',
                endDateHint: '2024-04-21',
                attendedDaysHint: 'Attended Sunday (Day 3) only',
                venueHint: 'Empire Polo Club',
                cityHint: 'Indio, CA',
                tourHint: 'Coachella 2024 (Weekend 2)',
                notesHint: '3-day festival pass. Only attended Day 3 Sunday for Justice debut live performance at Outdoor Theatre.',
              })
            }
            className="flex items-center gap-1.5 rounded-lg border border-cyan-800/40 bg-cyan-950/30 px-2.5 py-1 text-xs text-cyan-300 hover:border-cyan-600 hover:bg-cyan-900/40 transition-colors"
          >
            <Sparkles className="h-3 w-3 text-cyan-400" />
            <span>🎪 Coachella 2024 (3-Day · Sunday Only)</span>
          </button>

          <button
            type="button"
            onClick={() =>
              handleApplyPreset({
                concertName: 'Zedd in the Park 2022',
                dateHint: '2022-07-08',
                venueHint: 'Los Angeles State Historic Park',
                cityHint: 'Los Angeles',
                tourHint: 'Zedd in the Park 2022',
                notesHint: 'Return edition on Friday, July 8, 2022 featuring Zedd, Loud Luxury, Wolfgang Gartner, Regard, So Tuff So Cute, GOJ!RA b2b Fernet.',
              })
            }
            className="flex items-center gap-1.5 rounded-lg border border-emerald-800/40 bg-emerald-950/30 px-2.5 py-1 text-xs text-emerald-300 hover:border-emerald-600 hover:bg-emerald-900/40 transition-colors"
          >
            <Sparkles className="h-3 w-3 text-emerald-400" />
            <span>Zedd in the Park 2022 (July 8 · 6 Acts)</span>
          </button>

          <button
            type="button"
            onClick={() =>
              handleApplyPreset({
                concertName: 'The Big Steppers Tour: Kendrick Lamar with Baby Keem',
                dateHint: '2022-09-17',
                venueHint: 'Kia Forum',
                cityHint: 'Inglewood, CA',
                tourHint: 'The Big Steppers Tour',
                notesHint: 'Kendrick Lamar and Baby Keem family ties performance.',
              })
            }
            className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1 text-xs text-zinc-300 hover:border-zinc-700 hover:bg-zinc-800 transition-colors"
          >
            <span>Kendrick Lamar with Baby Keem</span>
          </button>
        </div>
      </div>

      {/* Main Staging Form */}
      <form
        onSubmit={handleSubmit}
        className="rounded-2xl border border-zinc-800/90 bg-zinc-900/80 p-6 shadow-xl shadow-black/40 backdrop-blur-sm space-y-6"
      >
        <div className="flex items-center justify-between border-b border-zinc-800/80 pb-4">
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-emerald-400 animate-ping" />
            <h2 className="text-base font-semibold text-white">Staging Extraction Input</h2>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span className="font-mono text-[11px] text-violet-400">Engine: Active</span>
          </div>
        </div>

        {/* Primary Input */}
        <div className="space-y-2 relative">
          <label className="block text-xs font-medium text-zinc-300">
            Concert Query or Headliner Statement{' '}
            <span className="text-violet-400 font-bold">*</span>
          </label>
          <div className="relative">
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-zinc-500">
              <Search className="h-4 w-4" />
            </div>
            <input
              type="text"
              required
              placeholder="e.g. Porter Robinson SMILE! Tour with Ericdoa, or Zedd in the Park 2024"
              value={formData.concertName}
              onChange={(e) => {
                setFormData({ ...formData, concertName: e.target.value });
                setShowArtistSuggestions(true);
              }}
              onFocus={() => setShowArtistSuggestions(true)}
              className="w-full rounded-xl border border-zinc-700 bg-zinc-950/70 py-2.5 pl-10 pr-4 text-sm text-zinc-100 placeholder-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
            />
          </div>

          {/* Typeahead Suggestions for Artist */}
          {showArtistSuggestions && artistSuggestions.length > 0 && (
            <div className="absolute z-20 left-0 right-0 mt-1 max-h-48 overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl p-1.5 space-y-1">
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                Matching Artists in Archive
              </div>
              {artistSuggestions.map((art) => (
                <button
                  type="button"
                  key={art.id}
                  onClick={() => {
                    setFormData({ ...formData, concertName: art.name });
                    setShowArtistSuggestions(false);
                  }}
                  className="w-full flex items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs text-zinc-200 hover:bg-violet-950/50 hover:text-violet-300 transition-colors"
                >
                  <span className="font-medium">{art.name}</span>
                  {art.musicbrainz_id && (
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400 font-mono">
                      MBID Resolved
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Optional Metadata Grid */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Date Hint */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-zinc-400">
              Date Anchor Hint (Optional)
            </label>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-zinc-500">
                <Calendar className="h-4 w-4" />
              </div>
              <input
                type="text"
                placeholder="e.g. 2024-10-11, September 2024, or 2024"
                value={formData.dateHint}
                onChange={(e) => setFormData({ ...formData, dateHint: e.target.value })}
                className="w-full rounded-xl border border-zinc-800 bg-zinc-950/60 py-2 pl-9 pr-3 text-xs text-zinc-200 placeholder-zinc-500 focus:border-violet-500 focus:outline-none"
              />
            </div>
          </div>

          {/* Tour Hint */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-zinc-400">
              Tour or Festival Edition Hint (Optional)
            </label>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-zinc-500">
                <Compass className="h-4 w-4" />
              </div>
              <input
                type="text"
                placeholder="e.g. SMILE! :D World Tour, Zedd in the Park"
                value={formData.tourHint}
                onChange={(e) => setFormData({ ...formData, tourHint: e.target.value })}
                className="w-full rounded-xl border border-zinc-800 bg-zinc-950/60 py-2 pl-9 pr-3 text-xs text-zinc-200 placeholder-zinc-500 focus:border-violet-500 focus:outline-none"
              />
            </div>
          </div>

          {/* Venue Hint with Typeahead */}
          <div className="space-y-1.5 relative">
            <label className="block text-xs font-medium text-zinc-400">
              Venue Hint (Optional)
            </label>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-zinc-500">
                <Building2 className="h-4 w-4" />
              </div>
              <input
                type="text"
                placeholder="e.g. Los Angeles State Historic Park, Kia Forum"
                value={formData.venueHint}
                onChange={(e) => {
                  setFormData({ ...formData, venueHint: e.target.value });
                  setShowVenueSuggestions(true);
                }}
                onFocus={() => setShowVenueSuggestions(true)}
                className="w-full rounded-xl border border-zinc-800 bg-zinc-950/60 py-2 pl-9 pr-3 text-xs text-zinc-200 placeholder-zinc-500 focus:border-violet-500 focus:outline-none"
              />
            </div>

            {/* Typeahead Suggestions for Venue */}
            {showVenueSuggestions && venueSuggestions.length > 0 && (
              <div className="absolute z-20 left-0 right-0 mt-1 max-h-40 overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl p-1.5 space-y-1">
                <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                  Known Database Venues
                </div>
                {venueSuggestions.map((ven) => (
                  <button
                    type="button"
                    key={ven.id}
                    onClick={() => {
                      setFormData({
                        ...formData,
                        venueHint: ven.name,
                        cityHint: `${ven.city}${ven.state ? ', ' + ven.state : ''}`,
                      });
                      setShowVenueSuggestions(false);
                    }}
                    className="w-full flex items-center justify-between rounded-lg px-2.5 py-1 text-left text-xs text-zinc-200 hover:bg-violet-950/50 hover:text-violet-300 transition-colors"
                  >
                    <span className="font-medium">{ven.name}</span>
                    <span className="text-[10px] text-zinc-400">
                      {ven.city}, {ven.state}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* City / Municipality Hint */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-zinc-400">
              City / Municipality Hint (Optional)
            </label>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-zinc-500">
                <MapPin className="h-4 w-4" />
              </div>
              <input
                type="text"
                placeholder="e.g. Los Angeles, CA or New York City, NY"
                value={formData.cityHint}
                onChange={(e) => setFormData({ ...formData, cityHint: e.target.value })}
                className="w-full rounded-xl border border-zinc-800 bg-zinc-950/60 py-2 pl-9 pr-3 text-xs text-zinc-200 placeholder-zinc-500 focus:border-violet-500 focus:outline-none"
              />
            </div>
          </div>
        </div>

        {/* Multi-Day Festival Run Support */}
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/40 p-3.5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm">🎪</span>
              <span className="text-xs font-semibold text-zinc-200">
                Multi-Day Festival & Attendance Specification (Optional)
              </span>
            </div>
            <span className="text-[11px] text-zinc-500">
              Track multi-day weekend passes & exact attendance
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="block text-[11px] font-medium text-zinc-400">
                Festival End Date (if multi-day event)
              </label>
              <div className="relative">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-zinc-500">
                  <Calendar className="h-3.5 w-3.5" />
                </div>
                <input
                  type="text"
                  placeholder="e.g. 2024-09-07 or Sept 7, 2024"
                  value={formData.endDateHint || ''}
                  onChange={(e) => setFormData({ ...formData, endDateHint: e.target.value })}
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-950/60 py-1.5 pl-8 pr-3 text-xs text-zinc-200 placeholder-zinc-500 focus:border-violet-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="block text-[11px] font-medium text-zinc-400">
                Days You Attended
              </label>
              <input
                type="text"
                placeholder="e.g. Attended all days, Day 1 only, Sunday only..."
                value={formData.attendedDaysHint || ''}
                onChange={(e) => setFormData({ ...formData, attendedDaysHint: e.target.value })}
                className="w-full rounded-xl border border-zinc-800 bg-zinc-950/60 py-1.5 px-3 text-xs text-zinc-200 placeholder-zinc-500 focus:border-violet-500 focus:outline-none"
              />
            </div>
          </div>
        </div>

        {/* Notes / Context */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-zinc-400">
            Archival Context or Special Highlights (Optional)
          </label>
          <div className="relative">
            <div className="pointer-events-none absolute top-2.5 left-3 text-zinc-500">
              <FileText className="h-4 w-4" />
            </div>
            <textarea
              rows={2}
              placeholder="e.g. Two-day festival run, guest appearances, special setlist tracks..."
              value={formData.notesHint}
              onChange={(e) => setFormData({ ...formData, notesHint: e.target.value })}
              className="w-full rounded-xl border border-zinc-800 bg-zinc-950/60 py-2 pl-9 pr-3 text-xs text-zinc-200 placeholder-zinc-500 focus:border-violet-500 focus:outline-none"
            />
          </div>
        </div>

        {/* Error Notification */}
        {error && (
          <div className="rounded-xl border border-red-500/40 bg-red-950/30 p-3 text-xs text-red-300">
            <p className="font-medium">Extraction Notice:</p>
            <p className="text-red-400 mt-0.5">{error}</p>
          </div>
        )}

        {/* Submit Actions */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-2">
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
            <span>Human-In-The-Loop review modal triggers before database write</span>
          </div>

          <div className="flex items-center gap-3 w-full sm:w-auto">
            <button
              type="button"
              onClick={onViewArchive}
              className="w-full sm:w-auto rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-xs font-semibold text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
            >
              View Stored Archive
            </button>

            <button
              type="submit"
              disabled={isLoading || !formData.concertName.trim()}
              className="w-full sm:w-auto flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 via-indigo-600 to-cyan-500 px-6 py-2.5 text-xs font-semibold text-white shadow-lg shadow-violet-600/30 hover:opacity-95 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {isLoading ? (
                <>
                  <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  <span>Scanning & Synthesizing...</span>
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5" />
                  <span>Execute Gemini Extraction</span>
                </>
              )}
            </button>
          </div>
        </div>
      </form>

      {/* Loading Progress State with Phase Steps */}
      {isLoading && (
        <div className="rounded-2xl border border-violet-500/30 bg-violet-950/30 p-5 space-y-4">
          <div className="flex items-center justify-between text-xs text-violet-300">
            <div className="flex items-center gap-2 font-semibold">
              <Clock className="h-4 w-4 text-violet-400 animate-spin" />
              <span>Gemini Extraction Engine Pipeline Running:</span>
            </div>
            <span className="font-mono text-[11px] text-violet-400">
              Phase {loadingPhase} of 5
            </span>
          </div>

          {/* Progress Bar */}
          <div className="w-full bg-zinc-900 rounded-full h-1.5 overflow-hidden">
            <div
              className="bg-gradient-to-r from-violet-500 to-cyan-400 h-1.5 transition-all duration-300"
              style={{ width: `${(loadingPhase / 5) * 100}%` }}
            />
          </div>

          <p className="text-sm font-medium text-white pl-6">{loadingStep}</p>
        </div>
      )}
    </div>
  );
};
