create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select coalesce(
    (auth.jwt() -> 'user_metadata' ->> 'user_name') = 'guoshaoran'
    or (auth.jwt() -> 'user_metadata' ->> 'preferred_username') = 'guoshaoran',
    false
  );
$$;

