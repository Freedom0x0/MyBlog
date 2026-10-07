-- 0002 · refresh tokens — reverse

drop table refresh_tokens;

-- The forward direction set a default, so the reverse drops it. Writing this as
-- another `set default` would leave a silent difference between a rolled-forward
-- and a rolled-back database.
alter table users alter column id drop default;
