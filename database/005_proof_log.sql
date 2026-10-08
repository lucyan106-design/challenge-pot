-- =====================================================================
-- Challenge Pot — migration 005: proofs become a dated log
-- Every proof is kept (no more overwriting), stamped with the server's date and time,
-- so a daily challenge shows each day's proof.
-- =====================================================================
begin;

-- backfill while the old key still exists (live updates need a key), then switch keys
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

commit;
