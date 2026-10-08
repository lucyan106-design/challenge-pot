-- =====================================================================
-- Challenge Pot — migration 002: multiple groups, each with its own invite code
-- Also adds: a photo on each challenge, a chat inside each challenge for its players,
-- counter-offers (other rules and/or another stake) that the creator can accept or refuse,
-- and a monthly ledger: payments are marked per month, each month starts from zero.
-- Run ONCE, after supabase.sql (001). Paste the whole file into:
-- Supabase Dashboard → SQL Editor → New query → Run
-- Existing members, challenges and payments move into one group that keeps the current invite code.
-- =====================================================================

begin;

-- ---------- new tables ----------
create table public.groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 40),
  invite_code text not null unique check (char_length(invite_code) between 4 and 32),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table public.group_members (
  group_id  uuid not null references public.groups(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  nick      text not null check (char_length(btrim(nick)) between 1 and 24),
  is_admin  boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index group_members_user_idx on public.group_members (user_id);

-- ---------- move existing data into the first group ----------
do $$
declare g uuid; owner uuid; code text;
begin
  select invite_code into code from public.app_settings where id = 1;
  select user_id into owner from public.members order by is_admin desc, joined_at asc limit 1;
  if owner is not null then
    insert into public.groups (name, invite_code, created_by)
    values ('Lucian Challenges Friends', upper(coalesce(code, 'POT-' || substr(md5(random()::text), 1, 6))), owner)
    returning id into g;
    insert into public.group_members (group_id, user_id, nick, is_admin, joined_at)
    select g, user_id, nick, is_admin, joined_at from public.members;
  end if;
  alter table public.challenges add column group_id uuid references public.groups(id) on delete cascade;
  alter table public.payments   add column group_id uuid references public.groups(id) on delete cascade;
  if g is not null then
    update public.challenges set group_id = g;
    update public.payments   set group_id = g;
  end if;
end $$;

-- payments belong to a month (money is settled at the end of each month)
alter table public.payments add column period date;
update public.payments set period = date_trunc('month', created_at)::date;
alter table public.payments alter column period set not null;

alter table public.challenges alter column group_id set not null;
alter table public.payments   alter column group_id set not null;
create index challenges_group_idx on public.challenges (group_id, created_at desc);
create index payments_group_idx   on public.payments (group_id, created_at desc);

-- people are now linked to their account, not to the old single member list
alter table public.challenges drop constraint if exists challenges_creator_fkey;
alter table public.proofs     drop constraint if exists proofs_user_id_fkey;
alter table public.votes      drop constraint if exists votes_voter_id_fkey;
alter table public.payments   drop constraint if exists payments_from_id_fkey;
alter table public.payments   drop constraint if exists payments_to_id_fkey;
alter table public.payments   drop constraint if exists payments_created_by_fkey;
alter table public.challenges add constraint challenges_creator_fkey  foreign key (creator)    references auth.users(id) on delete cascade;
alter table public.proofs     add constraint proofs_user_id_fkey      foreign key (user_id)    references auth.users(id) on delete cascade;
alter table public.votes      add constraint votes_voter_id_fkey      foreign key (voter_id)   references auth.users(id) on delete cascade;
alter table public.payments   add constraint payments_from_id_fkey    foreign key (from_id)    references auth.users(id) on delete cascade;
alter table public.payments   add constraint payments_to_id_fkey      foreign key (to_id)      references auth.users(id) on delete cascade;
alter table public.payments   add constraint payments_created_by_fkey foreign key (created_by) references auth.users(id) on delete cascade;

-- ---------- challenge photo + per-challenge chat ----------
alter table public.challenges add column photo_path text;

create table public.challenge_messages (
  id           uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  body         text not null check (char_length(btrim(body)) between 1 and 500),
  created_at   timestamptz not null default now()
);
create index challenge_messages_idx on public.challenge_messages (challenge_id, created_at);

-- ---------- counter-offers: someone challenged proposes other rules and/or another stake ----------
create table public.challenge_offers (
  id           uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  proposer     uuid not null references auth.users(id) on delete cascade,
  descr        text check (descr is null or char_length(descr) <= 600),
  stake        numeric(8,2) check (stake is null or (stake >= 0.5 and stake <= 1000)),
  status       text not null default 'pending' check (status in ('pending','accepted','rejected','withdrawn','superseded')),
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  check (descr is not null or stake is not null)
);
create index challenge_offers_idx on public.challenge_offers (challenge_id, created_at);
create unique index challenge_offers_one_pending on public.challenge_offers (challenge_id, proposer) where status = 'pending';

-- ---------- remove the single-group pieces ----------
drop policy if exists "members read members"    on public.members;
drop policy if exists "members read challenges" on public.challenges;
drop policy if exists "members read proofs"     on public.proofs;
drop policy if exists "members read votes"      on public.votes;
drop policy if exists "members read payments"   on public.payments;
drop policy if exists "members read proof photos"       on storage.objects;
drop policy if exists "members upload own proof photos" on storage.objects;

drop function if exists public.join_group(text, text);
drop function if exists public.set_nick(text);
drop function if exists public.get_invite_code();
drop function if exists public.set_invite_code(text);
drop function if exists public.create_challenge(text, text, text, numeric, date);
drop function if exists public.record_payment(uuid, uuid, numeric);
drop function if exists public._require_member();
drop function if exists public.is_member();
drop table public.members;
drop table public.app_settings;

-- ---------- access rules: you see only the groups you belong to ----------
alter table public.groups        enable row level security;
alter table public.group_members enable row level security;

create or replace function public.is_group_member(p_group uuid)
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.group_members where group_id = p_group and user_id = auth.uid()) $$;

create or replace function public.shares_group_with(p_other uuid)
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (
  select 1 from public.group_members a join public.group_members b on a.group_id = b.group_id
  where a.user_id = auth.uid() and b.user_id = p_other) $$;

create policy "read my groups"        on public.groups        for select to authenticated using (public.is_group_member(id));
create policy "read my group members" on public.group_members for select to authenticated using (public.is_group_member(group_id));
create policy "read group challenges" on public.challenges    for select to authenticated using (public.is_group_member(group_id));
create policy "read group payments"   on public.payments      for select to authenticated using (public.is_group_member(group_id));
create policy "read group proofs"     on public.proofs        for select to authenticated
  using (exists (select 1 from public.challenges c where c.id = challenge_id and public.is_group_member(c.group_id)));
create policy "read group votes"      on public.votes         for select to authenticated
  using (exists (select 1 from public.challenges c where c.id = challenge_id and public.is_group_member(c.group_id)));

alter table public.challenge_messages enable row level security;
create policy "players read challenge chat" on public.challenge_messages for select to authenticated
  using (exists (select 1 from public.challenges c where c.id = challenge_id and public._is_player(c, auth.uid())));

alter table public.challenge_offers enable row level security;
create policy "group reads counter-offers" on public.challenge_offers for select to authenticated
  using (exists (select 1 from public.challenges c where c.id = challenge_id and public.is_group_member(c.group_id)));

create policy "read proof photos of my groups" on storage.objects for select to authenticated
  using (bucket_id = 'proofs' and (
    (storage.foldername(name))[1] = auth.uid()::text
    or public.shares_group_with(((storage.foldername(name))[1])::uuid)));
create policy "upload own proof photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'proofs'
    and exists (select 1 from public.group_members where user_id = auth.uid())
    and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- helpers ----------
create or replace function public._uid()
returns uuid language plpgsql stable security definer set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Nu ești logat.' using errcode = '28000'; end if;
  return auth.uid();
end $$;

create or replace function public._require_group_member(p_group uuid)
returns uuid language plpgsql stable security definer set search_path = ''
as $$
declare uid uuid := public._uid();
begin
  if not exists (select 1 from public.group_members where group_id = p_group and user_id = uid) then
    raise exception 'Nu ești în acest grup.' using errcode = '42501';
  end if;
  return uid;
end $$;

create or replace function public._new_invite_code()
returns text language plpgsql volatile security definer set search_path = ''
as $$
declare alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; code text; i int;
begin
  loop
    code := 'POT-';
    for i in 1..6 loop
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.groups where invite_code = code);
  end loop;
  return code;
