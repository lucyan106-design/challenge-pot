-- =====================================================================
-- Challenge Pot — Supabase schema
-- Paste the whole file into: Supabase Dashboard → SQL Editor → New query → Run
-- Safe to run once on a fresh project.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- tables ----------
create table public.app_settings (
  id          int primary key default 1 check (id = 1),
  invite_code text not null check (char_length(invite_code) between 4 and 32)
);

create table public.members (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  nick      text not null check (char_length(btrim(nick)) between 1 and 24),
  is_admin  boolean not null default false,
  joined_at timestamptz not null default now()
);

create table public.challenges (
  id           uuid primary key default gen_random_uuid(),
  title        text not null check (char_length(btrim(title)) between 1 and 90),
  descr        text not null default '' check (char_length(descr) <= 600),
  kind         text not null check (kind in ('duel','personal')),
  stake        numeric(8,2) not null check (stake >= 0.5 and stake <= 1000),
  creator      uuid not null references public.members(user_id) on delete cascade,
  participants uuid[] not null default '{}',
  backers      uuid[] not null default '{}',
  deadline     date,
  status       text not null default 'open' check (status in ('open','active','voting','settled','cancelled')),
  result       jsonb,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  settled_at   timestamptz
);
create index challenges_created_idx on public.challenges (created_at desc);

create table public.proofs (
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  user_id      uuid not null references public.members(user_id) on delete cascade,
  body         text not null default '' check (char_length(body) <= 600),
  photo_path   text,
  updated_at   timestamptz not null default now(),
  primary key (challenge_id, user_id)
);

create table public.votes (
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  voter_id     uuid not null references public.members(user_id) on delete cascade,
  pick         text not null,
  updated_at   timestamptz not null default now(),
  primary key (challenge_id, voter_id)
);

create table public.payments (
  id         uuid primary key default gen_random_uuid(),
  from_id    uuid not null references public.members(user_id) on delete cascade,
  to_id      uuid not null references public.members(user_id) on delete cascade,
  amount     numeric(8,2) not null check (amount > 0 and amount <= 10000),
  created_by uuid not null references public.members(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  check (from_id <> to_id)
);

-- ---------- row level security: members read everything, nobody writes directly ----------
alter table public.app_settings enable row level security;
alter table public.members      enable row level security;
alter table public.challenges   enable row level security;
alter table public.proofs       enable row level security;
alter table public.votes        enable row level security;
alter table public.payments     enable row level security;

create or replace function public.is_member()
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.members where user_id = auth.uid()) $$;

create policy "members read members"    on public.members    for select to authenticated using (public.is_member());
create policy "members read challenges" on public.challenges for select to authenticated using (public.is_member());
create policy "members read proofs"     on public.proofs     for select to authenticated using (public.is_member());
create policy "members read votes"      on public.votes      for select to authenticated using (public.is_member());
create policy "members read payments"   on public.payments   for select to authenticated using (public.is_member());
-- app_settings: no policies → only reachable through the admin functions below.

-- ---------- helpers ----------
create or replace function public._require_member()
returns uuid language plpgsql stable security definer set search_path = ''
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Nu ești logat.' using errcode = '28000'; end if;
  if not exists (select 1 from public.members where user_id = uid) then
    raise exception 'Nu ești în grup. Intră cu codul de invitație.' using errcode = '42501';
  end if;
  return uid;
end $$;

-- ---------- group ----------
create or replace function public.join_group(p_code text, p_nick text)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := auth.uid(); code text;
begin
  if uid is null then raise exception 'Nu ești logat.' using errcode = '28000'; end if;
  select invite_code into code from public.app_settings where id = 1;
  if code is null or upper(btrim(coalesce(p_code,''))) <> upper(code) then
    raise exception 'Cod de invitație greșit.' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_nick,''))) not between 1 and 24 then
    raise exception 'Numele trebuie să aibă între 1 și 24 de caractere.' using errcode = '22023';
  end if;
  insert into public.members (user_id, nick, is_admin)
  values (uid, btrim(p_nick), not exists (select 1 from public.members))
  on conflict (user_id) do update set nick = excluded.nick;
end $$;

create or replace function public.set_nick(p_nick text)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._require_member();
begin
  if char_length(btrim(coalesce(p_nick,''))) not between 1 and 24 then
    raise exception 'Numele trebuie să aibă între 1 și 24 de caractere.' using errcode = '22023';
  end if;
  update public.members set nick = btrim(p_nick) where user_id = uid;
