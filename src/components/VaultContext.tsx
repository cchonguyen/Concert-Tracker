import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { eventsApi, vaultApi, type LoggedEvent } from '../services/lineupApi';
import {
  changePassphrase,
  createVault,
  decryptField,
  encryptField,
  isCiphertext,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
  type VaultKeys,
  type VaultMaterial,
} from '../services/vault';
import { useMe } from './MeContext';

// The vault in the page (multi-user only). Keys live in this tab's memory and
// are gone on reload or Lock; the server holds only wrapped key material and
// encrypted notes. Scope today: notes. See ARCHITECTURE.md ("Multi-user").

export type VaultStatus = 'unavailable' | 'loading' | 'off' | 'locked' | 'unlocked';

export interface VaultApi {
  status: VaultStatus;
  // Turn the vault on: returns the recovery key, to be shown once.
  setUp(passphrase: string): Promise<string>;
  unlock(secret: { passphrase: string } | { recoveryKey: string }): Promise<void>;
  lock(): void;
  changePassphrase(proof: { passphrase: string } | { recoveryKey: string }, next: string): Promise<void>;
  encryptNote(plain: string): Promise<string>;
  // A stored note as shown: plaintext as is, ciphertext decrypted, or null while locked.
  readNote(stored: string | undefined): Promise<string | null>;
}

const none: VaultApi = {
  status: 'unavailable',
  setUp: async () => '',
  unlock: async () => undefined,
  lock: () => undefined,
  changePassphrase: async () => undefined,
  encryptNote: async (p) => p,
  readNote: async (s) => s ?? '',
};
const Ctx = createContext<VaultApi>(none);
export const useVault = () => useContext(Ctx);

export const VaultProvider: React.FC<{ events: LoggedEvent[]; onChanged: () => void; children: React.ReactNode }> = ({ events, onChanged, children }) => {
  const me = useMe();
  const [status, setStatus] = useState<VaultStatus>(me.multiUser ? 'loading' : 'unavailable');
  const [material, setMaterial] = useState<VaultMaterial | null>(null);
  const [keys, setKeys] = useState<VaultKeys | null>(null);

  useEffect(() => {
    if (!me.multiUser) return;
    vaultApi.get().then(
      (v) => {
        setMaterial(v.material);
        setStatus(v.state === 'encrypted' ? 'locked' : 'off');
      },
      () => setStatus('off'),
    );
  }, [me.multiUser]);

  // Notes written before the vault was on (or by a pass that stopped midway)
  // are encrypted whenever the vault opens.
  const encryptRemaining = useCallback(
    async (k: VaultKeys) => {
      const todo = events.filter((e) => e.notes && !isCiphertext(e.notes));
      for (const e of todo) await eventsApi.update(e.id, { notes: await encryptField(k, e.notes!) });
      if (todo.length) onChanged();
    },
    [events, onChanged],
  );

  const api = useMemo<VaultApi>(
    () => ({
      status,
      async setUp(passphrase) {
        const v = await createVault(passphrase);
        await vaultApi.turnOn(v.material);
        setMaterial(v.material);
        setKeys(v.keys);
        setStatus('unlocked');
        await encryptRemaining(v.keys);
        return v.recoveryKey;
      },
      async unlock(secret) {
        if (!material) throw new Error('The vault is not on.');
        const k = 'passphrase' in secret ? await unlockWithPassphrase(material, secret.passphrase) : await unlockWithRecoveryKey(material, secret.recoveryKey);
        setKeys(k);
        setStatus('unlocked');
        await encryptRemaining(k);
      },
      lock() {
        setKeys(null);
        setStatus(material ? 'locked' : 'off');
      },
      async changePassphrase(proof, next) {
        if (!material) throw new Error('The vault is not on.');
        const updated = await changePassphrase(material, proof, next);
        await vaultApi.rewrap(updated);
        setMaterial(updated);
      },
      async encryptNote(plain) {
        if (!keys) throw new Error('Unlock the vault to save notes.');
        return encryptField(keys, plain);
      },
      async readNote(stored) {
        if (!stored) return '';
        if (!isCiphertext(stored)) return stored;
        return keys ? decryptField(keys, stored) : null;
      },
    }),
    [status, material, keys, encryptRemaining],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
};
