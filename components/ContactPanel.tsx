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
  siblingIds,
  onNavigate,
}: {
  contactId: string;
  onClose: () => void;
  onChanged: () => void;
  // The list this contact was opened from, in display order, so the panel can
  // step to the next/previous record without closing. Optional — the panel
  // works standalone, just without the arrows.
  siblingIds?: string[];
  onNavigate?: (id: string) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const { isAdmin } = useMyRole(); // revenue figures are admin-only
  const [tab, setTab] = useState<Tab>('Contact Info');
  const [contact, setContact] = useState<any>(null);
  const [contactLoadError, setContactLoadError] = useState('');
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

  // Step to the previous/next contact in the list this panel was opened from.
  // The panel reloads on contactId change, so navigating is just swapping the id.
  const siblingIndex = siblingIds ? siblingIds.indexOf(contactId) : -1;
  const hasPrev = siblingIndex > 0;
  const hasNext = siblingIndex >= 0 && siblingIndex < (siblingIds?.length ?? 0) - 1;
  const goToSibling = useCallback(
    (delta: -1 | 1) => {
      if (!siblingIds || !onNavigate) return;
      const i = siblingIds.indexOf(contactId);
      const next = i + delta;
      if (i < 0 || next < 0 || next >= siblingIds.length) return;
      onNavigate(siblingIds[next]);
    },
    [siblingIds, onNavigate, contactId]
  );

  // Arrow keys navigate too, but never while typing in a field.
  useEffect(() => {
    if (!siblingIds || !onNavigate) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
      e.preventDefault();
      goToSibling(e.key === 'ArrowUp' ? -1 : 1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [siblingIds, onNavigate, goToSibling]);

  const load = useCallback(async () => {
    setContactLoadError('');
    const [contactRes, linksRes, statusRes, stageRes, fieldsRes, activityRes] = await Promise.all([
      fetch(`/api/contacts/${contactId}`, { cache: 'no-store' }).then(async (response) => {
        const body = await response.json().catch(() => ({}));
        return response.ok
          ? { data: body.contact, error: null }
          : { data: null, error: new Error(body.error ?? 'Could not load contact') };
      }),
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

    if (contactRes.error) {
      setContactLoadError(contactRes.error.message ?? 'Could not load contact');
      setContact(null);
      return;
    }
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
        // No modal for the routine queued case — the inline status line and the
        // amber search icon already say a run is in flight, and a popup on every
        // click was just noise. Errors below still alert.
        setDeepSearchStatus(
          alreadyQueued
            ? 'Deep search already queued — waiting for the worker.'
            : focusDate
              ? `Deep search queued, focused on the ${focusDate} arrest — waiting for the worker.`
              : 'Deep search queued — waiting for the worker.'
        );
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId, action }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        alert(data.error ?? `Could not update candidate (HTTP ${res.status})`);
        return;
      }
      await Promise.all([loadCandidates(), load()]);
      // Accept fills a slot; confirm changes learned facts. Both alter what the
      // rest of the panel shows, so refresh the parent list too.
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  // Confirm/unconfirm a single fact value, or a URL a human found. All write to
  // the contact's confirmed_facts, so reload the contact to reflect it.
  async function mutateConfirmed(
    payload: Record<string, unknown>,
    busyKey: string
  ): Promise<boolean> {
    setBusy(busyKey);
    try {
      const res = await fetch(`/api/contacts/${contactId}/candidates`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        alert(data.error ?? `Could not update (HTTP ${res.status})`);
        return false;
      }
      await Promise.all([load(), loadCandidates()]);
      onChanged();
      return true;
    } finally {
      setBusy(null);
    }
  }

  async function confirmUrl() {
    const url = (confirmUrlValue || '').trim();
    if (!/^https?:\/\/\S+$/i.test(url)) {
      alert('Enter a full URL starting with http:// or https://');
      return;
    }
    if (await mutateConfirmed({ action: 'confirm_url', url }, 'confirm-url')) {
      setConfirmUrlValue('');
    }
  }

  // One decision per person instead of one per link: "This is them" confirms
  // the group's state and counties and dismisses the other states' candidates;
  // "Not them" dismisses just that group. The server regroups the stored
  // candidates itself, so nothing here is trusted beyond the state key.
  async function decideProfile(p: any, decision: 'choose_profile' | 'reject_profile') {
    const where = [p.state, ...(p.counties ?? [])].filter(Boolean).join(', ');
    const n = p.candidate_ids?.length ?? 0;
    const msg =
      decision === 'choose_profile'
        ? `This is them — ${where}?\n\nThe state and counties are saved as confirmed facts (they seed every run), and candidates from other states are dismissed.`
        : `Not them — dismiss ${n} ${p.state} candidate${n === 1 ? '' : 's'}?\n\nNothing is saved about the rest; this only clears the wrong person's links.`;
    if (!confirm(msg)) return;
    await mutateConfirmed({ action: decision, state: p.state }, `profile-${p.key}`);
  }

  // A county typed by a human is truth, not a guess — same store the ✓ writes
  // to, so it seeds every run even before the first search finds anything.
  // A metro like Atlanta spans several counties (Fulton, DeKalb, Cobb), so a
  // comma- or newline-separated list is accepted and each becomes its own
  // confirmed county; the deep search then probes them one after another.
  async function confirmCounty() {
    const counties = countyValue
      .split(/[,\n]/)
      .map((c) => c.trim())
      .filter(Boolean);
    if (!counties.length) return;
    setBusy('confirm-county');
    try {
      let anyOk = false;
      for (const county of counties) {
        const res = await fetch(`/api/contacts/${contactId}/candidates`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'confirm_fact', key: 'county', value: county }),
        });
        const data = await res.json().catch(() => ({}) as any);
        if (!res.ok) {
          alert(data.error ?? `Could not add "${county}" (HTTP ${res.status})`);
          break;
        }
        anyOk = true;
      }
      if (anyOk) {
        setCountyValue('');
        await Promise.all([load(), loadCandidates()]);
        onChanged();
      }
    } finally {
      setBusy(null);
    }
  }

  async function sendEmail() {
    if (!compose.subject || !compose.html) return alert('Subject and body required');
    setBusy('email');
    const res = await fetch('/api/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contactId,
        subject: compose.subject,
        html: compose.html.replace(/\n/g, '<br/>'),
        accountId: compose.accountId || null,
      }),
    });
    setBusy(null);
    if (res.ok) {
      setCompose({ subject: '', html: '', accountId: compose.accountId });
      loadEmailTab();
    } else {
      alert((await res.json()).error ?? 'Send failed');
    }
  }

  async function addNote() {
    if (!note.trim()) return;
    const {
      data: { user },
    } = await supabase.auth.getUser();
    await supabase.from('activity_log').insert({
      contact_id: contactId,
      actor_id: user?.id ?? null,
      type: 'note',
      description: note.trim(),
    });
    setNote('');
    load();
  }

  async function uploadFile(file: File) {
    setBusy('file');
    const form = new FormData();
    form.append('file', file);
    await fetch(`/api/contacts/${contactId}/files`, { method: 'POST', body: form });
    setBusy(null);
    loadFiles();
  }

  function setField(key: string, value: any) {
    setContact((c: any) => ({ ...c, [key]: value }));
  }
  function setCustom(key: string, value: any) {
    setContact((c: any) => ({ ...c, custom: { ...(c.custom ?? {}), [key]: value } }));
  }

  const customFor = (tabKey: string) => customFields.filter((f) => f.tab === tabKey);

  const isClient = !!contact?.statuses?.is_client_status || !!contact?.client_since;
  const daysLeft = contact?.client_since
    ? (contact.service_days ?? defaultServiceDays) -
      Math.floor((Date.now() - new Date(contact.client_since).getTime()) / 86400000)
    : null;
  /** Deep-search hits still awaiting a human decision. */
  const newCandidateCount = candidates.filter((c) => c.status === 'new').length;

  useEffect(() => {
    // default service days (admin setting) is not exposed to workers via settings
    // table RLS, so we just fall back to 90 client-side for display purposes.
    setDefaultServiceDays(90);
  }, []);

  if (contactLoadError) {
    return (
      <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={onClose}>
        <div className="h-full w-full max-w-2xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{contactLoadError}</div>
          <button className="btn mt-4" onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }
  if (!contact) return null;

  const input = (label: string, key: string, type = 'text', readOnly = false) => (
    <div>
      <label className="label">{label}</label>
      <input
        className="input"
        type={type}
        readOnly={readOnly}
        value={contact[key] ?? ''}
        onChange={(e) => setField(key, e.target.value)}
      />
    </div>
  );

  const customInputs = (tabKey: string) =>
    customFor(tabKey).map((field) => (
      <div key={field.id}>
        <label className="label">{field.label}</label>
        {field.field_type === 'select' ? (
          <select
            className="input"
            value={contact.custom?.[field.field_key] ?? ''}
            onChange={(e) => setCustom(field.field_key, e.target.value)}
          >
            <option value="">—</option>
            {(field.options ?? []).map((opt: string) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="input"
            type={field.field_type === 'number' ? 'number' : field.field_type === 'date' ? 'date' : 'text'}
            value={contact.custom?.[field.field_key] ?? ''}
            onChange={(e) => setCustom(field.field_key, e.target.value)}
          />
        )}
      </div>
    ));

  const saveButton = (fields: string[]) => (
    <button
      className="btn btn-primary"
      disabled={busy === 'save'}
      onClick={() => {
        const patch: Record<string, any> = { custom: contact.custom };
        for (const f of fields) patch[f] = contact[f] === '' ? null : contact[f];
        patchContact(patch);
      }}
    >
      {busy === 'save' ? 'Saving…' : 'Save'}
    </button>
  );

  return (
    <div className="anim-fade-in fixed inset-0 z-40 flex justify-end bg-black/20" onClick={onClose}>
      <div
        className="anim-slide-in flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="border-b border-gray-200 px-5 pt-4">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="flex items-center gap-2 text-2xl font-light tracking-tight">
                {contact.name}
                {contact.name_source === 'reverse_lookup' && (
                  <span
                    className="text-base"
                    title="Name came from a reverse phone lookup — it may not be accurate. Editing it by hand clears this marker."
                    aria-label="Name derived from a reverse phone lookup"
                  >
                    📞
                  </span>
                )}
              </h2>
              <div className="mt-1 flex items-center gap-2">
                <StatusPill
                  status={contact.statuses}
                  options={statuses}
                  onChange={(statusId) => patchContact({ status_id: statusId })}
                />
                {contact.reputation_score != null && (
                  <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium">
                    Rep {contact.reputation_score}
                  </span>
                )}
                {isClient && daysLeft != null && (
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      daysLeft <= 7 ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
                    }`}
                  >
                    ⏱ {daysLeft} day{daysLeft === 1 ? '' : 's'} left
                  </span>
                )}
                {isAdmin && contact.revenue_projection > 0 && (
                  <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700">
                    Projected ${Number(contact.revenue_projection).toLocaleString()}
                  </span>
                )}
                {/* Deep search from the header, so a run doesn't require a
                    trip into Link Data. Same stamps and 30-minute staleness
                    rule as the grid icon: amber = genuinely in flight, green =
                    completed (click re-runs), red = never run (click runs). */}
                {(() => {
                  const queuedAge = contact.deep_search_queued_at
                    ? Date.now() - new Date(contact.deep_search_queued_at).getTime()
                    : Infinity;
                  const inFlight = busy === 'deep' || queuedAge < 30 * 60_000;
                  const done = !!contact.deep_searched_at;
                  return (
                    <button
                      type="button"
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition ${
                        inFlight
                          ? 'cursor-default bg-amber-100 text-amber-700'
                          : done
                            ? 'bg-green-100 text-green-700 hover:bg-green-200'
                            : 'bg-red-100 text-red-700 hover:bg-red-200'
                      } ${!isAdmin && !inFlight ? 'cursor-default' : ''}`}
                      disabled={inFlight || !isAdmin}
                      title={
                        inFlight
                          ? 'Deep search queued — runs on the next worker tick'
                          : done
                            ? `Completed ${new Date(contact.deep_searched_at).toLocaleString()}${
                                isAdmin ? ' — click to run again' : ''
                              }`
                            : isAdmin
                              ? 'Deep search never run — click to run it'
                              : 'Deep search never run'
                      }
                      onClick={() => runDeepSearch()}
                    >
                      {inFlight ? '🕵 Searching…' : '🕵 Deep search'}
                    </button>
                  );
                })()}
              </div>
            </div>
            <div className="flex flex-none items-center gap-1">
              {siblingIndex >= 0 && (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost px-2 disabled:opacity-30"
                    disabled={!hasPrev}
                    onClick={() => goToSibling(-1)}
                    title="Previous contact (↑)"
                  >
                    ‹
                  </button>
                  <span
                    className="text-[10px] tabular-nums text-gray-400"
                    title="Position in the list"
                  >
                    {siblingIndex + 1}/{siblingIds?.length}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost px-2 disabled:opacity-30"
                    disabled={!hasNext}
                    onClick={() => goToSibling(1)}
                    title="Next contact (↓)"
                  >
                    ›
                  </button>
                </>
              )}
              <button className="btn btn-ghost" onClick={onClose}>
                ✕
              </button>
            </div>
          </div>
          <div className="mt-3 flex gap-1 overflow-x-auto">
            {TABS.map((t) => (
              <button
                key={t}
                className={`panel-tab ${tab === t ? 'panel-tab-active' : ''}`}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {tab === 'Contact Info' && (
            <div className="space-y-4">
              {/* Same phone or email as another contact — almost always a
                  call-in lead plus a form submission from one person. Surfaced
                  here so nobody has to spot it by eye in the grid. */}
              {isAdmin && duplicates.length > 0 && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <div className="font-semibold">
                    Possible duplicate{duplicates.length > 1 ? 's' : ''} — same phone or email:
                  </div>
                  {duplicates.map((d) => (
                    <div key={d.id} className="mt-1 flex flex-wrap items-center gap-2">
                      <span>
                        {d.name?.trim() || '(unnamed)'} · {d.phone || d.email || '—'} · added{' '}
                        {new Date(d.created_at).toLocaleDateString()}
                      </span>
                      <button
                        className="btn btn-ghost text-xs"
                        disabled={busy === 'merge'}
                        title="Absorb that contact into this record: this record's fields win, blanks fill, all history moves here, the duplicate is deleted"
                        onClick={() => mergeContact(d)}
                      >
                        ⇄ Merge into this record
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                {input('Name', 'name')}
                {input('Email', 'email', 'email')}
                {input('Phone', 'phone')}
                {input('City', 'city')}
                {input('State', 'state')}
                {/* County lives in confirmed_facts, not a contacts column: a
                    county typed here is human knowledge that seeds every deep
                    search, and the 🔒 chips are the same ones the search tab
                    shows. Saved on Enter — the Save button below only writes
                    contact columns. */}
                <div>
                  <label className="label">County</label>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(contact.confirmed_facts?.county ?? []).map((v: string) => (
                      <span
                        key={v}
                        className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-800"
                        title="Confirmed county — seeds every deep search and outranks whatever a search finds"
                      >
                        🔒 {v}
                        {isAdmin && (
                          <button
                            type="button"
                            disabled={busy === `fact-county-${v}`}
                            onClick={() =>
                              mutateConfirmed(
                                { action: 'unconfirm_fact', key: 'county', value: v },
                                `fact-county-${v}`
                              )
                            }
                            className="text-green-700 hover:text-red-600 disabled:opacity-50"
                            title="Remove this confirmed county"
                          >
                            ×
                          </button>
                        )}
                      </span>
                    ))}
                    {isAdmin && (
                      <input
                        className="input min-w-24 flex-1"
                        placeholder={
                          (contact.confirmed_facts?.county ?? []).length
                            ? 'Add another — Enter saves'
                            : 'If known — Enter saves it for the search'
                        }
                        value={countyValue}
                        onChange={(e) => setCountyValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') confirmCounty();
                        }}
                      />
                    )}
                  </div>
                </div>
                <div>
                  <label className="label">Date created</label>
                  <input
                    className="input bg-gray-50"
                    readOnly
                    value={new Date(contact.created_at).toLocaleString()}
                  />
                </div>
                {isClient && (
                  <>
                    <div>
                      <label className="label">Client stage</label>
                      <select
                        className="input"
                        value={contact.stage_id ?? ''}
                        onChange={(e) => setField('stage_id', e.target.value || null)}
                      >
                        <option value="">—</option>
                        {stages.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="label">Service period (days)</label>
                      <input
                        className="input"
                        type="number"
                        value={contact.service_days ?? ''}
                        placeholder={String(defaultServiceDays)}
                        onChange={(e) =>
                          setField('service_days', e.target.value ? Number(e.target.value) : null)
                        }
                      />
                    </div>
                    <div>
                      <label className="label">Signed date</label>
                      <input
                        className="input"
                        type="date"
                        value={contact.signed_date ?? ''}
                        onChange={(e) => setField('signed_date', e.target.value || null)}
                      />
                    </div>
                    {/* Money collected is admin data (like Projected Revenue): the
                        API strips it from non-admin reads and 403s non-admin
                        writes, so only render the field where saving can work. */}
                    {isAdmin && (
                      <div>
                        <label className="label">Gross revenue</label>
                        <input
                          className="input"
                          type="number"
                          step="0.01"
                          value={contact.gross_revenue ?? ''}
                          placeholder="0.00"
                          onChange={(e) =>
                            setField('gross_revenue', e.target.value ? Number(e.target.value) : null)
                          }
                        />
                      </div>
                    )}
                    <div>
                      <label className="label">Service countdown</label>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm text-gray-600">
                          {daysLeft != null
                            ? daysLeft <= 0
                              ? 'Expired'
                              : `${daysLeft} days left`
                            : 'Not started'}
                        </span>
                        <button
                          type="button"
                          className="btn py-1 text-xs"
                          disabled={busy === 'save'}
                          onClick={() => patchContact({ client_since: new Date().toISOString() })}
                        >
                          {contact.client_since ? 'Restart' : 'Start'}
                        </button>
                        {contact.client_since && (
                          <button
                            type="button"
                            className="btn py-1 text-xs"
                            disabled={busy === 'save'}
                            onClick={() => patchContact({ client_since: null })}
                          >
                            Stop
                          </button>
                        )}
                      </div>
                      <p className="mt-1 text-[11px] text-gray-400">
                        Runs {contact.service_days ?? defaultServiceDays} days from when you start it — set the
                        length above.
                      </p>
                    </div>
                  </>
                )}
                {customInputs('contact')}
              </div>

              {/* Reverse phone lookup — admin only, because every press is a
                  billed Trestle call (metered against the same monthly cap as
                  the automatic enrichment). Shows the raw answer; only blank
                  fields are ever written. */}
              {isAdmin && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    className="btn"
                    disabled={busy === 'reverse' || !contact.phone?.trim()}
                    title={
                      contact.phone?.trim()
                        ? 'Ask Trestle who owns this number. Billed per press; only ever fills blank fields.'
                        : 'Needs a phone number first'
                    }
                    onClick={runReverseLookup}
                  >
                    {busy === 'reverse' ? 'Looking up…' : '☎ Reverse # lookup'}
                  </button>
                  {reverseResult && (
                    <span className="text-xs text-gray-600">{reverseResult}</span>
                  )}
                  <button
                    className="btn"
                    onClick={() => setMergeOpen(!mergeOpen)}
                    title="Absorb a duplicate contact into this record"
                  >
                    ⇄ Merge duplicate…
                  </button>
                </div>
              )}
              {isAdmin && mergeOpen && (
                <div className="space-y-2 rounded-lg border border-gray-200 p-3">
                  <div className="text-xs text-gray-500">
                    Find the duplicate to absorb into this record. This contact&apos;s fields win
                    and blanks fill from the other; all calls, emails, links, and history move
                    here; the duplicate is then deleted.
                  </div>
                  <input
                    className="input"
                    placeholder="Search by name, phone, or email"
                    value={mergeQuery}
                    onChange={(e) => searchMergeTargets(e.target.value)}
                  />
                  {mergeResults.map((r) => (
                    <div
                      key={r.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded border border-gray-100 px-2 py-1 text-sm"
                    >
                      <span>
                        {r.name?.trim() || '(unnamed)'}{' '}
                        <span className="text-xs text-gray-400">
                          {[r.phone, r.email].filter(Boolean).join(' · ')} · added{' '}
                          {new Date(r.created_at).toLocaleDateString()}
                        </span>
                      </span>
                      <button
                        className="btn btn-ghost text-xs"
                        disabled={busy === 'merge'}
                        onClick={() => mergeContact(r)}
                      >
                        {busy === 'merge' ? 'Merging…' : '⇄ Merge'}
                      </button>
                    </div>
                  ))}
                  {mergeQuery.trim().length >= 2 && !mergeResults.length && (
                    <div className="text-xs text-gray-400">No matches</div>
                  )}
                </div>
              )}

              {/* Tracking data — where the lead came from. Was its own "Data"
                  tab; folded in here so one save covers the whole record. */}
              <div className="border-t border-gray-200 pt-4">
                <div className="mb-3 text-[10px] font-medium tracking-widest text-gray-400 uppercase">
                  Tracking data
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {input('IP', 'ip')}
                  {input('Browser', 'browser')}
                  {input('Device', 'device')}
                  {input('Source', 'source')}
                  <div className="col-span-2">
                    <label className="label">Source URL</label>
                    <input
                      className="input"
                      value={contact.source_url ?? ''}
                      onChange={(e) => setField('source_url', e.target.value)}
                    />
                  </div>
                  {input('WordPress user', 'wp_user')}
                  <div>
                    <label className="label">Submitted on</label>
                    <input
                      className="input bg-gray-50"
                      readOnly
                      value={
                        contact.submitted_at
                          ? new Date(contact.submitted_at).toLocaleString()
                          : '—'
                      }
                    />
                  </div>
                  {input('PPC KW', 'ppc_kw')}
                  {input('UTM', 'utm')}
                  {input('GCLID', 'gclid')}
                  {customInputs('data')}
                </div>
              </div>

              <div className="flex justify-between">
                {saveButton([
                  'name',
                  'email',
                  'phone',
                  'city',
                  'state',
                  'stage_id',
                  'service_days',
                  'signed_date',
                  'gross_revenue',
                  'browser',
                  'ppc_kw',
                  'source',
                  'ip',
                  'utm',
                  'gclid',
                  'device',
                  'source_url',
                  'wp_user',
                ])}
                <button
                  className="btn text-red-600"
                  onClick={async () => {
                    if (!confirm('Delete this contact permanently?')) return;
                    const res = await fetch(`/api/contacts/${contactId}`, { method: 'DELETE' });
                    if (res.ok) {
                      onChanged();
                      onClose();
                    } else alert((await res.json()).error ?? 'Delete failed (admins only)');
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          )}

          {tab === 'Link Data' && (
            <div className="space-y-4">
              {contact.search_flag && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <span className="mr-1">⚑</span>
                  <span className="font-semibold">Search needs a re-run:</span>{' '}
                  {contact.search_flag}. Fix the cause if it has one (add a city/state, or a
                  commercial ip-api key), then press{' '}
                  <span className="font-semibold">🕵 Deep search</span> below. If the reason is
                  that a page is not indexed yet, wait a few days and re-run — a successful run
                  clears this flag.
                </div>
              )}
              {/*
                Compact stat strip: number and label sit on one line, so the row
                costs roughly a third of the height the stacked cards did and the
                links themselves — the reason this tab exists — start higher up.
              */}
              <div className="flex items-center gap-2">
                <div className="card flex flex-1 items-center justify-center gap-1.5 py-1.5">
                  <span className="text-sm font-medium tabular-nums text-brand-700">
                    {contact.reputation_score ?? '—'}
                  </span>
                  <span className="text-[10px] text-gray-500">Reputation</span>
                </div>
                <div className="card flex flex-1 items-center justify-center gap-1.5 py-1.5">
                  <span className="text-sm font-medium tabular-nums">
                    {contact.link_score ?? '—'}
                  </span>
                  <span className="text-[10px] text-gray-500">Link score</span>
                </div>
                {/*
                  What the last deep search actually turned up. Counts every
                  candidate, with the unreviewed share called out separately,
                  because "12 found" and "12 still to look at" mean different
                  things to whoever opens this tab.
                */}
                <div
                  className="card flex flex-1 items-center justify-center gap-1.5 py-1.5"
                  title={
                    candidates.length
                      ? `${candidates.length} link${candidates.length === 1 ? '' : 's'} found by deep search, ${newCandidateCount} still to review`
                      : 'No deep-search results yet — run 🕵 Deep search below'
                  }
                >
                  <span className="text-sm font-medium tabular-nums">
                    {candidates.length || '—'}
                  </span>
                  <span className="text-[10px] text-gray-500">
                    Found{newCandidateCount > 0 ? ` (${newCandidateCount} new)` : ''}
                  </span>
                </div>
                {isAdmin && (
                  <div className="card flex flex-1 items-center justify-center gap-1.5 py-1.5">
                    <span className="text-sm font-medium tabular-nums text-green-600">
                      ${Number(contact.revenue_projection ?? 0).toLocaleString()}
                    </span>
                    <span className="text-[10px] text-gray-500">Revenue</span>
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                {links.map((link, i) => (
                  <div key={link.position}>
                    <div className="flex items-center gap-2">
                      <span className="w-6 text-right font-mono text-xs text-gray-400">
                        {link.position}
                      </span>
                      <input
                        className="input min-w-0 flex-1"
                        placeholder={`Link ${link.position} URL`}
                        value={link.url}
                        onChange={(e) =>
                          setLinks((ls) =>
                            ls.map((l, j) => (j === i ? { ...l, url: e.target.value } : l))
                          )
                        }
                      />
                    </div>
                    {/* Removal status sits UNDER the URL, not beside it. Beside it,
                        the two shared a flex row and .input's w-full (it's an
                        unlayered primitive, so it outranks the w-32 utility in
                        Tailwind v4) ballooned the select and crushed the URL field.
                        Status only matters once the contact is a client. */}
                    {isClient && (
                      <div className="mt-1 ml-8 flex items-center gap-2">
                        <select
                          className="rounded-lg border border-gray-200 bg-surface px-2 py-1 text-xs outline-none focus:border-brand-500"
                          value={link.status}
                          style={{ color: LINK_STATUS_COLORS[link.status] }}
                          onChange={(e) =>
                            setLinks((ls) =>
                              ls.map((l, j) =>
                                j === i ? { ...l, status: e.target.value as LinkSlot['status'] } : l
                              )
                            )
                          }
                        >
                          <option value="live">Live</option>
                          <option value="requested">Requested</option>
                          <option value="removed">Removed</option>
                        </select>
                        {link.difficulty ? (
                          <span
                            className="text-xs text-gray-400"
                            title="Removal difficulty (from URL rules)"
                          >
                            D{link.difficulty}
                          </span>
                        ) : null}
                      </div>
                    )}
                    {/* The full URL, wrapped (never truncated), as a click-out to
                        verify the match in a new tab. */}
                    {link.url.trim() && (
                      <a
                        href={/^https?:\/\//i.test(link.url.trim()) ? link.url.trim() : `https://${link.url.trim()}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-0.5 ml-8 block break-all text-[11px] leading-snug text-brand-600 hover:underline dark:text-gray-900"
                        title="Open in a new tab to verify"
                      >
                        {link.url.trim()} ↗
                      </a>
                    )}
                  </div>
                ))}
              </div>
              {customFor('link').length > 0 && (
                <div className="grid grid-cols-2 gap-3">{customInputs('link')}</div>
              )}
              <div className="flex gap-2">
                <button className="btn btn-primary" disabled={busy === 'links'} onClick={saveLinks}>
                  {busy === 'links' ? 'Saving…' : 'Save links'}
                </button>
                {customFor('link').length > 0 && saveButton([])}
                <button
                  className="btn"
                  disabled={busy === 'deep'}
                  title="Searches the mugshot sites' own search pages, then chains what they reveal (middle name, county) into deeper probes. Mostly free page fetches; a site that blocks us falls back to a Google site: query, up to 4 SERP requests per run."
                  onClick={() => runDeepSearch()}
                >
                  {busy === 'deep' ? 'Probing…' : '🕵 Deep search'}
                </button>
                {/* The same stamps that drive the grid icon, in words. */}
                <span
                  role="status"
                  aria-live="polite"
                  className="self-center text-[10px] text-gray-400"
                  title="Stamped when a run concludes — a partial run counts; it kept its findings"
                >
                  {deepSearchStatus ??
                    (contact.deep_search_queued_at &&
                    Date.now() - new Date(contact.deep_search_queued_at).getTime() < 30 * 60_000
                      ? 'Deep search queued…'
                      : contact.deep_search_queued_at
                        ? 'The last queued run never concluded — run it again'
                        : contact.deep_searched_at
                          ? `Last run ${new Date(contact.deep_searched_at).toLocaleString()}`
                          : 'Never run')}
                </span>
              </div>

              {/* Facts the search relies on.
                  ✓ confirms AND saves that single value: it then outranks
                  anything a search finds, seeds every run, and is never cleared
                  automatically. × retracts a confirmed value. "clear" empties
                  just that one field's found values, so a wrong county can go
                  without taking a correct middle name and date with it. */}
              {(() => {
                const learned = contact.search_facts ?? {};
                const confirmed = contact.confirmed_facts ?? {};
                const LABELS: [string, string][] = [
                  ['middle', 'Middle'],
                  ['county', 'County'],
                  ['state', 'State'],
                  ['booking_dates', 'Booked'],
                  ['record_ids', 'Record ID'],
                ];
                const rows = LABELS.map(([key, label]) => {
                  const conf: string[] = confirmed[key] ?? [];
                  const confLower = new Set(conf.map((v) => String(v).toLowerCase()));
                  // A value only counts as "learned" until it is confirmed.
                  const learnedOnly = (learned[key] ?? []).filter(
                    (v: string) => !confLower.has(String(v).toLowerCase())
                  );
                  return { key, label, conf, learnedOnly };
                }).filter((r) => r.conf.length || r.learnedOnly.length);
                if (!rows.length) return null;

                return (
                  <div className="space-y-1.5 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:text-gray-900">
                    <div className="text-[10px] font-medium tracking-widest text-gray-500 uppercase dark:text-gray-600">
                      Facts
                    </div>
                    {rows.map(({ key, label, conf, learnedOnly }) => (
                      <div key={key} className="flex flex-wrap items-center gap-1.5">
                        <span className="w-16 flex-none font-semibold">{label}:</span>
                        {conf.map((v) => (
                          <span
                            key={`c-${v}`}
                            className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[11px] text-green-800"
                            title="Confirmed and saved — outranks anything a search finds, seeds every run, and is never cleared automatically"
                          >
                            🔒 {v}
                            {isAdmin && (
                              <button
                                type="button"
                                disabled={busy === `fact-${key}-${v}`}
                                onClick={() =>
                                  mutateConfirmed(
                                    { action: 'unconfirm_fact', key, value: v },
                                    `fact-${key}-${v}`
                                  )
                                }
                                className="text-green-700 hover:text-red-600 disabled:opacity-50"
                                title="Remove this confirmed value"
                              >
                                ×
                              </button>
                            )}
                            {key === 'booking_dates' && isAdmin && (
                              <button
                                type="button"
                                disabled={busy === `deep-${v}`}
                                onClick={() => runDeepSearch(v)}
                                className="text-green-700 hover:text-brand-700 disabled:opacity-50"
                                title={`Branch a deep search focused on the ${v} arrest — every probe window and date-built URL uses this date alone`}
                              >
                                {busy === `deep-${v}` ? '…' : '⌕'}
                              </button>
                            )}
                          </span>
                        ))}
                        {learnedOnly.map((v: string) => (
                          <span
                            key={`l-${v}`}
                            className="inline-flex items-center gap-1 rounded-full bg-gray-200 px-2 py-0.5 text-[11px] text-gray-700"
                          >
                            {v}
                            {isAdmin && (
                              <button
                                type="button"
                                disabled={busy === `fact-${key}-${v}`}
                                onClick={() =>
                                  mutateConfirmed(
                                    { action: 'confirm_fact', key, value: v },
                                    `fact-${key}-${v}`
                                  )
                                }
                                className="text-gray-500 hover:text-green-700 disabled:opacity-50"
                                title={`Confirm and save "${v}" as this contact's ${label.toLowerCase()} — it then outranks anything a search finds, seeds every run, and is kept when you clear links`}
                              >
                                ✓
                              </button>
                            )}
                            {key === 'booking_dates' && isAdmin && (
                              <button
                                type="button"
                                disabled={busy === `deep-${v}`}
                                onClick={() => runDeepSearch(v)}
                                className="text-gray-500 hover:text-brand-700 disabled:opacity-50"
                                title={`Branch a deep search focused on the ${v} arrest — every probe window and date-built URL uses this date alone`}
                              >
                                {busy === `deep-${v}` ? '…' : '⌕'}
                              </button>
                            )}
                          </span>
                        ))}
                        {/* Clear this ONE field. Facts are not interchangeable —
                            a wrong county should go without taking a correct
                            middle name and booking date with it. */}
                        {isAdmin && learnedOnly.length > 0 && (
                          <button
                            type="button"
                            disabled={busy === `clear-fact-${key}`}
                            onClick={() => {
                              if (
                                !confirm(
                                  `Clear the found ${label.toLowerCase()} value${
                                    learnedOnly.length === 1 ? '' : 's'
                                  } (${learnedOnly.join(', ')})?\n\n` +
                                    (conf.length
                                      ? `Confirmed ${label.toLowerCase()} (${conf.join(', ')}) is kept — use × to remove that.\n\n`
                                      : '') +
                                    'Other facts are untouched. A later deep search may find it again.'
                                )
                              ) {
                                return;
                              }
                              mutateConfirmed({ action: 'clear_fact', key }, `clear-fact-${key}`);
                            }}
                            className="ml-1 text-[10px] text-gray-400 underline decoration-dotted hover:text-red-600 disabled:opacity-50"
                            title={`Clear the found ${label.toLowerCase()} values (confirmed ones stay)`}
                          >
                            {busy === `clear-fact-${key}` ? 'clearing…' : 'clear'}
                          </button>
                        )}
                        {/* Two dates = two arrests. The ⌕ on each date branches
                            a search that digs into that one booking. */}
                        {key === 'booking_dates' && conf.length + learnedOnly.length >= 2 && (
                          <span
                            className="text-[10px] font-medium text-amber-600"
                            title="Each date is a separate booking — branch a focused search per arrest with ⌕"
                          >
                            {conf.length + learnedOnly.length} arrests on record
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* Enter a county you already know. It shows up above as a 🔒
                  confirmed chip, steers the county-based probe sites, and is
                  most valuable BEFORE the first run — a common name plus a
                  known county is the difference between one match and five. */}
              {isAdmin && (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={countyValue}
                    onChange={(e) => setCountyValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') confirmCounty();
                    }}
                    placeholder="Add known counties (e.g. Fulton, DeKalb, Cobb)"
                    className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2.5 py-1 text-[11px] dark:text-gray-900"
                  />
                  <button
                    type="button"
                    className="btn px-2.5 py-1 text-xs"
                    disabled={busy === 'confirm-county' || !countyValue.trim()}
                    onClick={confirmCounty}
                    title="Save as a confirmed county — it seeds every deep search and outranks whatever a search finds"
                  >
                    {busy === 'confirm-county' ? 'Saving…' : 'Add counties'}
                  </button>
                </div>
              )}

              {/* Confirm a URL a human found — a page you know is this person's,
                  whether or not a search surfaced it. It becomes truth (its
                  county/date/middle name seed future runs) without taking one of
                  the 14 removal slots. */}
              {isAdmin && (
                <div className="flex items-center gap-2">
                  <input
                    type="url"
                    value={confirmUrlValue}
                    onChange={(e) => setConfirmUrlValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') confirmUrl();
                    }}
                    placeholder="Confirm a known URL (https://…)"
                    className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2.5 py-1 text-[11px] dark:text-gray-900"
                  />
                  <button
                    type="button"
                    className="btn px-2.5 py-1 text-xs"
                    disabled={busy === 'confirm-url' || !confirmUrlValue.trim()}
                    onClick={confirmUrl}
                    title="Record this URL as this person's and fold its facts into the confirmed set"
                  >
                    {busy === 'confirm-url' ? 'Confirming…' : 'Confirm URL'}
                  </button>
                </div>
              )}

              {/* Candidate review. Deep search never fills a slot on its own —
                  someone confirms each URL, and provenance makes the chaining
                  logic auditable while it earns trust. */}
              {candidates.length > 0 &&
                (() => {
                  // One row, rendered identically whether it sits inside an
                  // identity group or in the flat list below.
                  const renderCandidate = (c: any) => (
                      <div
                        key={c.id}
                        className={`rounded-lg border px-3 py-2 ${
                          c.status === 'new'
                            ? 'border-gray-200'
                            : c.status === 'confirmed'
                              ? 'border-green-200 bg-green-50'
                              : 'border-gray-100 bg-gray-50 opacity-60'
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <span
                            className={`mt-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                              Number(c.confidence) >= 0.8
                                ? 'bg-green-100 text-green-700'
                                : Number(c.confidence) >= 0.65
                                  ? 'bg-amber-100 text-amber-700'
                                  : 'bg-gray-100 text-gray-600'
                            }`}
                            title="Corroboration: surname plus how many known facts agree"
                          >
                            {Math.round(Number(c.confidence) * 100)}%
                          </span>
                          <div className="min-w-0 flex-1">
                            <a
                              href={c.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block break-all text-[11px] leading-snug font-medium text-brand-600 hover:underline dark:text-gray-900"
                            >
                              {c.url} ↗
                            </a>
                            <div className="mt-0.5 text-[10px] text-gray-500 dark:text-gray-600">
                              {c.source === 'probe' ? 'Probed' : c.source} {c.source_detail} · round{' '}
                              {c.round + 1}
                              {Object.keys(c.matched_facts ?? {}).length > 0 && (
                                <> · matched {Object.keys(c.matched_facts).join(', ')}</>
                              )}
                            </div>
                          </div>
                          {c.status === 'new' && c.matched_facts?.kind === 'site_search' ? (
                            <div className="flex flex-none items-center gap-1">
                              <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:text-gray-900">
                                search view
                              </span>
                              <button
                                className="btn px-2 py-0.5 text-xs text-gray-500"
                                disabled={busy === `cand-${c.id}`}
                                onClick={() => reviewCandidate(c.id, 'reject')}
                              >
                                Done
                              </button>
                            </div>
                          ) : c.status === 'new' ? (
                            <div className="flex flex-none gap-1">
                              <button
                                className="btn px-2 py-0.5 text-xs"
                                disabled={busy === `cand-${c.id}`}
                                onClick={() => reviewCandidate(c.id, 'accept')}
                                title="Add to a removal link slot"
                              >
                                Add
                              </button>
                              {/* Confirm as truth without spending a slot. */}
                              {isAdmin && (
                                <button
                                  className="btn px-2 py-0.5 text-xs"
                                  disabled={busy === `cand-${c.id}`}
                                  onClick={() => reviewCandidate(c.id, 'confirm')}
                                  title="Mark as this person's and fold its facts into the confirmed set, without using a slot"
                                >
                                  Confirm
                                </button>
                              )}
                              <button
                                className="btn px-2 py-0.5 text-xs text-gray-500"
                                disabled={busy === `cand-${c.id}`}
                                onClick={() => reviewCandidate(c.id, 'reject')}
                              >
                                Dismiss
                              </button>
                            </div>
                          ) : c.status === 'confirmed' ? (
                            <span
                              className="flex-none rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-800"
                              title="Confirmed as this person's — seeds runs, survives Clear"
                            >
                              🔒 confirmed
                            </span>
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
