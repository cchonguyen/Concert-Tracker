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
} from './vault';
import { decryptBundle, type ExportBundle } from './exportBundle';

// The vault's state machine, with no React in it so tests can drive it:
//   unavailable (single-owner install) | loading -> off -> unlocked (set up)
//   unlocked <-> locked (reload or Lock); the recovery key unlocks as well.
// Keys live only in this object's memory. VaultContext.tsx wraps it for the page.

export type VaultStatus = 'unavailable' | 'loading' | 'off' | 'locked' | 'unlocked';
export type Proof = { passphrase: string } | { recoveryKey: string };

export interface VaultServer {
  get(): Promise<{ state: 'plaintext' | 'encrypted'; material: VaultMaterial | null }>;
  turnOn(material: VaultMaterial): Promise<unknown>;
  rewrap(material: VaultMaterial): Promise<unknown>;
}

export class VaultSession {
  status: VaultStatus;
  private material: VaultMaterial | null = null;
  private keys: VaultKeys | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private readonly server: VaultServer,
    multiUser: boolean,
    private readonly iterations?: number,
  ) {
    this.status = multiUser ? 'loading' : 'unavailable';
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private set(status: VaultStatus) {
    this.status = status;
    this.listeners.forEach((fn) => fn());
  }

  async load(): Promise<void> {
    if (this.status === 'unavailable') return;
    try {
      const v = await this.server.get();
      this.material = v.material;
      this.set(v.state === 'encrypted' && v.material ? 'locked' : 'off');
    } catch {
      this.set('off');
    }
  }

  // Returns the recovery key, to be shown once.
  async setUp(passphrase: string): Promise<string> {
    if (this.status !== 'off') throw new Error('The vault is already on.');
    const v = await createVault(passphrase, this.iterations);
    await this.server.turnOn(v.material);
    this.material = v.material;
    this.keys = v.keys;
    this.set('unlocked');
    return v.recoveryKey;
  }

  async unlock(proof: Proof): Promise<void> {
    if (!this.material) throw new Error('The vault is not on.');
    this.keys = 'passphrase' in proof ? await unlockWithPassphrase(this.material, proof.passphrase) : await unlockWithRecoveryKey(this.material, proof.recoveryKey);
    this.set('unlocked');
  }

  lock(): void {
    this.keys = null;
    this.set(this.material ? 'locked' : 'off');
  }

  async changePassphrase(proof: Proof, next: string): Promise<void> {
    if (!this.material) throw new Error('The vault is not on.');
    const updated = await changePassphrase(this.material, proof, next, this.iterations);
    await this.server.rewrap(updated);
    this.material = updated;
  }

  // The unlocked keys, for the people book; null while locked.
  get unlockedKeys(): VaultKeys | null {
    return this.keys;
  }

  async encryptNote(plain: string): Promise<string> {
    if (!this.keys) throw new Error('Unlock the vault to save notes.');
    return encryptField(this.keys, plain);
  }

  // The server's export with notes and people opened, for download. Needs the keys.
  async openExport(bundle: ExportBundle): Promise<ExportBundle> {
    if (!this.keys) throw new Error('Unlock the vault to download a readable copy.');
    return decryptBundle(bundle, this.keys);
  }

  // A stored note as shown: plaintext as is, ciphertext decrypted, or null while locked.
  async readNote(stored: string | undefined | null): Promise<string | null> {
    if (!stored) return '';
    if (!isCiphertext(stored)) return stored;
    return this.keys ? decryptField(this.keys, stored) : null;
  }
}

// What a notes box shows. Locked is never presented as empty.
export type NoteView = { kind: 'text'; text: string; editable: true } | { kind: 'locked'; badge: 'Vault locked'; editable: false };
export const noteView = (read: string | null): NoteView => (read === null ? { kind: 'locked', badge: 'Vault locked', editable: false } : { kind: 'text', text: read, editable: true });
