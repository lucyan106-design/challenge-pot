-- =====================================================================
-- Challenge Pot — migration 006: invitations and join requests
-- * When creating a challenge you can invite specific friends from the group.
-- * Players can invite more friends; outsiders can ask to join (the creator accepts).
-- * Before the start anyone can also join directly. After the start, joining is only
--   possible in the first 10% of the challenge's time (start → end of deadline day),
--   or the first 24 hours when there is no deadline.
-- =====================================================================
begin;

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

-- when does the join window close? null = no window (challenge not running)
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

-- add someone to a challenge in the right role
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

-- players invite friends from the group
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

-- someone in the group asks to join a running challenge
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

-- invited person answers an invite; the creator answers a request
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

-- joining directly before the start also clears any pending invite for that person
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

-- create a challenge and invite people in one go
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

-- invites die with the challenge being cancelled
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

-- permissions: public actions callable by signed-in users, helpers not
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
