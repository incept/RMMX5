-- ---------------------------------------------------------------------------
-- Contact merge.
--
-- One person, two rows: a call-in lead and a form submission arrive through
-- different doors and nothing joins them (the caller ID name and the form name
-- rarely match exactly). Merging by hand means copying fields and losing the
-- call history. This function does the whole merge in ONE transaction, because
-- a half-merged pair — history moved but the duplicate still standing, or the
-- duplicate gone with its calls orphaned — is worse than no merge at all.
--
-- The rules mirror enrichment's: THE SURVIVING ROW'S VALUES ALWAYS WIN, the
-- merged row only fills blanks. The one exception is the "Caller +1…"
-- placeholder name, which is a label rather than information.
-- ---------------------------------------------------------------------------

-- Union of two {key: [values]} fact blobs, first occurrence wins the order —
-- so the survivor's confirmed county stays facts.county[0] and keeps steering
-- deep-search probes exactly as before the merge.
create or replace function public.jsonb_union_fact_arrays(a jsonb, b jsonb)
returns jsonb
language sql
immutable
as $$
  select coalesce(
    (
      select jsonb_object_agg(keys.k, merged.vals)
      from (
        select jsonb_object_keys(coalesce(a, '{}'::jsonb)) as k
        union
        select jsonb_object_keys(coalesce(b, '{}'::jsonb))
      ) keys
      cross join lateral (
        select jsonb_agg(dedup.elem order by dedup.first_ord) as vals
        from (
          select e.elem, min(e.ord) as first_ord
          from jsonb_array_elements(
            coalesce(a -> keys.k, '[]'::jsonb) || coalesce(b -> keys.k, '[]'::jsonb)
          ) with ordinality as e(elem, ord)
          group by e.elem
        ) dedup
      ) merged
      where merged.vals is not null
    ),
    '{}'::jsonb
  )
$$;

