import { Dialog } from './ui/Dialog';
import React, { useEffect, useState } from 'react';
import { Mail, Trash2, UserPlus, X } from 'lucide-react';
import { IconButton } from './ui/IconButton';
import { Confirm } from './ui/Confirm';
import { Button } from './ui/Button';
import { Equalizer } from './ui/Equalizer';
import { HintPill } from './ui/HintPill';
import { Ledger } from './ui/Ledger';
import { Pill } from './ui/Pill';
import { Tabs } from './ui/Tabs';
import { accessRequestsApi, membersApi, type AccessRequestRow, type MemberRow, type RequestSettings, type RequestStatus } from '../services/lineupApi';
import { useMe } from './MeContext';

// The owner's panel (multi-user only). Members: who has a tracker, invited by
// email. Requests: everyone who asked, was invited or was banned, with a
// status the owner can change (ARCHITECTURE.md "Request access").

const button = 'inline-flex min-h-11 sm:min-h-9 items-center gap-1.5 rounded-control border border-line-strong px-3 py-2 text-sm text-text-muted hover:text-text disabled:opacity-40';
const field = 'min-h-11 sm:min-h-9 rounded-control border border-line-strong bg-surface-1 px-3 py-2 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none';
const FILTERS: Array<RequestStatus | 'all'> = ['all', 'pending', 'accepted', 'declined', 'left'];
const WORD: Record<RequestStatus, string> = { pending: 'Pending', accepted: 'Accepted', declined: 'Declined', left: 'Left' };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const MembersPanel: React.FC<{ onClose: () => void; onChanged?: () => void }> = ({ onClose, onChanged }) => {
  const me = useMe();
  const [tab, setTab] = useState<'members' | 'requests'>('requests');
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [requests, setRequests] = useState<{ rows: AccessRequestRow[]; settings: RequestSettings } | null>(null);
  const [email, setEmail] = useState('');
  const [sendInviteEmail, setSendInviteEmail] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<RequestStatus | 'all'>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ban, setBan] = useState('');
  const [capDraft, setCapDraft] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'block' | 'delete'; email: string } | null>(null);
  const [researchOn, setResearchOn] = useState<boolean | null>(null);

  const load = async () => {
    const [m, r, rb] = await Promise.all([membersApi.list(), accessRequestsApi.list(), membersApi.researchBatch()]);
    setMembers(m);
    setResearchOn(rb.on);
    setRequests({ rows: r.requests, settings: r.settings });
    setSelected((s) => new Set([...s].filter((e) => r.requests.some((row) => row.email === e && row.status === 'pending'))));
  };
  useEffect(() => {
    load().catch((e) => setError(errorText(e)));
  }, []);

  // Runs a change, then reloads both lists and tells the page (the Members badge).
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
      await load();
      onChanged?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const formatEmailNote = (
    who: string,
    res: { emailSent?: boolean; emailReason?: string } | undefined,
    kind: 'invite' | 'welcome',
    isResend = false,
  ) => {
    if (!res || res.emailSent === undefined) return null;
    if (res.emailSent) return `${isResend ? 'Resent' : 'Sent'} ${kind} email to ${who}.`;
    if (res.emailReason === 'opted_out') return `${who} has opted out of emails.`;
    if (res.emailReason === 'already_sent') return `${kind === 'invite' ? 'Invite' : 'Welcome'} email was already sent to ${who}.`;
    if (res.emailReason === 'not_configured') {
      return isResend ? 'Email notifications are not configured.' : `Added ${who} (email notifications are not configured).`;
    }
    return isResend
      ? `Could not resend email to ${who} (${res.emailReason}).`
      : `Saved ${who}, but the email could not be sent (${res.emailReason}).`;
  };

  const setStatus = (who: string, to: 'pending' | 'accepted' | 'declined') =>
    act(async () => {
      const res = await accessRequestsApi.setStatus(who, to);
      if (to === 'accepted') setNote(formatEmailNote(who, res, 'welcome'));
    });
  const saveSettings = (patch: Partial<RequestSettings>) => act(() => accessRequestsApi.saveSettings(patch).then(() => setCapDraft(null)));

  const unaccepted = members?.filter((m) => m.role !== 'owner' && !m.joined && !m.blocked) ?? [];

  const resendInvite = (who: string) =>
    act(async () => {
      const res = await membersApi.invite(who, { sendEmail: true, resend: true });
      setNote(formatEmailNote(who, res, 'invite', true));
    });

  const resendAllInvites = () =>
    act(async () => {
      const targets = unaccepted.map((m) => m.email);
      let sentCount = 0;
      const failures: string[] = [];
      for (const target of targets) {
        try {
          const res = await membersApi.invite(target, { sendEmail: true, resend: true });
          if (res.emailSent) {
            sentCount++;
          } else {
            failures.push(`${target} (${res.emailReason ?? 'not sent'})`);
          }
        } catch (e) {
          failures.push(`${target} (${errorText(e)})`);
        }
      }
      if (failures.length === 0) {
        setNote(`Resent invite email to ${sentCount} ${sentCount === 1 ? 'person' : 'people'}.`);
      } else if (sentCount > 0) {
        setNote(`Resent invite email to ${sentCount} ${sentCount === 1 ? 'person' : 'people'}. Failed: ${failures.join(', ')}`);
      } else {
        setError(`Failed to resend invite emails: ${failures.join(', ')}`);
      }
    });

  const rows = requests?.rows ?? [];
  const shown = filter === 'all' ? rows : rows.filter((r) => r.status === filter);
  const pendingRows = rows.filter((r) => r.status === 'pending');

  const actions = (r: AccessRequestRow) => {
    if (r.email === me.email) return <span className="text-[11px] text-text-faint">Owner</span>;
    const out: React.ReactNode[] = [];
    if (r.status === 'pending' || r.status === 'left') {
      out.push(<Button key="accept" variant="secondary" disabled={busy} onClick={() => setStatus(r.email, 'accepted')}>Accept</Button>);
      out.push(<Button key="decline" variant="ghost" disabled={busy} onClick={() => setStatus(r.email, 'declined')}>Decline</Button>);
    }
    if (r.status === 'accepted' && r.hasAccount) {
      out.push(<Button key="block" variant="ghost" disabled={busy} onClick={() => setConfirm({ kind: 'block', email: r.email })}>Block</Button>);
      out.push(<Button key="delete" variant="danger" disabled={busy} onClick={() => setConfirm({ kind: 'delete', email: r.email })}>Delete data</Button>);
    }
    if (r.status === 'accepted' && !r.hasAccount) {
      out.push(<Button key="decline" variant="ghost" disabled={busy} onClick={() => setStatus(r.email, 'declined')}>Decline</Button>);
    }
    if (r.status === 'declined') {
      out.push(<Button key="accept" variant="secondary" disabled={busy} onClick={() => setStatus(r.email, 'accepted')}>Accept</Button>);
      out.push(<Button key="review" variant="ghost" disabled={busy} onClick={() => setStatus(r.email, 'pending')}>Re-review</Button>);
    }
    return out;
  };

  const label = (r: AccessRequestRow) => {
    if (r.status === 'accepted' && !r.hasAccount) return 'Accepted (no account)';
    if (r.status === 'accepted' && r.blocked) return 'Accepted (blocked)';
    return WORD[r.status];
  };

  const origin = (r: AccessRequestRow) => (r.source === 'requested' ? 'Asked' : r.source === 'invited' ? 'Invited' : 'Banned directly');

  return (
    <Dialog title="Members" onClose={onClose} panelClassName="h-full w-full max-w-md space-y-4 overflow-y-auto border-l border-line bg-page p-5">
      <div className="flex items-center justify-between">
        <h2 className="poster-head text-2xl text-text">Members</h2>
        <button onClick={onClose} aria-label="Close" className="flex h-10 w-10 items-center justify-center rounded-control text-text-muted hover:text-text">
          <X className="h-5 w-5" />
        </button>
      </div>
      <Tabs
        label="Members panel sections"
        variant="underline"
        items={[
          { value: 'requests', label: 'Requests', count: pendingRows.length > 0 ? pendingRows.length : undefined },
          { value: 'members', label: 'Members' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {error && <p className="text-xs text-bad">{error}</p>}
      {note && <p className="text-xs text-good">{note}</p>}

      {tab === 'members' && (
        <>
          <p className="text-xs text-text-muted">
            Each member keeps their own events, imports and share link. Nobody, you included, sees another member's events here.
          </p>
          {researchOn !== null && (
            <label className="flex items-start gap-2 text-xs text-text-muted">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={researchOn}
                disabled={busy}
                onChange={(e) => {
                  const on = e.target.checked;
                  act(async () => {
                    await membersApi.setResearchBatch(on);
                  });
                }}
              />
              <span>
                Let the background research batch look up saved events for accepted members too. Off by default. Each member's
                events are still only ever written to their own list.
              </span>
            </label>
          )}
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              const target = email.trim().toLowerCase();
              act(async () => {
                const res = await membersApi.invite(target, { sendEmail: sendInviteEmail });
                setEmail('');
                setNote(formatEmailNote(target, res, 'invite'));
              });
            }}
          >
            <div className="flex gap-2">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="friend@example.com"
                className={`min-w-0 flex-1 ${field}`}
              />
              <button type="submit" disabled={busy || !email.trim()} className={button}>
                {busy ? <Equalizer size="sm" /> : <UserPlus className="h-4 w-4" />} Invite
              </button>
            </div>
            <label className="flex items-center gap-2 text-xs text-text-muted">
              <input type="checkbox" checked={sendInviteEmail} onChange={(e) => setSendInviteEmail(e.target.checked)} />
              Send invite email with sign-in instructions
            </label>
          </form>
          {members === null ? (
            <span role="status" aria-label="Loading members" className="inline-flex items-center text-text-muted">
              <Equalizer />
            </span>
          ) : (
            <div className="space-y-2">
              {unaccepted.length > 0 && (
                <div className="flex items-center justify-between gap-2 pt-1">
                  <span className="font-mono text-xs tabular-nums text-text-muted">
                    {unaccepted.length} {unaccepted.length === 1 ? 'invite pending' : 'invites pending'}
                  </span>
                  <Button variant="ghost" disabled={busy} onClick={resendAllInvites}>
                    <Mail className="h-3.5 w-3.5" />
                    Resend all invite emails
                  </Button>
                </div>
              )}
              <Ledger>
                {members.map((m) => {
                  const canResend = m.role !== 'owner' && !m.joined && !m.blocked;
                  return (
                    <Ledger.Row key={m.email} edge="none" className="justify-between px-3 py-2.5 text-sm">
                      <div className="min-w-0">
                        <p className="truncate text-text">{m.email}</p>
                        <p className="text-[11px] text-text-muted">
                          {m.role === 'owner' ? 'Owner' : m.blocked ? 'Blocked' : m.joined ? 'Member' : 'Invited, not signed in yet'}
                        </p>
                      </div>
                      {m.role !== 'owner' && (
                        <div className="flex items-center gap-1">
                          {canResend && (
                            <IconButton
                              icon={Mail}
                              label={`Resend invite email to ${m.email}`}
                              disabled={busy}
                              onClick={() => resendInvite(m.email)}
                            />
                          )}
                          <IconButton
                            icon={Trash2}
                            label={`Delete data for ${m.email}`}
                            disabled={busy}
                            onClick={() => setConfirm({ kind: 'delete', email: m.email })}
                            className="hover:text-bad"
                          />
                        </div>
                      )}
                    </Ledger.Row>
                  );
                })}
              </Ledger>
            </div>
          )}
        </>
      )}

      {tab === 'requests' && (
        <>
          <div className="space-y-3 rounded-card border border-line bg-surface-1 p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-text">Requests</p>
                <p className="text-[11px] text-text-muted">{requests?.settings.paused ? 'Closed. Nobody new can ask.' : 'Open. Strangers can ask.'}</p>
              </div>
              <button
                aria-pressed={requests?.settings.paused ?? false}
                disabled={busy || !requests}
                onClick={() => saveSettings({ paused: !requests?.settings.paused })}
                className={`${button} ${requests?.settings.paused ? 'border-bad/45 text-bad' : ''}`}
              >
                {requests?.settings.paused ? 'Requests paused' : 'Pause requests'}
              </button>
            </div>
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const cap = Number(capDraft ?? requests?.settings.cap);
                if (Number.isInteger(cap)) void saveSettings({ cap });
              }}
            >
              <label className="flex-1 space-y-1 text-[11px] text-text-muted">
                Pending cap (1 to 100). At the cap, new requests are closed; lowering it below the pending count closes them at once.
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={capDraft ?? requests?.settings.cap ?? ''}
                  onChange={(e) => setCapDraft(e.target.value)}
                  className={`w-full font-mono tabular-nums ${field}`}
                />
              </label>
              <Button type="submit" variant="secondary" disabled={busy || capDraft === null}>
                Save cap
              </Button>
            </form>
          </div>

          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!EMAIL.test(ban.trim())) return setError('Enter a valid email address.');
              void act(async () => {
                await accessRequestsApi.setStatus(ban.trim().toLowerCase(), 'declined');
                setBan('');
              });
            }}
          >
            <input
              type="email"
              value={ban}
              onChange={(e) => setBan(e.target.value)}
              placeholder="Ban an email (never asked)"
              aria-label="Ban an email"
              className={`min-w-0 flex-1 ${field}`}
            />
            <Button type="submit" variant="ghost" disabled={busy || !ban.trim()}>
              Ban
            </Button>
          </form>

          <div className="flex items-center justify-between gap-2">
            <select
              aria-label="Filter by status"
              value={filter}
              onChange={(e) => setFilter(e.target.value as RequestStatus | 'all')}
              className={field}
            >
              {FILTERS.map((f) => (
                <option key={f} value={f}>
                  {f === 'all' ? 'All statuses' : WORD[f]}
                </option>
              ))}
            </select>
            {pendingRows.length > 0 && (
              <Button
                variant="ghost"
                disabled={busy || selected.size === 0}
                onClick={() => act(async () => {
                  for (const who of selected) await accessRequestsApi.setStatus(who, 'declined');
                  setSelected(new Set());
                })}
              >
                Decline selected ({selected.size})
              </Button>
            )}
          </div>

          {requests === null ? (
            <span role="status" aria-label="Loading requests" className="inline-flex items-center text-text-muted">
              <Equalizer />
            </span>
          ) : shown.length === 0 ? (
            <p className="text-xs text-text-muted">Nothing here yet.</p>
          ) : (
            <Ledger>
              {shown.map((r) => (
                <Ledger.Row
                  key={r.email}
                  edge={r.status === 'pending' ? 'needs' : 'none'}
                  className="flex-col items-stretch gap-2 p-3 text-sm"
                >
                  <div className="flex items-start gap-3">
                    {r.status === 'pending' && (
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.email}`}
                        checked={selected.has(r.email)}
                        onChange={(e) =>
                          setSelected((s) => {
                            const next = new Set(s);
                            if (e.target.checked) next.add(r.email);
                            else next.delete(r.email);
                            return next;
                          })
                        }
                        className="mt-1"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-text">{r.email}</p>
                      <p className="font-mono text-[11px] tabular-nums text-text-muted">
                        {origin(r)} {day(r.requestedAt)} · changed {day(r.statusChangedAt)}
                      </p>
                    </div>
                    {r.status === 'pending' ? (
                      <HintPill tone="needs">{label(r)}</HintPill>
                    ) : r.status === 'accepted' && !r.blocked ? (
                      <HintPill tone="done">{label(r)}</HintPill>
                    ) : (
                      <Pill>{label(r)}</Pill>
                    )}
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">{actions(r)}</div>
                </Ledger.Row>
              ))}
            </Ledger>
          )}
        </>
      )}

      {confirm?.kind === 'block' && (
        <Confirm
          title="Block this member"
          message={`${confirm.email} loses access at once and sees the request screen. Their events and data are kept, and you can accept them again here.`}
          confirmLabel="Block"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const who = confirm.email;
            setConfirm(null);
            void setStatus(who, 'declined');
          }}
        />
      )}
      {confirm?.kind === 'delete' && (
        <Confirm
          title="Delete their data"
          message="Their account and every event they saved are deleted. Their request history stays, as Declined. This cannot be undone."
          confirmLabel="Delete data"
          typedMatch={confirm.email}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const who = confirm.email;
            setConfirm(null);
            void act(() => membersApi.remove(who));
          }}
        />
      )}
    </Dialog>
  );
};