end $$;

create or replace function public.get_invite_code()
returns text language plpgsql stable security definer set search_path = ''
as $$
declare uid uuid := public._require_member();
begin
  if not exists (select 1 from public.members where user_id = uid and is_admin) then
    raise exception 'Doar administratorul vede codul.' using errcode = '42501';
  end if;
  return (select invite_code from public.app_settings where id = 1);
end $$;

create or replace function public.set_invite_code(p_code text)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._require_member();
begin
  if not exists (select 1 from public.members where user_id = uid and is_admin) then
    raise exception 'Doar administratorul schimbă codul.' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_code,''))) not between 4 and 32 then
    raise exception 'Codul trebuie să aibă între 4 și 32 de caractere.' using errcode = '22023';
  end if;
  update public.app_settings set invite_code = upper(btrim(p_code)) where id = 1;
end $$;

-- ---------- challenges ----------
create or replace function public.create_challenge(p_title text, p_descr text, p_kind text, p_stake numeric, p_deadline date)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._require_member(); new_id uuid;
begin
  if p_kind not in ('duel','personal') then raise exception 'Tip necunoscut.' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_title,''))) not between 1 and 90 then
    raise exception 'Scrie provocarea (maxim 90 de caractere).' using errcode = '22023';
  end if;
  if p_stake is null or p_stake < 0.5 or p_stake > 1000 then
    raise exception 'Miza trebuie să fie între £0.50 și £1000.' using errcode = '22023';
  end if;
  insert into public.challenges (title, descr, kind, stake, creator, participants, deadline)
  values (btrim(p_title), left(coalesce(btrim(p_descr),''), 600), p_kind, round(p_stake, 2), uid,
          case when p_kind = 'duel' then array[uid] else '{}'::uuid[] end, p_deadline)
  returning id into new_id;
  return new_id;
end $$;

