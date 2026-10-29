import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import { eventsApi, peopleApi, setPeopleHooks, vaultApi, type LoggedEvent } from '../services/lineupApi';
import { PeopleBook } from '../services/vaultPeople';
import type { ExportBundle } from '../services/exportBundle';
import { isCiphertext } from '../services/vault';
import { VaultSession, type Proof, type VaultStatus } from '../services/vaultSession';
import { useMe } from './MeContext';

// The vault in the page (multi-user only). The state machine is VaultSession;
// this wraps it for React. Keys live in this tab's memory and are gone on
// reload or Lock; the server holds only wrapped key material and encrypted
// notes. Scope today: notes. See ARCHITECTURE.md ("Multi-user").

export type { VaultStatus };

export interface VaultApi {
  status: VaultStatus;
  // Turn the vault on: returns the recovery key, to be shown once.
  setUp(passphrase: string): Promise<string>;
  unlock(secret: Proof): Promise<void>;
  lock(): void;
  changePassphrase(proof: Proof, next: string): Promise<void>;
  encryptNote(plain: string): Promise<string>;
  // A stored note as shown: plaintext as is, ciphertext decrypted, or null while locked.
  readNote(stored: string | undefined): Promise<string | null>;
  // The account export with notes and people opened (throws while locked).
  openExport(bundle: ExportBundle): Promise<ExportBundle>;
}

const none: VaultApi = {
  status: 'unavailable',
  setUp: async () => '',
  unlock: async () => undefined,
  lock: () => undefined,
  changePassphrase: async () => undefined,
  encryptNote: async (p) => p,
  readNote: async (s) => s ?? '',
  openExport: async (b) => b,
};
const Ctx = createContext<VaultApi>(none);
export const useVault = () => useContext(Ctx);

export const VaultProvider: React.FC<{ events: LoggedEvent[]; onChanged: () => void; children: React.ReactNode }> = ({ events, onChanged, children }) => {
  const me = useMe();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const session = useMemo(() => new VaultSession(vaultApi, me.multiUser), [me.multiUser]);
  const latest = useRef({ events, onChanged });
  latest.current = { events, onChanged };

  useEffect(() => {
    const off = session.subscribe(rerender);
    void session.load();
    return off;
  }, [session]);

  // The people who went: with the keys, names are read and written through the
  // people book (services/vaultPeople.ts); locked, events are marked instead.
  // Plain people from before the vault are converted when it opens. Events are
  // fetched again once the page knows which of these it is.
  useEffect(() => {
    if (session.status === 'off' || session.status === 'unavailable') return setPeopleHooks(null);
    if (session.status === 'loading') return;
    let live = true;
    (async () => {
      const keys = session.unlockedKeys;
      if (!keys) {
        setPeopleHooks({ book: null });
      } else {
        const book = new PeopleBook(keys, peopleApi);
        const plain = await book.load();
        if (plain.length) {
          await book.convertPlain(plain);
          await book.load();
        }
        if (!live) return;
        setPeopleHooks({ book });
      }
      latest.current.onChanged();
    })().catch((err) => console.warn('Could not open your people:', err));
    return () => {
      live = false;
    };
  }, [session, session.status]);

  // Notes written before the vault was on (or by a pass that stopped midway)
  // are encrypted whenever the vault opens.
  const encryptRemaining = async () => {
    const todo = latest.current.events.filter((e) => e.notes && !isCiphertext(e.notes));
    for (const e of todo) await eventsApi.update(e.id, { notes: await session.encryptNote(e.notes!) });
    if (todo.length) latest.current.onChanged();
  };

  const api = useMemo<VaultApi>(
    () => ({
      status: session.status,
      async setUp(passphrase) {
        const key = await session.setUp(passphrase);
        await encryptRemaining();
        return key;
      },
      async unlock(secret) {
        await session.unlock(secret);
        await encryptRemaining();
      },
      lock: () => session.lock(),
      changePassphrase: (proof, next) => session.changePassphrase(proof, next),
      encryptNote: (plain) => session.encryptNote(plain),
      readNote: (stored) => session.readNote(stored),
      openExport: (bundle) => session.openExport(bundle),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, session.status],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
};