create or replace function public.merge_contacts(
  p_winner uuid,
  p_loser uuid,
  p_actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.contacts%rowtype;
  l public.contacts%rowtype;
  v_link record;
  v_pos int;
  v_links_moved int := 0;
  v_links_skipped int := 0;
  v_candidates_moved int := 0;
begin
  if p_winner = p_loser then
    raise exception 'Cannot merge a contact into itself';
  end if;

  -- Deterministic lock order so two concurrent merges cannot deadlock.
  perform 1 from public.contacts where id = least(p_winner, p_loser) for update;
  perform 1 from public.contacts where id = greatest(p_winner, p_loser) for update;

  select * into w from public.contacts where id = p_winner;
  if not found then raise exception 'Surviving contact not found'; end if;
  select * into l from public.contacts where id = p_loser;
  if not found then raise exception 'Contact to merge not found'; end if;

  -- Scalar fields: survivor wins, blanks fill. The "Caller +1…" placeholder is
  -- the one value a real name from the other row may replace (\m..\M are word
  -- boundaries: "Caller 919" is a placeholder, "Callerman" is somebody's name).
  update public.contacts set
    name = case
      when (nullif(btrim(w.name), '') is null or w.name ~* '^\mcaller\M')
        and nullif(btrim(l.name), '') is not null and l.name !~* '^\mcaller\M'
      then l.name else w.name end,
    email = coalesce(nullif(btrim(w.email), ''), l.email),
    phone = coalesce(nullif(btrim(w.phone), ''), l.phone),
    city = coalesce(nullif(btrim(w.city), ''), l.city),
    state = coalesce(nullif(btrim(w.state), ''), l.state),
    browser = coalesce(nullif(btrim(w.browser), ''), l.browser),
    ppc_kw = coalesce(nullif(btrim(w.ppc_kw), ''), l.ppc_kw),
    source = coalesce(nullif(btrim(w.source), ''), l.source),
    ip = coalesce(nullif(btrim(w.ip), ''), l.ip),
    utm = coalesce(nullif(btrim(w.utm), ''), l.utm),
    device = coalesce(nullif(btrim(w.device), ''), l.device),
    source_url = coalesce(nullif(btrim(w.source_url), ''), l.source_url),
    wp_user = coalesce(nullif(btrim(w.wp_user), ''), l.wp_user),
    gclid = coalesce(nullif(btrim(w.gclid), ''), l.gclid),
    submitted_at = coalesce(w.submitted_at, l.submitted_at),
    status_id = coalesce(w.status_id, l.status_id),
    stage_id = coalesce(w.stage_id, l.stage_id),
    client_since = least(w.client_since, l.client_since),
    service_days = coalesce(w.service_days, l.service_days),
    revenue_projection = coalesce(w.revenue_projection, l.revenue_projection),
    owner_id = coalesce(w.owner_id, l.owner_id),
    custom = coalesce(l.custom, '{}'::jsonb) || coalesce(w.custom, '{}'::jsonb),
    confirmed_facts = public.jsonb_union_fact_arrays(w.confirmed_facts, l.confirmed_facts),
    search_facts = public.jsonb_union_fact_arrays(w.search_facts, l.search_facts),
    deep_searched_at = greatest(w.deep_searched_at, l.deep_searched_at)
  where id = p_winner;

  -- Links: the survivor's slots are untouched; the other row's links move into
  -- free slots, skipping URLs the survivor already tracks. If all 14 slots are
  -- taken the remainder is recorded in the merge activity entry, not lost
  -- silently.
  for v_link in
    select url, status, difficulty from public.contact_links
    where contact_id = p_loser and nullif(url, '') is not null
    order by position
  loop
    if exists (
      select 1 from public.contact_links
      where contact_id = p_winner and url = v_link.url
    ) then
      continue;
    end if;
    select min(s) into v_pos from generate_series(1, 14) s
    where not exists (
      select 1 from public.contact_links c
      where c.contact_id = p_winner and c.position = s and nullif(c.url, '') is not null
    );
    if v_pos is null then
      v_links_skipped := v_links_skipped + 1;
      continue;
    end if;
    insert into public.contact_links (contact_id, position, url, status, difficulty)
    values (p_winner, v_pos, v_link.url, v_link.status, v_link.difficulty)
    on conflict (contact_id, position) do update
      set url = excluded.url, status = excluded.status, difficulty = excluded.difficulty;
    v_links_moved := v_links_moved + 1;
  end loop;

  -- Search candidates carry human verdicts (a rejected row is a deletion
  -- tombstone that keeps auto-search from re-adding a link). Move everything
  -- the survivor doesn't already have a verdict on; clashes keep the
  -- survivor's row and the rest die with the duplicate.
  update public.search_candidates sc
  set contact_id = p_winner
  where sc.contact_id = p_loser
    and not exists (
      select 1 from public.search_candidates existing
      where existing.contact_id = p_winner
        and existing.canonical_url = sc.canonical_url
    );
  get diagnostics v_candidates_moved = row_count;

  -- Unique-per-contact memberships move unless the survivor already has them.
  update public.email_list_members m
  set contact_id = p_winner
  where m.contact_id = p_loser
    and not exists (
      select 1 from public.email_list_members existing
      where existing.contact_id = p_winner and existing.list_id = m.list_id
    );
  update public.sequence_enrollments e
  set contact_id = p_winner
  where e.contact_id = p_loser
    and not exists (
      select 1 from public.sequence_enrollments existing
      where existing.contact_id = p_winner and existing.sequence_id = e.sequence_id
    );

  -- Plain history: everything moves. This is the point of the merge — the
  -- calls, emails, and notes of both rows become one timeline.
  update public.activity_log set contact_id = p_winner where contact_id = p_loser;
  update public.calls set contact_id = p_winner where contact_id = p_loser;
  update public.email_messages set contact_id = p_winner where contact_id = p_loser;
  update public.email_events set contact_id = p_winner where contact_id = p_loser;
  update public.sms_messages set contact_id = p_winner where contact_id = p_loser;
  update public.voicemail_sends set contact_id = p_winner where contact_id = p_loser;
  update public.contact_files set contact_id = p_winner where contact_id = p_loser;
  update public.notifications_log set contact_id = p_winner where contact_id = p_loser;
  update public.webhook_leads set contact_id = p_winner where contact_id = p_loser;
  update public.debug_log set contact_id = p_winner where contact_id = p_loser;

  delete from public.contacts where id = p_loser;

  insert into public.activity_log (contact_id, actor_id, type, description, meta)
  values (
    p_winner,
    p_actor,
    'updated',
    'Merged duplicate contact "'
      || coalesce(nullif(btrim(l.name), ''), l.id::text)
      || '" into this record',
    jsonb_build_object(
      'merged_contact_id', l.id,
      'merged_name', l.name,
      'merged_phone', l.phone,
      'merged_email', l.email,
      'links_moved', v_links_moved,
      'links_skipped_no_free_slot', v_links_skipped,
      'candidates_moved', v_candidates_moved
    )
  );

  -- Link scores changed; let the scoring job rebuild the reputation number.
  insert into public.job_queue (kind, payload, dedupe_key)
  values (
    'score_contact',
    jsonb_build_object('contactId', p_winner),
    'score:merge:' || p_winner::text || ':' || l.id::text
  )
  on conflict (dedupe_key) do nothing;

  return jsonb_build_object(
    'winner_id', p_winner,
    'merged_name', l.name,
    'links_moved', v_links_moved,
    'links_skipped_no_free_slot', v_links_skipped,
    'candidates_moved', v_candidates_moved
  );
end;
$$;

revoke all on function public.jsonb_union_fact_arrays(jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.merge_contacts(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.merge_contacts(uuid, uuid, uuid) to service_role;
