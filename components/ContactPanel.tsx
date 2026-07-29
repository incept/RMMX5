'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import StatusPill, { type StatusOption } from '@/components/StatusPill';
import { useMyRole } from '@/lib/use-my-role';

const TABS = ['Contact Info', 'Link Data', 'Email', 'Calls', 'Activity', 'Files'] as const;
type Tab = (typeof TABS)[number];

interface LinkSlot {
  position: number;
  url: string;
  status: 'live' | 'requested' | 'removed';
  difficulty: number | null;
}

const LINK_STATUS_COLORS: Record<string, string> = {
  live: '#EF4444',
  requested: '#F59E0B',
  removed: '#22C55E',
};

const AI_CATEGORY_STYLES: Record<string, string> = {
  lead: 'bg-green-100 text-green-700',
  existing_customer: 'bg-gray-100 text-gray-600',
  voicemail: 'bg-amber-100 text-amber-700',
  spam: 'bg-red-100 text-red-700',
  wrong_number: 'bg-red-100 text-red-700',
};

// A normal worker tick may be 5-15 minutes away. Poll slowly, only after an
// operator starts a search, and stop after 20 minutes so an abandoned panel
// cannot become another permanent background request stream.
const DEEP_SEARCH_POLL_INTERVAL_MS = 30_000;
const DEEP_SEARCH_POLL_LIMIT = 40;

