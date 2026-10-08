-- =====================================================================
-- Challenge Pot — migration 003: tidy-ups from the Supabase security advisor
-- Internal helpers are only called from inside the app's own functions, so signed-in
-- users don't need to call them directly. Helpers used by access rules stay callable.
-- =====================================================================
revoke execute on function public._uid() from authenticated;
revoke execute on function public._require_group_member(uuid) from authenticated;
revoke execute on function public._challenge_for_update(uuid) from authenticated;
revoke execute on function public._eligible_voters(public.challenges) from authenticated;
revoke execute on function public._new_invite_code() from authenticated;

alter function public._check_nick(text) set search_path = '';
alter function public._is_player(public.challenges, uuid) set search_path = '';
