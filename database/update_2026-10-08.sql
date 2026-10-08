-- Challenge Pot — update: challenge a friend, dated proofs, invites & join requests (004 + 005 + 006)
-- Paste everything into Supabase → SQL Editor → New query → Run. Safe to run once.
begin;
alter table public.challenges add column if not exists target uuid references auth.users(id) on delete cascade;
alter table public.challenges drop constraint if exists challenges_kind_check;
alter table public.challenges add constraint challenges_kind_check check (kind in ('duel','personal','dare'));
create or replace function public._doer(c public.challenges)
returns uuid language sql immutable set search_path = ''
as $$ select case when c.kind = 'dare' then c.target else c.creator end $$;
create or replace function public._is_player(c public.challenges, uid uuid)
returns boolean language sql immutable set search_path = ''
as $$ select case when c.kind = 'duel' then uid = any(c.participants)
                  when c.kind = 'dare' then uid = c.target or uid = any(c.backers)
                  else uid = c.creator or uid = any(c.backers) end $$;
drop function if exists public.create_challenge(uuid, text, text, text, numeric, date, text);
create or replace function public.create_challenge(p_group uuid, p_title text, p_descr text, p_kind text, p_stake numeric,
                                                   p_deadline date, p_photo_path text default null, p_target uuid default null)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._require_group_member(p_group); new_id uuid;
begin
  if p_kind not in ('duel','personal','dare') then raise exception 'Tip necunoscut.' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_title,''))) not between 1 and 90 then
    raise exception 'Scrie provocarea (maxim 90 de caractere).' using errcode = '22023';
  end if;
  if p_stake is null or p_stake < 0.5 or p_stake > 1000 then
    raise exception 'Miza trebuie să fie între £0.50 și £1000.' using errcode = '22023';
  end if;
  if p_photo_path is not null and split_part(p_photo_path, '/', 1) <> uid::text then
    raise exception 'Poză invalidă.' using errcode = '22023';
  end if;
  if p_kind = 'dare' then
    if p_target is null or p_target = uid
       or not exists (select 1 from public.group_members where group_id = p_group and user_id = p_target) then
      raise exception 'Alege un prieten din grup.' using errcode = '22023';
    end if;
  end if;
  insert into public.challenges (group_id, title, descr, kind, stake, creator, participants, backers, deadline, photo_path, target)
  values (p_group, btrim(p_title), left(coalesce(btrim(p_descr),''), 600), p_kind, round(p_stake, 2), uid,
          case when p_kind = 'duel' then array[uid] else '{}'::uuid[] end,
          case when p_kind = 'dare' then array[uid] else '{}'::uuid[] end,
          p_deadline, p_photo_path, case when p_kind = 'dare' then p_target end)
  returning id into new_id;
  return new_id;