end $$;

create or replace function public._check_nick(p_nick text)
returns text language plpgsql immutable
as $$
begin
  if char_length(btrim(coalesce(p_nick,''))) not between 1 and 24 then
    raise exception 'Numele trebuie să aibă între 1 și 24 de caractere.' using errcode = '22023';
  end if;
  return btrim(p_nick);
end $$;

-- ---------- groups ----------
create or replace function public.create_group(p_name text, p_nick text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._uid(); g uuid; v_nick text := public._check_nick(p_nick);
begin
  if char_length(btrim(coalesce(p_name,''))) not between 1 and 40 then
    raise exception 'Numele grupului trebuie să aibă între 1 și 40 de caractere.' using errcode = '22023';
  end if;
  if (select count(*) from public.groups where created_by = uid and created_at > now() - interval '1 day') >= 10 then
    raise exception 'Ai creat prea multe grupuri azi. Încearcă mâine.' using errcode = '22023';
  end if;
  insert into public.groups (name, invite_code, created_by) values (btrim(p_name), public._new_invite_code(), uid)
  returning id into g;
  insert into public.group_members (group_id, user_id, nick, is_admin) values (g, uid, v_nick, true);
  return g;
end $$;

create or replace function public.join_group(p_code text, p_nick text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._uid(); g uuid; v_nick text := public._check_nick(p_nick);
begin
  select id into g from public.groups where invite_code = upper(btrim(coalesce(p_code,'')));
  if g is null then raise exception 'Cod de invitație greșit.' using errcode = '22023'; end if;
  insert into public.group_members (group_id, user_id, nick, is_admin) values (g, uid, v_nick, false)
  on conflict (group_id, user_id) do update set nick = excluded.nick;
  return g;
end $$;

create or replace function public.set_nick(p_group uuid, p_nick text)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._require_group_member(p_group); v_nick text := public._check_nick(p_nick);
begin
  update public.group_members set nick = v_nick where group_id = p_group and user_id = uid;
end $$;

create or replace function public.get_invite_code(p_group uuid)
returns text language plpgsql stable security definer set search_path = ''
as $$
begin
  perform public._require_group_member(p_group);
  return (select invite_code from public.groups where id = p_group);
end $$;

create or replace function public.new_invite_code(p_group uuid)
returns text language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._require_group_member(p_group); code text;
begin
  if not exists (select 1 from public.group_members where group_id = p_group and user_id = uid and is_admin) then
    raise exception 'Doar administratorul grupului schimbă codul.' using errcode = '42501';
  end if;
  code := public._new_invite_code();
  update public.groups set invite_code = code where id = p_group;
  return code;
end $$;

create or replace function public.rename_group(p_group uuid, p_name text)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._require_group_member(p_group);
begin
  if not exists (select 1 from public.group_members where group_id = p_group and user_id = uid and is_admin) then
    raise exception 'Doar administratorul grupului schimbă numele.' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_name,''))) not between 1 and 40 then
    raise exception 'Numele grupului trebuie să aibă între 1 și 40 de caractere.' using errcode = '22023';
  end if;
  update public.groups set name = btrim(p_name) where id = p_group;
