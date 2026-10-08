-- =====================================================================
-- Challenge Pot — migration 004: "Challenge a friend" (dare)
-- The creator names a friend (target) who has to do something. The target accepts,
-- declines or makes a counter-offer. The creator — and anyone else who wants — bets
-- against the target. Settles like a personal challenge, with the target as the doer.
-- Backwards compatible with the previous app version.
-- =====================================================================
begin;

alter table public.challenges add column if not exists target uuid references auth.users(id) on delete cascade;
alter table public.challenges drop constraint if exists challenges_kind_check;
alter table public.challenges add constraint challenges_kind_check check (kind in ('duel','personal','dare'));

-- who actually does the challenge
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

-- join: in a dare the target "accepts"; anyone else bets against the target
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

-- the challenged friend can decline (cancels it), as can the creator
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

-- accepting a counter-offer on a dare: the creator still bets; the target is "in" if they proposed it
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

commit;