create or replace function public.join_challenge(p_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._require_member(); c public.challenges;
begin
  select * into c from public.challenges where id = p_id for update;
  if not found then raise exception 'Challenge-ul nu există.' using errcode = '22023'; end if;
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
declare uid uuid := public._require_member(); c public.challenges;
begin
  select * into c from public.challenges where id = p_id for update;
  if not found then raise exception 'Challenge-ul nu există.' using errcode = '22023'; end if;
  if c.status <> 'open' then raise exception 'Nu mai poți ieși, challenge-ul a pornit.' using errcode = '22023'; end if;
  if uid = c.creator then raise exception 'Cine a lansat challenge-ul îl poate doar anula.' using errcode = '22023'; end if;
  update public.challenges
     set participants = array_remove(participants, uid), backers = array_remove(backers, uid)
   where id = p_id;
end $$;

create or replace function public.start_challenge(p_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._require_member(); c public.challenges;
begin
  select * into c from public.challenges where id = p_id for update;
  if not found then raise exception 'Challenge-ul nu există.' using errcode = '22023'; end if;
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
declare uid uuid := public._require_member(); c public.challenges;
begin
  select * into c from public.challenges where id = p_id for update;
  if not found then raise exception 'Challenge-ul nu există.' using errcode = '22023'; end if;
  if c.creator <> uid then raise exception 'Doar cine a lansat challenge-ul îl poate anula.' using errcode = '42501'; end if;
  if c.status <> 'open' then raise exception 'Se poate anula doar înainte de pornire.' using errcode = '22023'; end if;
  update public.challenges set status = 'cancelled' where id = p_id;
end $$;

create or replace function public._is_player(c public.challenges, uid uuid)
returns boolean language sql immutable
as $$ select case when c.kind = 'duel' then uid = any(c.participants)
                  else uid = c.creator or uid = any(c.backers) end $$;

create or replace function public.open_voting(p_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._require_member(); c public.challenges;
begin
  select * into c from public.challenges where id = p_id for update;
  if not found then raise exception 'Challenge-ul nu există.' using errcode = '22023'; end if;
  if c.status <> 'active' then raise exception 'Votul se deschide doar pentru un challenge în desfășurare.' using errcode = '22023'; end if;
  if not public._is_player(c, uid) then raise exception 'Doar jucătorii pot deschide votul.' using errcode = '42501'; end if;
  update public.challenges set status = 'voting' where id = p_id;
end $$;

create or replace function public.submit_proof(p_id uuid, p_body text, p_photo_path text)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._require_member(); c public.challenges;
begin
  select * into c from public.challenges where id = p_id;
  if not found then raise exception 'Challenge-ul nu există.' using errcode = '22023'; end if;
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

create or replace function public.cast_vote(p_id uuid, p_pick text)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._require_member(); c public.challenges;
begin
  select * into c from public.challenges where id = p_id;
  if not found then raise exception 'Challenge-ul nu există.' using errcode = '22023'; end if;
  if c.status <> 'voting' then raise exception 'Votul nu e deschis.' using errcode = '22023'; end if;
  if c.kind = 'personal' then
    if uid = c.creator then raise exception 'Nu poți vota la propria provocare.' using errcode = '42501'; end if;
    if p_pick not in ('success','fail') then raise exception 'Vot invalid.' using errcode = '22023'; end if;
  else
    if p_pick !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Vot invalid.' using errcode = '22023';
    end if;
    if not p_pick::uuid = any(c.participants) then
      raise exception 'Vot invalid.' using errcode = '22023';
    end if;
    if p_pick::uuid = uid then raise exception 'Nu poți vota pentru tine.' using errcode = '42501'; end if;
  end if;
  insert into public.votes (challenge_id, voter_id, pick, updated_at) values (p_id, uid, p_pick, now())
  on conflict (challenge_id, voter_id) do update set pick = excluded.pick, updated_at = now();
end $$;

create or replace function public.votes_needed(p_id uuid)
returns int language plpgsql stable security definer set search_path = ''
as $$
declare c public.challenges; eligible int;
begin
  perform public._require_member();
  select * into c from public.challenges where id = p_id;
  if not found then return null; end if;
  select count(*) into eligible from public.members;
  if c.kind = 'personal' then eligible := eligible - 1; end if;
  return greatest(1, ceil(eligible / 2.0)::int);
end $$;

create or replace function public.settle_challenge(p_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._require_member(); c public.challenges; cast_count int; need int;
        res jsonb; top int; ok int; ko int;
begin
  select * into c from public.challenges where id = p_id for update;
  if not found then raise exception 'Challenge-ul nu există.' using errcode = '22023'; end if;
  if c.status <> 'voting' then raise exception 'Votul nu e deschis.' using errcode = '22023'; end if;
  if not public._is_player(c, uid) then raise exception 'Doar jucătorii pot închide votul.' using errcode = '42501'; end if;
  select count(*) into cast_count from public.votes where challenge_id = p_id;
  need := public.votes_needed(p_id);
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

-- ---------- payments ----------
create or replace function public.record_payment(p_from uuid, p_to uuid, p_amount numeric)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._require_member();
begin
  if uid <> p_from and uid <> p_to then raise exception 'Poți bifa doar plăți în care ești implicat.' using errcode = '42501'; end if;
  if p_from = p_to then raise exception 'Plată invalidă.' using errcode = '22023'; end if;
  if not exists (select 1 from public.members where user_id = p_from) or not exists (select 1 from public.members where user_id = p_to) then
    raise exception 'Persoana nu e în grup.' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 10000 then raise exception 'Sumă invalidă.' using errcode = '22023'; end if;
  insert into public.payments (from_id, to_id, amount, created_by) values (p_from, p_to, round(p_amount, 2), uid);
end $$;

create or replace function public.delete_payment(p_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public._require_member();
begin
  delete from public.payments where id = p_id and created_by = uid;
  if not found then raise exception 'Poți anula doar plățile bifate de tine.' using errcode = '42501'; end if;
end $$;

-- ---------- table access for signed-in users (row level security still applies) ----------
grant usage on schema public to authenticated;
grant select on public.members, public.challenges, public.proofs, public.votes, public.payments to authenticated;

-- ---------- function permissions: only signed-in users ----------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f' loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;

-- ---------- photo storage (private bucket, members only) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('proofs', 'proofs', false, 10485760, array['image/jpeg','image/png','image/webp','image/heic','image/heif','image/gif'])
on conflict (id) do nothing;

create policy "members read proof photos" on storage.objects for select to authenticated
  using (bucket_id = 'proofs' and public.is_member());
create policy "members upload own proof photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'proofs' and public.is_member() and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- live updates ----------
alter publication supabase_realtime add table public.members, public.challenges, public.proofs, public.votes, public.payments;

-- ---------- invite code (change it here before running, or later from the app) ----------
insert into public.app_settings (id, invite_code) values (1, 'POT-TQ6HZH') on conflict (id) do nothing;