end $$;

-- ---------- challenges (each one belongs to a group) ----------
create or replace function public._challenge_for_update(p_id uuid)
returns public.challenges language plpgsql security definer set search_path = ''
as $$
declare c public.challenges;
begin
  select * into c from public.challenges where id = p_id for update;
  if not found then raise exception 'Challenge-ul nu există.' using errcode = '22023'; end if;
  perform public._require_group_member(c.group_id);
  return c;
end $$;

create or replace function public.create_challenge(p_group uuid, p_title text, p_descr text, p_kind text, p_stake numeric, p_deadline date, p_photo_path text default null)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._require_group_member(p_group); new_id uuid;
begin
  if p_kind not in ('duel','personal') then raise exception 'Tip necunoscut.' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_title,''))) not between 1 and 90 then
    raise exception 'Scrie provocarea (maxim 90 de caractere).' using errcode = '22023';
  end if;
  if p_stake is null or p_stake < 0.5 or p_stake > 1000 then
    raise exception 'Miza trebuie să fie între £0.50 și £1000.' using errcode = '22023';
  end if;
  if p_photo_path is not null and split_part(p_photo_path, '/', 1) <> uid::text then
    raise exception 'Poză invalidă.' using errcode = '22023';
  end if;
  insert into public.challenges (group_id, title, descr, kind, stake, creator, participants, deadline, photo_path)
  values (p_group, btrim(p_title), left(coalesce(btrim(p_descr),''), 600), p_kind, round(p_stake, 2), uid,
          case when p_kind = 'duel' then array[uid] else '{}'::uuid[] end, p_deadline, p_photo_path)
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
  update public.challenges set status = 'active', started_at = now() where id = p_id;
