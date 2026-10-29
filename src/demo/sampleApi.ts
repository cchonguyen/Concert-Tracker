// What sample mode answers in place of the server (see src/services/sampleMode.ts).
// Loaded only by activateSample, through a dynamic import, so this file and
// the sample data are never part of a member's download. Reads answer from the
// sample; anything it does not have is refused, so a view shows its empty
// state instead of real data. Writes never reach this file (lineupApi refuses them).

import type { Me } from '../components/MeContext';
import { SampleRefused, type SampleSource, type SampleStart } from '../services/sampleMode';
import { sampleEvents, sampleLineups, samplePoints } from './sampleData';

export function createSampleSource(start: SampleStart): SampleSource {
  // The sample plays a member: Manage, Members, Sheets and Gmail stay hidden, as they would for a member.
  const me: Me = {
    multiUser: true,
    role: 'member',
    email: start.email,
    noticeAccepted: true,
    readOnly: true,
    sample: start.mode,
  };
  const answers: Record<string, () => unknown> = {
    '/api/me': () => me,
    '/api/events': () => ({ events: sampleEvents, lineups: sampleLineups, editions: {} }),
    '/api/lineup/status': () => ({ store: 'file', sources: [], gemini: null, quota: null }),
    '/api/imports': () => ({ imports: [] }),
    '/api/imports/scan': () => ({ configured: false, connected: false }),
    '/api/vault': () => ({ state: 'plaintext', material: null }),
    '/api/artist-genres': () => ({ genres: [], hasMap: false, known: [] }),
  };

  return {
    me,
    answer(url) {
      const { pathname, searchParams } = new URL(url, 'http://localhost');
      const direct = answers[pathname];
      if (direct) return direct();
      if (pathname === '/api/places/point') return { point: samplePoints[searchParams.get('city') ?? ''] ?? null };
      const event = /^\/api\/events\/([^/]+)$/.exec(pathname);
      if (event) {
        const found = sampleEvents.find((e) => e.id === decodeURIComponent(event[1]));
        if (!found) throw new SampleRefused('That show is not in the sample.');
        return { event: found, job: null, edition: null, suggestions: [] };
      }
      throw new SampleRefused(`The sample has no ${pathname}.`);
    },
  };
}