end $$;
create or replace function public.join_challenge(p_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._uid(); c public.challenges := public._challenge_for_update(p_id);
begin
  if c.status <> 'open' then raise exception 'Nu se mai poate intra, challenge-ul a pornit.' using errcode = '22023'; end if;
  if c.kind = 'duel' then
    if not uid = any(c.participants) then
      update public.challenges set participants = array_append(participants, uid) where id = p_id;
    end if;
  elsif c.kind = 'dare' then
    if uid = c.target then
      update public.challenges set participants = array[uid] where id = p_id;
    elsif not uid = any(c.backers) then
      update public.challenges set backers = array_append(backers, uid) where id = p_id;
    end if;
  else
    if uid = c.creator then raise exception 'Nu poți paria contra propriei provocări.' using errcode = '22023'; end if;
    if not uid = any(c.backers) then
      update public.challenges set backers = array_append(backers, uid) where id = p_id;
    end if;
  end if;
end $$;
create or replace function public.leave_challenge(p_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._uid(); c public.challenges := public._challenge_for_update(p_id);
begin
  if c.status <> 'open' then raise exception 'Nu mai poți ieși, challenge-ul a pornit.' using errcode = '22023'; end if;
  if uid = c.creator then raise exception 'Cine a lansat challenge-ul îl poate doar anula.' using errcode = '22023'; end if;
  update public.challenges
     set participants = array_remove(participants, uid), backers = array_remove(backers, uid)
   where id = p_id;
end $$;
create or replace function public.start_challenge(p_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._uid(); c public.challenges := public._challenge_for_update(p_id);
begin
  if c.creator <> uid then raise exception 'Doar cine a lansat challenge-ul îl poate porni.' using errcode = '42501'; end if;
  if c.status <> 'open' then raise exception 'Challenge-ul a pornit deja.' using errcode = '22023'; end if;
  if c.kind = 'duel' and coalesce(array_length(c.participants,1),0) < 2 then
    raise exception 'Ai nevoie de cel puțin încă un participant.' using errcode = '22023';
  end if;
  if c.kind = 'personal' and coalesce(array_length(c.backers,1),0) < 1 then
    raise exception 'Ai nevoie de cel puțin un prieten care pariază contra.' using errcode = '22023';
  end if;
  if c.kind = 'dare' and not c.target = any(c.participants) then
    raise exception 'Prietenul provocat trebuie să accepte întâi.' using errcode = '22023';
  end if;
  update public.challenges set status = 'active', started_at = now() where id = p_id;
end $$;
create or replace function public.cancel_challenge(p_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._uid(); c public.challenges := public._challenge_for_update(p_id);
begin
  if c.creator <> uid and not (c.kind = 'dare' and c.target = uid) then
    raise exception 'Doar cine a lansat challenge-ul îl poate anula.' using errcode = '42501';
  end if;
  if c.status <> 'open' then raise exception 'Se poate anula doar înainte de pornire.' using errcode = '22023'; end if;
  update public.challenges set status = 'cancelled' where id = p_id;
end $$;
create or replace function public.submit_proof(p_id uuid, p_body text, p_photo_path text)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._uid(); c public.challenges;
begin
  select * into c from public.challenges where id = p_id;
  if not found then raise exception 'Challenge-ul nu există.' using errcode = '22023'; end if;
  perform public._require_group_member(c.group_id);
  if c.status <> 'active' then raise exception 'Dovezile se trimit cât timp challenge-ul e în desfășurare.' using errcode = '22023'; end if;
  if (c.kind = 'duel' and not uid = any(c.participants)) or (c.kind <> 'duel' and uid <> public._doer(c)) then
    raise exception 'Doar cine face provocarea trimite dovezi.' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_body,''))) = 0 and p_photo_path is null then
    raise exception 'Scrie ceva sau adaugă o poză.' using errcode = '22023';
  end if;
  if p_photo_path is not null and split_part(p_photo_path, '/', 1) <> uid::text then
    raise exception 'Poză invalidă.' using errcode = '22023';
  end if;
  insert into public.proofs (challenge_id, user_id, body, photo_path, updated_at)
  values (p_id, uid, left(btrim(coalesce(p_body,'')), 600), p_photo_path, now())
  on conflict (challenge_id, user_id) do update
    set body = excluded.body, photo_path = coalesce(excluded.photo_path, public.proofs.photo_path), updated_at = now();
end $$;
create or replace function public._eligible_voters(c public.challenges)
returns int language sql stable security definer set search_path = ''
as $$ select (count(*) - case when c.kind in ('personal','dare') then 1 else 0 end)::int
      from public.group_members where group_id = c.group_id $$;
revoke execute on function public._eligible_voters(public.challenges) from authenticated;
create or replace function public.cast_vote(p_id uuid, p_pick text)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._uid(); c public.challenges;
begin
  select * into c from public.challenges where id = p_id;
  if not found then raise exception 'Challenge-ul nu există.' using errcode = '22023'; end if;
  perform public._require_group_member(c.group_id);
  if c.status <> 'voting' then raise exception 'Votul nu e deschis.' using errcode = '22023'; end if;
  if c.kind in ('personal','dare') then
    if uid = public._doer(c) then raise exception 'Nu poți vota la propria provocare.' using errcode = '42501'; end if;
    if p_pick not in ('success','fail') then raise exception 'Vot invalid.' using errcode = '22023'; end if;
  else
    if p_pick !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Vot invalid.' using errcode = '22023';
    end if;
    if not p_pick::uuid = any(c.participants) then raise exception 'Vot invalid.' using errcode = '22023'; end if;
    if p_pick::uuid = uid then raise exception 'Nu poți vota pentru tine.' using errcode = '42501'; end if;
  end if;
  insert into public.votes (challenge_id, voter_id, pick, updated_at) values (p_id, uid, p_pick, now())
  on conflict (challenge_id, voter_id) do update set pick = excluded.pick, updated_at = now();
end $$;
create or replace function public.settle_challenge(p_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._uid(); c public.challenges := public._challenge_for_update(p_id);
        cast_count int; need int; res jsonb; top int; ok int; ko int;
begin
  if c.status <> 'voting' then raise exception 'Votul nu e deschis.' using errcode = '22023'; end if;
  if not public._is_player(c, uid) then raise exception 'Doar jucătorii pot închide votul.' using errcode = '42501'; end if;
  select count(*) into cast_count from public.votes where challenge_id = p_id;
  need := greatest(1, ceil(public._eligible_voters(c) / 2.0)::int);
  if cast_count < need then
    raise exception 'Mai trebuie % vot(uri) ca să se poată închide.', need - cast_count using errcode = '22023';
  end if;
  if c.kind in ('personal','dare') then
    select count(*) filter (where pick = 'success'), count(*) filter (where pick = 'fail') into ok, ko
      from public.votes where challenge_id = p_id;
    res := jsonb_build_object('success', ok > ko);
  else
    select max(n) into top from (select count(*) n from public.votes where challenge_id = p_id group by pick) t;
    select jsonb_build_object('winners', coalesce(jsonb_agg(pick order by pick), '[]'::jsonb)) into res
      from (select pick from public.votes where challenge_id = p_id group by pick having count(*) = top) w;
  end if;
  update public.challenges set status = 'settled', result = res, settled_at = now() where id = p_id;
  return res;
end $$;
create or replace function public.respond_counter(p_offer uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._uid(); o public.challenge_offers; c public.challenges;
begin
  select * into o from public.challenge_offers where id = p_offer for update;
  if not found then raise exception 'Contra-oferta nu există.' using errcode = '22023'; end if;
  c := public._challenge_for_update(o.challenge_id);
  if c.creator <> uid then raise exception 'Doar cine a lansat challenge-ul răspunde la contra-oferte.' using errcode = '42501'; end if;
  if o.status <> 'pending' then raise exception 'Contra-oferta nu mai e valabilă.' using errcode = '22023'; end if;
  if c.status <> 'open' then raise exception 'Challenge-ul a pornit deja.' using errcode = '22023'; end if;
  if not p_accept then
    update public.challenge_offers set status = 'rejected', decided_at = now() where id = p_offer;
    return;
  end if;
  update public.challenges set
    descr        = coalesce(o.descr, descr),
    stake        = coalesce(o.stake, stake),
    participants = case when kind = 'duel' then array[creator, o.proposer]
                        when kind = 'dare' then case when o.proposer = target then array[target] else '{}'::uuid[] end
                        else participants end,
    backers      = case when kind = 'personal' then array[o.proposer]
                        when kind = 'dare' then case when o.proposer = target then array[creator] else array[creator, o.proposer] end
                        else backers end
  where id = c.id;
  update public.challenge_offers set status = 'accepted', decided_at = now() where id = p_offer;
  update public.challenge_offers set status = 'superseded', decided_at = now()
   where challenge_id = c.id and status = 'pending' and id <> p_offer;
end $$;
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f'
             and p.proname in ('create_challenge','join_challenge','leave_challenge','start_challenge','cancel_challenge',
                               'submit_proof','cast_vote','settle_challenge','respond_counter','_is_player','_doer') loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;

alter table public.proofs add column if not exists id uuid not null default gen_random_uuid();
alter table public.proofs add column if not exists created_at timestamptz;
update public.proofs set created_at = updated_at where created_at is null;
alter table public.proofs alter column created_at set not null;
alter table public.proofs alter column created_at set default now();
alter table public.proofs drop constraint if exists proofs_pkey;
alter table public.proofs add primary key (id);
create index if not exists proofs_challenge_idx on public.proofs (challenge_id, created_at desc);
create or replace function public.submit_proof(p_id uuid, p_body text, p_photo_path text)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._uid(); c public.challenges;
begin
  select * into c from public.challenges where id = p_id;
  if not found then raise exception 'Challenge-ul nu există.' using errcode = '22023'; end if;
  perform public._require_group_member(c.group_id);
  if c.status <> 'active' then raise exception 'Dovezile se trimit cât timp challenge-ul e în desfășurare.' using errcode = '22023'; end if;
  if (c.kind = 'duel' and not uid = any(c.participants)) or (c.kind <> 'duel' and uid <> public._doer(c)) then
    raise exception 'Doar cine face provocarea trimite dovezi.' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_body,''))) = 0 and p_photo_path is null then
    raise exception 'Scrie ceva sau adaugă o poză.' using errcode = '22023';
  end if;
  if p_photo_path is not null and split_part(p_photo_path, '/', 1) <> uid::text then
    raise exception 'Poză invalidă.' using errcode = '22023';
  end if;
  if (select count(*) from public.proofs where user_id = uid and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Prea multe dovezi într-o oră. Așteaptă puțin.' using errcode = '22023';
  end if;
  insert into public.proofs (id, challenge_id, user_id, body, photo_path, created_at, updated_at)
  values (gen_random_uuid(), p_id, uid, left(btrim(coalesce(p_body,'')), 600), p_photo_path, now(), now());
end $$;
revoke all on function public.submit_proof(uuid, text, text) from public, anon;
grant execute on function public.submit_proof(uuid, text, text) to authenticated;

create table if not exists public.challenge_invites (
  id           uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,   -- who would join
  kind         text not null check (kind in ('invite','request')),
  created_by   uuid not null references auth.users(id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending','accepted','declined','cancelled','expired')),
  created_at   timestamptz not null default now(),
  decided_at   timestamptz
);
create index if not exists challenge_invites_idx on public.challenge_invites (challenge_id, created_at);
create index if not exists challenge_invites_user_idx on public.challenge_invites (user_id, status);
create unique index if not exists challenge_invites_one_pending on public.challenge_invites (challenge_id, user_id) where status = 'pending';
alter table public.challenge_invites enable row level security;
drop policy if exists "group reads invites" on public.challenge_invites;
create policy "group reads invites" on public.challenge_invites for select to authenticated
  using (exists (select 1 from public.challenges c where c.id = challenge_id and public.is_group_member(c.group_id)));
grant select on public.challenge_invites to authenticated;
create or replace function public.join_window_end(c public.challenges)
returns timestamptz language sql immutable set search_path = ''
as $$ select case
    when c.status <> 'active' or c.started_at is null then null
    when c.deadline is null then c.started_at + interval '24 hours'
    else c.started_at + greatest(interval '0', ((c.deadline + 1)::timestamptz - c.started_at)) * 0.1
  end $$;
create or replace function public._can_join_now(c public.challenges)
returns boolean language sql stable set search_path = ''
as $$ select c.status = 'open' or (c.status = 'active' and now() <= public.join_window_end(c)) $$;
create or replace function public._add_to_challenge(p_id uuid, p_user uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare c public.challenges;
begin
  select * into c from public.challenges where id = p_id for update;
  if c.kind = 'duel' then
    if not p_user = any(c.participants) then
      update public.challenges set participants = array_append(participants, p_user) where id = p_id;
    end if;
  else
    if p_user = public._doer(c) then return; end if;
    if not p_user = any(c.backers) then
      update public.challenges set backers = array_append(backers, p_user) where id = p_id;
    end if;
  end if;
end $$;
create or replace function public._invite_many(p_id uuid, p_users uuid[], p_by uuid)
returns int language plpgsql security definer set search_path = ''
as $$
declare c public.challenges; u uuid; n int := 0;
begin
  select * into c from public.challenges where id = p_id;
  foreach u in array coalesce(p_users, '{}'::uuid[]) loop
    continue when u = p_by or public._is_player(c, u) or (c.kind = 'dare' and u = c.target);
    continue when not exists (select 1 from public.group_members where group_id = c.group_id and user_id = u);
    continue when exists (select 1 from public.challenge_invites where challenge_id = p_id and user_id = u and status = 'pending');
    insert into public.challenge_invites (challenge_id, user_id, kind, created_by) values (p_id, u, 'invite', p_by);
    n := n + 1;
  end loop;
  return n;
end $$;
create or replace function public.invite_to_challenge(p_id uuid, p_users uuid[])
returns int language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._uid(); c public.challenges := public._challenge_for_update(p_id);
begin
  if not (public._is_player(c, uid) or c.creator = uid) then
    raise exception 'Doar cei intrați în challenge pot invita.' using errcode = '42501';
  end if;
  if not public._can_join_now(c) then
    raise exception 'Nu se mai poate intra în acest challenge.' using errcode = '22023';
  end if;
  if coalesce(array_length(p_users, 1), 0) = 0 or array_length(p_users, 1) > 50 then
    raise exception 'Alege pe cine inviți.' using errcode = '22023';
  end if;
  return public._invite_many(p_id, p_users, uid);
end $$;
create or replace function public.request_join(p_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._uid(); c public.challenges := public._challenge_for_update(p_id);
begin
  if public._is_player(c, uid) then raise exception 'Ești deja în acest challenge.' using errcode = '22023'; end if;
  if not public._can_join_now(c) then raise exception 'Nu se mai poate intra în acest challenge.' using errcode = '22023'; end if;
  if exists (select 1 from public.challenge_invites where challenge_id = p_id and user_id = uid and status = 'pending') then
    raise exception 'Ai deja o cerere sau o invitație în așteptare.' using errcode = '22023';
  end if;
  insert into public.challenge_invites (challenge_id, user_id, kind, created_by) values (p_id, uid, 'request', uid);
end $$;
create or replace function public.respond_join(p_req uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._uid(); r public.challenge_invites; c public.challenges;
begin
  select * into r from public.challenge_invites where id = p_req for update;
  if not found or r.status <> 'pending' then raise exception 'Invitația nu mai e valabilă.' using errcode = '22023'; end if;
  c := public._challenge_for_update(r.challenge_id);
  if r.kind = 'invite' and uid <> r.user_id then raise exception 'Doar cel invitat poate răspunde.' using errcode = '42501'; end if;
  if r.kind = 'request' and uid <> c.creator then raise exception 'Doar cine a lansat challenge-ul acceptă cererile.' using errcode = '42501'; end if;
  if not p_accept then
    update public.challenge_invites set status = 'declined', decided_at = now() where id = p_req;
    return;
  end if;
  if not public._can_join_now(c) then
    update public.challenge_invites set status = 'expired', decided_at = now() where id = p_req;
    raise exception 'Nu se mai poate intra în acest challenge.' using errcode = '22023';
  end if;
  perform public._add_to_challenge(c.id, r.user_id);
  update public.challenge_invites set status = 'accepted', decided_at = now() where id = p_req;
end $$;
create or replace function public.cancel_join(p_req uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._uid();
begin
  update public.challenge_invites set status = 'cancelled', decided_at = now()
   where id = p_req and created_by = uid and status = 'pending';
  if not found then raise exception 'Poți retrage doar invitațiile sau cererile tale.' using errcode = '22023'; end if;
end $$;
create or replace function public.join_challenge(p_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._uid(); c public.challenges := public._challenge_for_update(p_id);
begin
  if c.status <> 'open' then raise exception 'Nu se mai poate intra, challenge-ul a pornit.' using errcode = '22023'; end if;
  if c.kind = 'duel' then
    if not uid = any(c.participants) then
      update public.challenges set participants = array_append(participants, uid) where id = p_id;
    end if;
  elsif c.kind = 'dare' then
    if uid = c.target then
      update public.challenges set participants = array[uid] where id = p_id;
    elsif not uid = any(c.backers) then
      update public.challenges set backers = array_append(backers, uid) where id = p_id;
    end if;
  else
    if uid = c.creator then raise exception 'Nu poți paria contra propriei provocări.' using errcode = '22023'; end if;
    if not uid = any(c.backers) then
      update public.challenges set backers = array_append(backers, uid) where id = p_id;
    end if;
  end if;
  update public.challenge_invites set status = 'accepted', decided_at = now()
   where challenge_id = p_id and user_id = uid and status = 'pending';
end $$;
drop function if exists public.create_challenge(uuid, text, text, text, numeric, date, text, uuid);
create or replace function public.create_challenge(p_group uuid, p_title text, p_descr text, p_kind text, p_stake numeric,
                                                   p_deadline date, p_photo_path text default null, p_target uuid default null,
                                                   p_invite uuid[] default null)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._require_group_member(p_group); new_id uuid;
begin
  if p_kind not in ('duel','personal','dare') then raise exception 'Tip necunoscut.' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_title,''))) not between 1 and 90 then
    raise exception 'Scrie provocarea (maxim 90 de caractere).' using errcode = '22023';
  end if;
  if p_stake is null or p_stake < 0.5 or p_stake > 1000 then
    raise exception 'Miza trebuie să fie între £0.50 și £1000.' using errcode = '22023';
  end if;
  if p_photo_path is not null and split_part(p_photo_path, '/', 1) <> uid::text then
    raise exception 'Poză invalidă.' using errcode = '22023';
  end if;
  if p_deadline is not null and p_deadline < current_date then
    raise exception 'Termenul nu poate fi în trecut.' using errcode = '22023';
  end if;
  if p_kind = 'dare' then
    if p_target is null or p_target = uid
       or not exists (select 1 from public.group_members where group_id = p_group and user_id = p_target) then
      raise exception 'Alege un prieten din grup.' using errcode = '22023';
    end if;
  end if;
  if coalesce(array_length(p_invite, 1), 0) > 50 then raise exception 'Prea multe invitații.' using errcode = '22023'; end if;
  insert into public.challenges (group_id, title, descr, kind, stake, creator, participants, backers, deadline, photo_path, target)
  values (p_group, btrim(p_title), left(coalesce(btrim(p_descr),''), 600), p_kind, round(p_stake, 2), uid,
          case when p_kind = 'duel' then array[uid] else '{}'::uuid[] end,
          case when p_kind = 'dare' then array[uid] else '{}'::uuid[] end,
          p_deadline, p_photo_path, case when p_kind = 'dare' then p_target end)
  returning id into new_id;
  perform public._invite_many(new_id, p_invite, uid);
  return new_id;
end $$;
create or replace function public.cancel_challenge(p_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._uid(); c public.challenges := public._challenge_for_update(p_id);
begin
  if c.creator <> uid and not (c.kind = 'dare' and c.target = uid) then
    raise exception 'Doar cine a lansat challenge-ul îl poate anula.' using errcode = '42501';
  end if;
  if c.status <> 'open' then raise exception 'Se poate anula doar înainte de pornire.' using errcode = '22023'; end if;
  update public.challenges set status = 'cancelled' where id = p_id;
  update public.challenge_invites set status = 'cancelled', decided_at = now() where challenge_id = p_id and status = 'pending';
end $$;
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f'
             and p.proname in ('join_window_end','_can_join_now','_add_to_challenge','_invite_many','invite_to_challenge',
                               'request_join','respond_join','cancel_join','join_challenge','create_challenge','cancel_challenge') loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if f.proname in ('_add_to_challenge','_invite_many') then
      execute format('revoke all on function %s from authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'challenge_invites') then
    alter publication supabase_realtime add table public.challenge_invites;
  end if;
end $$;

commit;

select 'OK' as rezultat, (select count(*) from pg_proc where proname in ('request_join','respond_join','_doer','join_window_end')) as functii_noi, (select count(*) from public.challenges) as challenges, (select count(*) from public.proofs) as dovezi;