function callDuration(seconds: number | null): string {
  const s = Math.max(0, Number(seconds) || 0);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/** Slide-over panel: Contact Info (details + tracking data), Link Data, Email,
 * Calls, Activity, and Files. */
export default function ContactPanel({
  contactId,
  onClose,
  onChanged,
}: {
  contactId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const { isAdmin } = useMyRole(); // revenue figures are admin-only
  const [tab, setTab] = useState<Tab>('Contact Info');
  const [contact, setContact] = useState<any>(null);
  const [links, setLinks] = useState<LinkSlot[]>([]);
  const [statuses, setStatuses] = useState<StatusOption[]>([]);
  const [stages, setStages] = useState<any[]>([]);
  const [customFields, setCustomFields] = useState<any[]>([]);
  const [activity, setActivity] = useState<any[]>([]);
  const [files, setFiles] = useState<any[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  const [calls, setCalls] = useState<any[]>([]);
  const [candidates, setCandidates] = useState<any[]>([]);
  const [enrollments, setEnrollments] = useState<any[]>([]);
  const [listMemberships, setListMemberships] = useState<any[]>([]);
  const [allLists, setAllLists] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [defaultServiceDays, setDefaultServiceDays] = useState(90);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [compose, setCompose] = useState({ subject: '', html: '', accountId: '' });
  const [confirmUrlValue, setConfirmUrlValue] = useState('');
  const [countyValue, setCountyValue] = useState('');
  const [reverseResult, setReverseResult] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<any[]>([]);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeQuery, setMergeQuery] = useState('');
  const [mergeResults, setMergeResults] = useState<any[]>([]);
  const [profiles, setProfiles] = useState<any[]>([]);
  const [deepSearchStatus, setDeepSearchStatus] = useState<string | null>(null);
  const deepSearchPoll = useRef<symbol | null>(null);

  useEffect(() => {
    // Changing/closing the panel invalidates an in-flight monitor. The pending
    // timeout is harmless and exits without touching state when it wakes.
    deepSearchPoll.current = null;
    setDeepSearchStatus(null);
    return () => {
      deepSearchPoll.current = null;
    };
  }, [contactId]);

  const load = useCallback(async () => {
    const [contactRes, linksRes, statusRes, stageRes, fieldsRes, activityRes] = await Promise.all([
      supabase
        .from('contacts')
        .select('*, statuses ( id, name, color, is_client_status ), stages ( id, name, color )')
        .eq('id', contactId)
        .single(),
      supabase.from('contact_links').select('*').eq('contact_id', contactId).order('position'),
      supabase.from('statuses').select('id, name, color, is_client_status').order('sort_order'),
      supabase.from('stages').select('id, name, color').order('sort_order'),
      supabase.from('custom_fields').select('*').order('sort_order'),
      supabase
        .from('activity_log')
        .select('*, profiles ( full_name, email )')
        .eq('contact_id', contactId)
        .order('created_at', { ascending: false })
        .limit(100),
    ]);

    setContact(contactRes.data);

    // Possible duplicates: another contact sharing this one's phone or email.
    // The classic pair is a call-in lead plus a form submission from the same
    // person — the caller-ID name and the typed name rarely match, but the
    // number does. Uses the indexed generated columns, not a JS scan.
    if (contactRes.data) {
      const filters: string[] = [];
      const digits = String(contactRes.data.phone ?? '')
        .replace(/\D/g, '')
        .slice(-10);
      if (digits.length === 10) filters.push(`phone_normalized.eq.${digits}`);
      const email = String(contactRes.data.email ?? '')
        .trim()
        .toLowerCase();
      if (email && !/[,()]/.test(email)) filters.push(`email_normalized.eq.${email}`);
      if (filters.length) {
        const { data: dups } = await supabase
          .from('contacts')
          .select('id, name, phone, email, created_at')
          .or(filters.join(','))
          .neq('id', contactId)
          .limit(5);
        setDuplicates(dups ?? []);
      } else {
        setDuplicates([]);
      }
    }

    setStatuses(statusRes.data ?? []);
    setStages(stageRes.data ?? []);
    setCustomFields(fieldsRes.data ?? []);
    setActivity(activityRes.data ?? []);

    const slots: LinkSlot[] = Array.from({ length: 14 }, (_, i) => {
      const existing = (linksRes.data ?? []).find((l: any) => l.position === i + 1);
      return {
        position: i + 1,
        url: existing?.url ?? '',
        status: existing?.status ?? 'live',
        difficulty: existing?.difficulty ?? null,
      };
    });
    setLinks(slots);
  }, [supabase, contactId]);

  const loadEmailTab = useCallback(async () => {
    const [messagesRes, enrollRes, memberRes, listsRes, accountsRes] = await Promise.all([
      supabase
        .from('email_messages')
        .select('*')
        .eq('contact_id', contactId)
        .order('created_at', { ascending: false })
        .limit(30),
      supabase
        .from('sequence_enrollments')
        .select('*, email_sequences ( name )')
        .eq('contact_id', contactId),
      supabase
        .from('email_list_members')
        .select('id, list_id, email_lists ( name )')
        .eq('contact_id', contactId),
      supabase.from('email_lists').select('id, name').order('name'),
      supabase.from('email_accounts_safe').select('id, name, from_email').order('name'),
    ]);
    setMessages(messagesRes.data ?? []);
    setEnrollments(enrollRes.data ?? []);
    setListMemberships(memberRes.data ?? []);
    setAllLists(listsRes.data ?? []);
    setAccounts(accountsRes.data ?? []);
  }, [supabase, contactId]);

  const loadFiles = useCallback(async () => {
    const res = await fetch(`/api/contacts/${contactId}/files`);
    if (res.ok) setFiles((await res.json()).files ?? []);
  }, [contactId]);

  const loadCandidates = useCallback(async () => {
    const res = await fetch(`/api/contacts/${contactId}/candidates`);
    if (res.ok) {
      const data = await res.json();
      setCandidates(data.candidates ?? []);
      // Identity profiles: the same candidates grouped by which PERSON their
      // page describes. Two or more state groups means the queue mixes people.
      setProfiles(data.profiles ?? []);
    }
  }, [contactId]);

  const loadCalls = useCallback(async () => {
    const { data } = await supabase
      .from('calls')
      .select('*')
      .eq('contact_id', contactId)
      .order('started_at', { ascending: false, nullsFirst: false })
      .limit(50);
    setCalls(data ?? []);
  }, [supabase, contactId]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (tab === 'Email') loadEmailTab();
    if (tab === 'Files') loadFiles();
    if (tab === 'Calls') loadCalls();
    if (tab === 'Link Data') loadCandidates();
  }, [tab, loadEmailTab, loadFiles, loadCalls, loadCandidates]);

  async function patchContact(patch: Record<string, any>) {
    setBusy('save');
    const res = await fetch(`/api/contacts/${contactId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    setBusy(null);
    if (res.ok) {
      await load();
      onChanged();
    } else {
      alert((await res.json()).error ?? 'Save failed');
    }
  }

  async function saveLinks() {
    setBusy('links');
    const res = await fetch(`/api/contacts/${contactId}/links`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links }),
    });
    setBusy(null);
    if (res.ok) {
      await load();
      onChanged();
    } else {
      alert((await res.json()).error ?? 'Save failed');
    }
  }

  // Admin-pressed Trestle lookup. Forces the provider call — the point of the
  // button is to SEE what the provider says about the number — but the server
  // still only ever fills blank fields; nothing a human typed is overwritten.
  async function runReverseLookup() {
    setBusy('reverse');
    setReverseResult(null);
    try {
      const res = await fetch(`/api/contacts/${contactId}/enrich`, { method: 'POST' });
      const data = await res.json().catch(() => ({}) as any);
      if (data.error) {
        setReverseResult(data.error);
      } else if (!data.identity) {
        setReverseResult(data.reason ?? 'No result from provider');
      } else {
        const who = data.identity.name ?? 'no name on record';
        const where =
          data.identity.city && data.identity.state
            ? `${data.identity.city}, ${data.identity.state}`
            : 'no location';
        const line = data.identity.lineType ? ` · ${data.identity.lineType}` : '';
        const applied = data.filled?.length
          ? ` — filled ${data.filled.join(', ')}`
          : ' — nothing filled (fields already set)';
        setReverseResult(`Trestle: ${who} · ${where}${line}${applied}`);
        if (data.filled?.length) {
          await load();
          onChanged();
        }
      }
    } finally {
      setBusy(null);
    }
  }

  // Type-ahead for the merge picker. Commas and parens are stripped because
  // they are PostgREST filter syntax, not searchable text.
  async function searchMergeTargets(q: string) {
    setMergeQuery(q);
    const cleaned = q.trim().replace(/[,()]/g, '');
    if (cleaned.length < 2) {
      setMergeResults([]);
      return;
    }
    const like = `%${cleaned}%`;
    const { data } = await supabase
      .from('contacts')
      .select('id, name, phone, email, created_at')
      .neq('id', contactId)
      .or(`name.ilike.${like},email.ilike.${like},phone.ilike.${like}`)
      .order('created_at', { ascending: false })
      .limit(8);
    setMergeResults(data ?? []);
  }

  // Merges OTHER into THIS contact: this contact's fields win, blanks fill,
  // every call/email/link/note moves here, and the duplicate is deleted — all
  // in one database transaction (a half-merge would be worse than none).
  async function mergeContact(other: any) {
    const otherLabel = other.name?.trim() || other.phone || other.email || other.id;
    if (
      !confirm(
        `Merge "${otherLabel}" into "${contact.name || 'this contact'}"?\n\n` +
          `This contact's fields win; blanks fill from the other. All calls, emails, ` +
          `links, and history move here, then the duplicate is deleted. This cannot be undone.`
      )
    )
      return;
    setBusy('merge');
    try {
      const res = await fetch(`/api/contacts/${contactId}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mergeId: other.id }),
      });
      const data = await res.json().catch(() => ({}) as any);
      if (!res.ok) {
        alert(data.error ?? 'Merge failed');
        return;
      }
      setMergeOpen(false);
      setMergeQuery('');
      setMergeResults([]);
      await load();
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function monitorDeepSearch(previousCompletedAt: string | null) {
    const token = Symbol('deep-search-poll');
    deepSearchPoll.current = token;
    let refreshFailures = 0;

    for (let attempt = 0; attempt < DEEP_SEARCH_POLL_LIMIT; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, DEEP_SEARCH_POLL_INTERVAL_MS));
      if (deepSearchPoll.current !== token) return;
      if (document.visibilityState !== 'visible') continue;

      try {
        const { data, error } = await supabase
          .from('contacts')
          .select('deep_search_queued_at, deep_searched_at, search_flag')
          .eq('id', contactId)
          .maybeSingle();
        if (deepSearchPoll.current !== token) return;
        if (error) throw error;
        if (!data) {
          setDeepSearchStatus('This contact no longer exists.');
          deepSearchPoll.current = null;
          return;
        }
        refreshFailures = 0;

        if (!data.deep_search_queued_at) {
          deepSearchPoll.current = null;
          await Promise.allSettled([load(), loadCandidates()]);
          onChanged();
          const failureFlag =
            typeof data.search_flag === 'string' && /deep search failed/i.test(data.search_flag);
          setDeepSearchStatus(
            failureFlag
              ? `Deep search failed: ${data.search_flag}`
              : data.deep_searched_at && data.deep_searched_at !== previousCompletedAt
                ? data.search_flag
                  ? `Deep search completed with a warning: ${data.search_flag}`
                  : `Deep search completed ${new Date(data.deep_searched_at).toLocaleString()}.`
                : data.search_flag
                  ? `Deep search stopped: ${data.search_flag}`
                  : 'Deep search stopped without completing. Check Admin → Debug Log.'
          );
          return;
        }
      } catch (error) {
        refreshFailures += 1;
        if (refreshFailures >= 3) {
          deepSearchPoll.current = null;
          setDeepSearchStatus(
            `Could not refresh deep-search status: ${
              error instanceof Error ? error.message : 'network error'
            }. Check Admin → Debug Log.`
          );
          return;
        }
      }
    }

    if (deepSearchPoll.current !== token) return;
    deepSearchPoll.current = null;
    await Promise.allSettled([load(), loadCandidates()]);
    onChanged();
    setDeepSearchStatus(
      'Deep search is still queued after 20 minutes. Check Admin → Debug Log for worker errors.'
    );
  }

  // With a focusDate the run branches out ONE arrest: that date drives every
  // search window and date-built URL, so a three-arrest person gets three
  // focused sweeps instead of one blurred one.
  async function runDeepSearch(focusDate?: string) {
    setBusy(focusDate ? `deep-${focusDate}` : 'deep');
    const previousCompletedAt = contact?.deep_searched_at ?? null;
    try {
      const res = await fetch(`/api/contacts/${contactId}/deep-search`, {
        method: 'POST',
        ...(focusDate
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ focusDate }),
            }
          : {}),
      });
      // A 500 from an unhandled server error carries no JSON body, and parsing
      // it threw BEFORE the spinner was cleared — so a request that failed
      // outright looked like a button that span forever. Never let the shape of
      // an error response decide whether the UI recovers.
      const data = await res.json().catch(() => ({} as any));
      if (res.ok) {
        if (data.status === 'already completed this hour') {
          deepSearchPoll.current = null;
          setDeepSearchStatus('Deep search already completed this hour. Showing its latest results.');
          alert('Deep search already completed this hour. Showing its latest results.');
          await Promise.allSettled([load(), loadCandidates()]);
          onChanged();
          return;
        }

        const alreadyQueued = data.status === 'already queued' || data.duplicate;
        const queuedMessage = alreadyQueued
          ? 'Deep search is already queued.'
          : focusDate
            ? `Deep search queued, focused on the ${focusDate} arrest.`
            : 'Deep search queued. Results will appear after the next worker tick.';
        setDeepSearchStatus(
          alreadyQueued
            ? 'Deep search already queued — waiting for the worker.'
            : 'Deep search queued — waiting for the worker.'
        );
        alert(queuedMessage);
        // Pick up the authoritative queue stamp immediately, then monitor the
        // background job until it completes/fails or this bounded poll expires.
        await Promise.allSettled([load()]);
        onChanged();
        void monitorDeepSearch(previousCompletedAt);
      } else {
        alert(data.error ?? `Deep search failed (HTTP ${res.status})`);
        setDeepSearchStatus(data.error ?? `Deep search could not be queued (HTTP ${res.status}).`);
      }
    } catch (e: any) {
      alert(`Deep search could not be started: ${e?.message ?? 'network error'}`);
      setDeepSearchStatus(`Deep search could not be started: ${e?.message ?? 'network error'}`);
    } finally {
      setBusy(null);
    }
  }

  async function clearCandidates() {
    // Spelled out because it is irreversible and removes more than the visible
    // list: dismissed rows are what suppress a URL on later runs.
    if (
      !confirm(
        'Clear found links for this contact?\n\n' +
          '• Removes links awaiting review and previously dismissed ones\n' +
          '• Links accepted into slots, and anything you confirmed (🔒), are kept\n' +
          '• Facts are NOT touched — clear those individually per row\n\n' +
          'The next deep search can then find those links again.'
      )
    ) {
      return;
    }
    setBusy('clear');
    try {
      const res = await fetch(`/api/contacts/${contactId}/candidates`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        alert(data.error ?? `Could not clear results (HTTP ${res.status})`);
        return;
      }
      await Promise.all([load(), loadCandidates()]);
      onChanged();
    } catch (e: any) {
      alert(`Could not clear results: ${e?.message ?? 'network error'}`);
    } finally {
      setBusy(null);
    }
  }

  async function reviewCandidate(candidateId: string, action: 'accept' | 'reject' | 'confirm') {
    setBusy(`cand-${candidateId}`);
    try {
      const res = await fetch(`/api/contacts/${contactId}/candidates`, {
        method: 'PATCH',
        headers: { 'Conte…12209 tokens truncated…                     </span>
                          ) : (
                            <span className="flex-none text-[10px] text-gray-400">{c.status}</span>
                          )}
                        </div>
                      </div>
                  );

                  // Identity grouping. With two or more states in play these
                  // are different PEOPLE, so the unreviewed queue is shown per
                  // person with one decision per group instead of one per link.
                  // Reviewed candidates, search views, and anything without a
                  // state signal stay in the flat list below the groups.
                  const stateProfiles = profiles.filter(
                    (p: any) => p.state && (p.candidate_ids?.length ?? 0) > 0
                  );
                  const grouped = stateProfiles.length >= 2;
                  const byId = new Map(candidates.map((c: any) => [c.id, c]));
                  const inGroups = new Set(stateProfiles.flatMap((p: any) => p.candidate_ids));
                  const rest = grouped
                    ? candidates.filter((c: any) => !inGroups.has(c.id))
                    : candidates;
                  const cap = (s: string) => s.replace(/\b\w/g, (ch: string) => ch.toUpperCase());

                  return (
                    <div>
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="text-[10px] font-medium tracking-widest text-gray-500 uppercase dark:text-gray-600">
                          Candidates found ({newCandidateCount} to review)
                        </div>
                        {/* Admin-only, like the deep search that produced these. */}
                        {isAdmin && (
                          <button
                            type="button"
                            onClick={clearCandidates}
                            disabled={busy === 'clear'}
                            title="Remove found links awaiting review and previously dismissed ones. Facts are kept — clear those per row."
                            className="text-[10px] font-medium text-gray-500 underline decoration-dotted hover:text-red-600 disabled:opacity-50"
                          >
                            {busy === 'clear' ? 'Clearing…' : 'Clear links'}
                          </button>
                        )}
                      </div>
                      {grouped && (
                        <div className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-800">
                          These candidates describe {stateProfiles.length} different people.
                          "This is them" saves that group's state and counties as confirmed
                          facts and dismisses the other states' candidates in one click.
                        </div>
                      )}
                      {grouped &&
                        stateProfiles.map((p: any) => (
                          <div key={p.key} className="mb-3">
                            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                              <div className="text-[11px] font-semibold text-gray-700">
                                {p.state}
                                {p.counties.length > 0 && (
                                  <span className="font-normal text-gray-500">
                                    {' '}
                                    — {p.counties.map(cap).join(', ')}
                                  </span>
                                )}
                                {p.middles.length > 0 && (
                                  <span className="font-normal text-gray-500">
                                    {' '}
                                    · middle {p.middles.map(cap).join('/')}
                                  </span>
                                )}
                                <span className="font-normal text-gray-400">
                                  {' '}
                                  · {p.candidate_ids.length} link
                                  {p.candidate_ids.length === 1 ? '' : 's'}
                                </span>
                              </div>
                              {isAdmin && (
                                <div className="flex flex-none gap-1">
                                  <button
                                    type="button"
                                    className="btn px-2 py-0.5 text-xs"
                                    disabled={busy === `profile-${p.key}`}
                                    onClick={() => decideProfile(p, 'choose_profile')}
                                    title="Confirm this group's state and counties as this person's, and dismiss the candidates from other states"
                                  >
                                    This is them
                                  </button>
                                  <button
                                    type="button"
                                    className="btn px-2 py-0.5 text-xs text-gray-500"
                                    disabled={busy === `profile-${p.key}`}
                                    onClick={() => decideProfile(p, 'reject_profile')}
                                    title="Dismiss every candidate in this group — it is a different person"
                                  >
                                    Not them
                                  </button>
                                </div>
                              )}
                            </div>
                            <div className="space-y-1.5">
                              {p.candidate_ids
                                .map((cid: string) => byId.get(cid))
                                .filter(Boolean)
                                .map(renderCandidate)}
                            </div>
                          </div>
                        ))}
                      <div className="space-y-1.5">{rest.map(renderCandidate)}</div>
                    </div>
                  );
                })()}
            </div>
          )}

          {tab === 'Email' && (
            <div className="space-y-5">
              <div>
                <div className="label">Email lists</div>
                <div className="flex flex-wrap items-center gap-2">
                  {listMemberships.map((m: any) => (
                    <span
                      key={m.id}
                      className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs"
                    >
                      {m.email_lists?.name}
                      {isAdmin && (
                      <button
                        className="text-gray-400 hover:text-red-600"
                        onClick={async () => {
                          await supabase.from('email_list_members').delete().eq('id', m.id);
                          loadEmailTab();
                        }}
                      >
                        ✕
                      </button>
                      )}
                    </span>
                  ))}
                  {isAdmin && <select
                    className="input w-44"
                    value=""
                    onChange={async (e) => {
                      if (!e.target.value) return;
                      await supabase
                        .from('email_list_members')
                        .insert({ list_id: e.target.value, contact_id: contactId });
                      loadEmailTab();
                    }}
                  >
                    <option value="">+ Add to list…</option>
                    {allLists
                      .filter((l) => !listMemberships.some((m: any) => m.list_id === l.id))
                      .map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                  </select>}
                </div>
              </div>

              <div>
                <div className="label">Current email sequences</div>
                {enrollments.length === 0 && (
                  <div className="text-sm text-gray-400">Not enrolled in any sequence.</div>
                )}
                {enrollments.map((e: any) => (
                  <div key={e.id} className="mb-1 flex items-center gap-2 text-sm">
                    <span className="font-medium">{e.email_sequences?.name}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        e.status === 'active'
                          ? 'bg-green-100 text-green-700'
                          : e.status === 'stopped'
                            ? 'bg-red-100 text-red-700'
                            : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {e.status}
                      {e.stop_reason ? ` (${e.stop_reason})` : ''}
                    </span>
                    <span className="text-xs text-gray-400">step {e.current_step}</span>
                  </div>
                ))}
              </div>

              <div>
                <div className="label">Engagement</div>
                <div className="flex gap-4 text-sm">
                  <span>📬 {messages.filter((m) => m.direction === 'outbound').length} sent</span>
                  <span>👁 {messages.reduce((n, m) => n + m.open_count, 0)} opens</span>
                  <span>🖱 {messages.reduce((n, m) => n + m.click_count, 0)} clicks</span>
                  <span>↩ {messages.filter((m) => m.replied || m.direction === 'inbound').length} replies</span>
                </div>
              </div>

              <div>
                <div className="label">Compose</div>
                <div className="space-y-2">
                  {accounts.length > 0 && (
                    <select
                      className="input"
                      value={compose.accountId}
                      onChange={(e) => setCompose((c) => ({ ...c, accountId: e.target.value }))}
                    >
                      <option value="">Default account</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name} ({a.from_email})
                        </option>
                      ))}
                    </select>
                  )}
                  <input
                    className="input"
                    placeholder="Subject"
                    value={compose.subject}
                    onChange={(e) => setCompose((c) => ({ ...c, subject: e.target.value }))}
                  />
                  <textarea
                    className="input min-h-24"
                    placeholder="Message… ({{name}}, {{city}} placeholders work)"
                    value={compose.html}
                    onChange={(e) => setCompose((c) => ({ ...c, html: e.target.value }))}
                  />
                  <button className="btn btn-primary" disabled={busy === 'email'} onClick={sendEmail}>
                    {busy === 'email' ? 'Sending…' : 'Send email'}
                  </button>
                </div>
              </div>

              <div>
                <div className="label">History</div>
                <div className="space-y-1.5">
                  {messages.map((m) => (
                    <div key={m.id} className="rounded-lg border border-gray-100 px-3 py-2 text-sm">
                      <div className="flex items-center gap-2">
                        <span>{m.direction === 'outbound' ? '→' : '←'}</span>
                        <span className="flex-1 truncate font-medium">{m.subject}</span>
                        <span className="text-xs text-gray-400">
                          {new Date(m.created_at).toLocaleDateString()}
                        </span>
                      </div>
                      <div className="mt-0.5 flex gap-3 text-xs text-gray-400">
                        <span>{m.status}</span>
                        {m.open_count > 0 && <span>{m.open_count} opens</span>}
                        {m.click_count > 0 && <span>{m.click_count} clicks</span>}
                        {m.replied && <span className="text-green-600">replied</span>}
                        {m.bounced && <span className="text-red-600">bounced</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {customFor('email').length > 0 && (
                <div>
                  <div className="grid grid-cols-2 gap-3">{customInputs('email')}</div>
                  <div className="mt-2">{saveButton([])}</div>
                </div>
              )}
            </div>
          )}

          {tab === 'Calls' && (
            <div className="space-y-3">
              {calls.map((c) => (
                <div key={c.id} className="rounded-lg border border-gray-100 px-3 py-2.5 text-sm">
                  <div className="flex items-center gap-2">
                    <span>{c.direction === 'outbound' ? '📤' : '📞'}</span>
                    <span className="font-medium">
                      {c.started_at ? new Date(c.started_at).toLocaleString() : '—'}
                    </span>
                    <span className="text-xs text-gray-400">{callDuration(c.duration_seconds)}</span>
                    <span className="text-xs text-gray-400">{c.status}</span>
                    <span className="flex-1" />
                    {c.ai_category && (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          AI_CATEGORY_STYLES[c.ai_category] ?? 'bg-gray-100 text-gray-600'
                        }`}
                        title={c.qualified_ai ? 'AI-qualified lead' : undefined}
                      >
                        {c.ai_category.replace('_', ' ')}
                        {c.ai_score != null ? ` · ${c.ai_score}` : ''}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex gap-3 text-xs text-gray-400">
                    <span>{c.caller_number}</span>
                    {c.caller_name && <span>{c.caller_name}</span>}
                    {c.tracking_number && <span>via {c.tracking_number}</span>}
                  </div>
                  {c.recording_url && (
                    // preload="none": don't fetch every recording just to render the list
                    <audio controls preload="none" src={c.recording_url} className="mt-2 h-8 w-full" />
                  )}
                  {c.summary && <p className="mt-2 text-xs text-gray-600">{c.summary}</p>}
                  {c.transcription && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-brand-600 select-none">
                        Transcript
                      </summary>
                      <p className="mt-1 text-xs whitespace-pre-wrap text-gray-600">
                        {c.transcription}
                      </p>
                    </details>
                  )}
                </div>
              ))}
              {calls.length === 0 && (
                <div className="text-sm text-gray-400">
                  No calls yet. Calls arrive automatically once the CallScaler webhook is configured
                  (Admin → Integrations).
                </div>
              )}
            </div>
          )}

          {tab === 'Activity' && (
            <div className="space-y-4">
              <div className="flex gap-2">
                <input
                  className="input"
                  placeholder="Add a note…"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addNote()}
                />
                <button className="btn btn-primary" onClick={addNote}>
                  Add
                </button>
              </div>
              <div className="space-y-2">
                {activity.map((a) => (
                  <div key={a.id} className="flex gap-3 text-sm">
                    <div className="w-32 shrink-0 text-xs text-gray-400">
                      {new Date(a.created_at).toLocaleString()}
                    </div>
                    <div>
                      <span className="mr-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-gray-500 uppercase">
                        {a.type}
                      </span>
                      {a.description}
                      {a.profiles && (
                        <span className="ml-1 text-xs text-gray-400">
                          — {a.profiles.full_name || a.profiles.email}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
                {activity.length === 0 && (
                  <div className="text-sm text-gray-400">No activity yet.</div>
                )}
              </div>
            </div>
          )}

          {tab === 'Files' && (
            <div className="space-y-4">
              <label className="btn btn-primary inline-block cursor-pointer">
                {busy === 'file' ? 'Uploading…' : '⬆ Upload file'}
                <input
                  type="file"
                  className="hidden"
                  onChange={(e) => e.target.files?.[0] && uploadFile(e.target.files[0])}
                />
              </label>
              <div className="space-y-1.5">
                {files.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-center gap-3 rounded-lg border border-gray-100 px-3 py-2 text-sm"
                  >
                    <a
                      href={f.url ?? '#'}
                      target="_blank"
                      rel="noreferrer"
                      className="flex-1 truncate text-brand-600 hover:underline"
                    >
                      {f.name}
                    </a>
                    <span className="text-xs text-gray-400">
                      {(f.size_bytes / 1024).toFixed(0)} KB
                    </span>
                    <button
                      className="text-xs text-gray-400 hover:text-red-600"
                      onClick={async () => {
                        if (!confirm(`Delete ${f.name}?`)) return;
                        await fetch(`/api/contacts/${contactId}/files?fileId=${f.id}`, {
                          method: 'DELETE',
                        });
                        loadFiles();
                      }}
                    >
                      Delete
                    </button>
                  </div>
                ))}
                {files.length === 0 && <div className="text-sm text-gray-400">No files yet.</div>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