end $$;

create or replace function public.cancel_challenge(p_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._uid(); c public.challenges := public._challenge_for_update(p_id);
begin
  if c.creator <> uid then raise exception 'Doar cine a lansat challenge-ul îl poate anula.' using errcode = '42501'; end if;
  if c.status <> 'open' then raise exception 'Se poate anula doar înainte de pornire.' using errcode = '22023'; end if;
  update public.challenges set status = 'cancelled' where id = p_id;
end $$;

create or replace function public.open_voting(p_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._uid(); c public.challenges := public._challenge_for_update(p_id);
begin
  if c.status <> 'active' then raise exception 'Votul se deschide doar pentru un challenge în desfășurare.' using errcode = '22023'; end if;
  if not public._is_player(c, uid) then raise exception 'Doar jucătorii pot deschide votul.' using errcode = '42501'; end if;
  update public.challenges set status = 'voting' where id = p_id;
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
  if (c.kind = 'duel' and not uid = any(c.participants)) or (c.kind = 'personal' and uid <> c.creator) then
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
as $$ select (count(*) - case when c.kind = 'personal' then 1 else 0 end)::int
      from public.group_members where group_id = c.group_id $$;

create or replace function public.votes_needed(p_id uuid)
returns int language plpgsql stable security definer set search_path = ''
as $$
declare c public.challenges;
begin
  select * into c from public.challenges where id = p_id;
  if not found then return null; end if;
  perform public._require_group_member(c.group_id);
  return greatest(1, ceil(public._eligible_voters(c) / 2.0)::int);
end $$;

create or replace function public.cast_vote(p_id uuid, p_pick text)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._uid(); c public.challenges;
begin
  select * into c from public.challenges where id = p_id;
  if not found then raise exception 'Challenge-ul nu există.' using errcode = '22023'; end if;
  perform public._require_group_member(c.group_id);
  if c.status <> 'voting' then raise exception 'Votul nu e deschis.' using errcode = '22023'; end if;
  if c.kind = 'personal' then
    if uid = c.creator then raise exception 'Nu poți vota la propria provocare.' using errcode = '42501'; end if;
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
  if c.kind = 'personal' then
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

-- ---------- chat inside a challenge (players only) ----------
create or replace function public.post_message(p_id uuid, p_body text)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._uid(); c public.challenges;
begin
  select * into c from public.challenges where id = p_id;
  if not found then raise exception 'Challenge-ul nu există.' using errcode = '22023'; end if;
  perform public._require_group_member(c.group_id);
  if not public._is_player(c, uid) then
    raise exception 'Doar cei intrați în challenge pot scrie aici.' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_body,''))) not between 1 and 500 then
    raise exception 'Mesajul trebuie să aibă între 1 și 500 de caractere.' using errcode = '22023';
  end if;
  if (select count(*) from public.challenge_messages where user_id = uid and created_at > now() - interval '1 minute') >= 20 then
    raise exception 'Prea multe mesaje. Așteaptă puțin.' using errcode = '22023';
  end if;
  insert into public.challenge_messages (challenge_id, user_id, body) values (p_id, uid, btrim(p_body));
end $$;

-- ---------- counter-offers ----------
create or replace function public.propose_counter(p_id uuid, p_descr text, p_stake numeric)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._uid(); c public.challenges := public._challenge_for_update(p_id);
        v_descr text := nullif(btrim(coalesce(p_descr,'')), ''); v_stake numeric := p_stake; new_id uuid;
