import { Router, type NextFunction, type Request, type Response } from 'express';
import type { LineupStore } from '../lineup/store/types';
import { currentMember } from './requestScope';

// The server's half of the vault. It holds the member's wrapped key material
// (ciphertext and salts only) and refuses plaintext notes once the vault is
// on. It never holds a passphrase, a recovery key or an unwrapped key.
//
// Scope today: notes. Companions stay plaintext because people are shared
// records until the entity split; encrypting them needs per-member people.
// Material lives in the member's settings under VAULT_SETTING.

export const VAULT_SETTING = 'vault';

export interface VaultMaterialJson {
  vaultSalt: string;
  kdfAlg: 'PBKDF2-SHA256';
  pbkdf2Iterations: number;
  passphraseSalt: string;
  wrappedByPassphrase: string;
  wrappedByRecovery: string;
}

const CIPHER = /^v1:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$/;
const WRAPPED = /^w1:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

export const isCiphertext = (v: unknown): v is string => typeof v === 'string' && v.length < 200_000 && CIPHER.test(v);

export function parseMaterial(v: any): VaultMaterialJson | null {
  if (!v || typeof v !== 'object') return null;
  if (v.kdfAlg !== 'PBKDF2-SHA256') return null;
  if (!Number.isInteger(v.pbkdf2Iterations) || v.pbkdf2Iterations < 1000 || v.pbkdf2Iterations > 10_000_000) return null;
  for (const k of ['vaultSalt', 'passphraseSalt']) if (typeof v[k] !== 'string' || !B64.test(v[k]) || v[k].length > 100) return null;
  for (const k of ['wrappedByPassphrase', 'wrappedByRecovery']) if (typeof v[k] !== 'string' || !WRAPPED.test(v[k]) || v[k].length > 400) return null;
  return {
    vaultSalt: v.vaultSalt,
    kdfAlg: v.kdfAlg,
    pbkdf2Iterations: v.pbkdf2Iterations,
    passphraseSalt: v.passphraseSalt,
    wrappedByPassphrase: v.wrappedByPassphrase,
    wrappedByRecovery: v.wrappedByRecovery,
  };
}

// Writes that carry a note: event saves and patches. A patch may sit at the
// top level or under `patch`.
const NOTE_WRITES: Array<[string, RegExp]> = [
  ['POST', /^\/api\/events$/],
  ['PATCH', /^\/api\/events\/[^/]+$/],
  ['POST', /^\/api\/imports\/(add|merge)$/],
];

export const plaintextNote = (body: any): boolean => {
  const notes = [body?.notes, body?.patch?.notes, body?.event?.notes].filter((n) => n !== undefined && n !== null && n !== '');
  return notes.some((n) => !isCiphertext(n));
};

// Once a member's vault is on, a request that would store a plaintext note is
// refused, so an old open tab or an import cannot write one back.
export function vaultGuard(store: LineupStore) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!currentMember() || !NOTE_WRITES.some(([m, re]) => m === req.method && re.test(req.originalUrl.split('?')[0]))) return next();
    if (!plaintextNote(req.body)) return next();
    try {
      if (!(await store.getSetting<VaultMaterialJson>(VAULT_SETTING))) return next();
    } catch (err) {
      return res.status(503).json({ error: 'Could not check your vault. Try again.' });
    }
    res.status(400).json({ error: 'Your vault is on: notes must be encrypted in the browser. Unlock the vault and save again.' });
  };
}

export function vaultRouter(store: LineupStore): Router {
  const router = Router();
  const fail = (res: Response, status: number, error: string) => res.status(status).json({ error });

  router.get('/vault', async (_req, res) => {
    try {
      const material = await store.getSetting<VaultMaterialJson>(VAULT_SETTING);
      res.json({ state: material ? 'encrypted' : 'plaintext', material: material ?? null });
    } catch (err) {
      fail(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  // Turn the vault on. Allowed once; changing the passphrase is /vault/rewrap.
  router.put('/vault', async (req, res) => {
    const material = parseMaterial(req.body?.material);
    if (!material) return fail(res, 400, 'That is not valid vault key material.');
    try {
      if (await store.getSetting(VAULT_SETTING)) return fail(res, 409, 'The vault is already on.');
      await store.putSetting(VAULT_SETTING, material);
      res.json({ state: 'encrypted' });
    } catch (err) {
      fail(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  // A new passphrase wrapping. The master secret, the recovery wrapping and
  // every encrypted row stay as they are.
  router.post('/vault/rewrap', async (req, res) => {
    const next = parseMaterial(req.body?.material);
    if (!next) return fail(res, 400, 'That is not valid vault key material.');
    try {
      const current = await store.getSetting<VaultMaterialJson>(VAULT_SETTING);
      if (!current) return fail(res, 404, 'The vault is not on.');
      if (next.vaultSalt !== current.vaultSalt || next.wrappedByRecovery !== current.wrappedByRecovery) {
        return fail(res, 400, 'A passphrase change may not alter the recovery wrapping.');
      }
      await store.putSetting(VAULT_SETTING, next);
      res.json({ state: 'encrypted' });
    } catch (err) {
      fail(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  return router;
}
