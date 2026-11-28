import React, { useRef, useState } from 'react';
import { Check, Copy, Upload } from 'lucide-react';
import { canonicalApi } from '../services/lineupApi';
import { parseCsv } from '../services/listImport';
import { ARTIST_CLEANUP_AI_PROMPT } from '../services/cleanupPrompts';
import {
  ARTIST_CLEANUP_ORDER,
  parseArtistCleanupCsv,
  type ArtistCleanupReport,
  type ArtistCleanupRow,
} from '../server/entities/artistCleanupCsv';
import { Button } from './ui/Button';
import { Ledger } from './ui/Ledger';
import { Notice } from './ui/Notice';

interface ArtistCleanupPanelProps {
  onApplied: () => void;
}

const STATUS_LABEL: Record<(typeof ARTIST_CLEANUP_ORDER)[number], string> = {
  invalid_non_artist: 'Invalid non-artist',
  merge_duplicate: 'Merge duplicate',
  remap_set: 'Remap set',
  split_multi_artist: 'Split multi-artist',
  rename: 'Rename',
  link_alter_ego: 'Link alter ego',
};

// Global Archive (Artists): reusable single-transaction CSV cleanup (docs/archive/artist-entity-cleanup.md).
// Upload any 15-column cleanup CSV, inspect the live dry-run report, and click Apply to commit atomically.
export const ArtistCleanupPanel: React.FC<ArtistCleanupPanelProps> = ({ onApplied }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<ArtistCleanupRow[] | null>(null);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [report, setReport] = useState<ArtistCleanupReport | null>(null);
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(ARTIST_CLEANUP_AI_PROMPT);
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 2000);
    } catch {
      setError('Could not copy to clipboard.');
    }
  };

  const handleFile = async (file: File) => {
    setError(null);
    setParseErrors([]);
    setReport(null);
    setFileName(file.name);
    const parsed = parseArtistCleanupCsv(parseCsv(await file.text()));
    if (parsed.errors.length > 0) {
      setRows(null);
      setParseErrors(parsed.errors);
      return;
    }
    setRows(parsed.rows);
    setBusy('preview');
    try {
      const preview = await canonicalApi.artistCleanupPreview(parsed.rows);
      setReport(preview);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Dry-run preview failed.');
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!rows || busy) return;
    setBusy('apply');
    setError(null);
    try {
      const committed = await canonicalApi.artistCleanupApply(rows);
      setReport(committed);
      onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Artist cleanup apply failed.');
    } finally {
      setBusy(null);
    }
  };

  const reset = () => {
    setRows(null);
    setParseErrors([]);
    setReport(null);
    setError(null);
    setFileName(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const canApply = Boolean(rows && report && report.dryRun && report.failedResolutions.length === 0 && busy === null);

  return (
    <section aria-label="Artist entity cleanup" className="space-y-2 rounded-card border border-line bg-surface-1 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-display text-base font-normal text-text">Artist entity cleanup CSV</h3>
          <p className="text-xs text-text-muted">
            Upload a cleanup CSV to run a live dry-run preview, then apply all 6 stages in one transaction.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            aria-label="Upload artist cleanup CSV"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
          <Button
            variant="secondary"
            className="px-2.5 py-1 text-xs"
            disabled={busy !== null}
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="size-3.5" aria-hidden="true" />
            {busy === 'preview' ? 'Checking…' : fileName ? 'Upload another CSV' : 'Upload cleanup CSV'}
          </Button>
          <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => void copyPrompt()}>
            {copiedPrompt ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
            {copiedPrompt ? 'Copied prompt' : 'Copy AI prompt'}
          </Button>
          {report && report.dryRun && (
            <Button variant="primary" className="px-2.5 py-1 text-xs" disabled={!canApply} onClick={() => void apply()}>
              {busy === 'apply' ? 'Applying…' : `Apply cleanup (${report.totalRows})`}
            </Button>
          )}
          {(report || parseErrors.length > 0 || error) && (
            <Button variant="ghost" className="px-2.5 py-1 text-xs" disabled={busy !== null} onClick={reset}>
              Clear
            </Button>
          )}
        </div>
      </div>

      {error && <Notice tone="warning">{error}</Notice>}

      {parseErrors.length > 0 && (
        <Notice tone="warning">
          <div>
            <p className="font-medium">Could not read {fileName ?? 'CSV'}:</p>
            <ul className="mt-1 list-disc pl-4 text-xs">
              {parseErrors.slice(0, 10).map((e, idx) => (
                <li key={idx}>{e}</li>
              ))}
              {parseErrors.length > 10 && <li>…and {parseErrors.length - 10} more.</li>}
            </ul>
          </div>
        </Notice>
      )}

      {report && (
        <div className="space-y-2">
          <Notice tone={report.failedResolutions.length > 0 ? 'warning' : report.dryRun ? 'info' : 'success'}>
            {report.dryRun
              ? `Dry-run preview (${fileName ?? 'CSV'}): ${report.totalRows} rows checked, 0 changes written yet.`
              : `Committed (${fileName ?? 'CSV'}): ${report.totalRows} rows applied in a single transaction.`}
          </Notice>

          <p className="font-mono text-xs tabular-nums text-text-muted">
            {ARTIST_CLEANUP_ORDER.map((s) => `${STATUS_LABEL[s]} ${report.counts[s] ?? 0}`).join(' · ')}
          </p>

          <p className="font-mono text-xs tabular-nums text-text-muted">
            Appearances migrated {report.performancesMigrated} · Deduped {report.performancesDeduped} · New split artists{' '}
            {report.newArtistsInserted} · Parent stubs {report.parentStubsInserted} · Owner events updated{' '}
            {report.ownerEventsUpdated} · Failed keys {report.failedResolutions.length}
          </p>

          {!report.dryRun && (
            <p className="font-mono text-xs tabular-nums text-text-muted">
              Assertions: active deprecated {report.assertions.remainingDeprecatedActive} · orphaned appearances{' '}
              {report.assertions.orphanedPerformances} · missing blocklist {report.assertions.missingBlocklistEntries}
            </p>
          )}

          {report.failedResolutions.length > 0 && (
            <Ledger>
              {report.failedResolutions.slice(0, 50).map((f, idx) => (
                <Ledger.Row key={`${f.line}-${idx}`} edge="needs" className="flex-col items-stretch gap-0.5 px-3 py-2 text-xs">
                  <span className="font-medium text-text">
                    Line {f.line} · {f.artist} ({f.status})
                  </span>
                  <span className="text-bad">
                    {f.reason} — target: {f.targetKey}
                  </span>
                </Ledger.Row>
              ))}
            </Ledger>
          )}
        </div>
      )}
    </section>
  );
};