begin
  if c.status <> 'open' then raise exception 'Contra-oferta se poate face doar înainte de pornire.' using errcode = '22023'; end if;
  if uid = c.creator then raise exception 'Poți modifica direct doar prin anulare și challenge nou.' using errcode = '22023'; end if;
  if v_descr is not null and v_descr = coalesce(c.descr,'') then v_descr := null; end if;
  if v_stake is not null and round(v_stake, 2) = c.stake then v_stake := null; end if;
  if v_descr is null and v_stake is null then
    raise exception 'Schimbă regulile sau miza ca să faci o contra-ofertă.' using errcode = '22023';
  end if;
  if v_descr is not null and char_length(v_descr) > 600 then raise exception 'Regulile pot avea maxim 600 de caractere.' using errcode = '22023'; end if;
  if v_stake is not null and (v_stake < 0.5 or v_stake > 1000) then
    raise exception 'Miza trebuie să fie între £0.50 și £1000.' using errcode = '22023';
  end if;
  update public.challenge_offers set status = 'withdrawn', decided_at = now()
   where challenge_id = p_id and proposer = uid and status = 'pending';
  insert into public.challenge_offers (challenge_id, proposer, descr, stake)
  values (p_id, uid, v_descr, case when v_stake is null then null else round(v_stake, 2) end)
  returning id into new_id;
  return new_id;
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
  -- new terms: everyone who joined on the old terms must join again; the proposer is in automatically
  update public.challenges set
    descr        = coalesce(o.descr, descr),
    stake        = coalesce(o.stake, stake),
    participants = case when kind = 'duel' then array[creator, o.proposer] else participants end,
    backers      = case when kind = 'personal' then array[o.proposer] else backers end
  where id = c.id;
  update public.challenge_offers set status = 'accepted', decided_at = now() where id = p_offer;
  update public.challenge_offers set status = 'superseded', decided_at = now()
   where challenge_id = c.id and status = 'pending' and id <> p_offer;
end $$;

create or replace function public.withdraw_counter(p_offer uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._uid();
begin
  update public.challenge_offers set status = 'withdrawn', decided_at = now()
   where id = p_offer and proposer = uid and status = 'pending';
  if not found then raise exception 'Poți retrage doar contra-ofertele tale în așteptare.' using errcode = '22023'; end if;
end $$;

-- ---------- payments (per group) ----------
create or replace function public.record_payment(p_group uuid, p_period date, p_from uuid, p_to uuid, p_amount numeric)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._require_group_member(p_group);
begin
  if uid <> p_from and uid <> p_to then raise exception 'Poți bifa doar plăți în care ești implicat.' using errcode = '42501'; end if;
  if p_from = p_to then raise exception 'Plată invalidă.' using errcode = '22023'; end if;
  if not exists (select 1 from public.group_members where group_id = p_group and user_id = p_from)
     or not exists (select 1 from public.group_members where group_id = p_group and user_id = p_to) then
    raise exception 'Persoana nu e în grup.' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 10000 then raise exception 'Sumă invalidă.' using errcode = '22023'; end if;
  if p_period is null or p_period <> date_trunc('month', p_period)::date
     or p_period > (date_trunc('month', now()) + interval '1 month')::date or p_period < date '2026-01-01' then
    raise exception 'Lună invalidă.' using errcode = '22023';
  end if;
  insert into public.payments (group_id, period, from_id, to_id, amount, created_by) values (p_group, p_period, p_from, p_to, round(p_amount, 2), uid);
end $$;

create or replace function public.delete_payment(p_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._uid();
begin
  delete from public.payments where id = p_id and created_by = uid;
  if not found then raise exception 'Poți anula doar plățile bifate de tine.' using errcode = '42501'; end if;
end $$;

-- ---------- permissions ----------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f' loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
grant usage on schema public to authenticated;
grant select on public.groups, public.group_members, public.challenges, public.proofs, public.votes, public.payments, public.challenge_messages, public.challenge_offers to authenticated;

alter publication supabase_realtime add table public.groups, public.group_members, public.challenge_messages, public.challenge_offers;

commit;

-- check: should show your group(s) with their codes
select name, invite_code, (select count(*) from public.group_members m where m.group_id = g.id) as membri from public.groups g;
