-- 0002 · refresh tokens
--
-- S1 built users.id with no default because Supabase supplied identities. This
-- service creates its own users now, so the column needs to generate one.
alter table users alter column id set default gen_random_uuid();

create table refresh_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,

  -- SHA-256 hex of the token, never the token itself: a database dump must not
  -- hand over live credentials.
  token_hash  text not null unique,

  -- Tokens issued by refreshing another share a family, so detecting reuse of a
  -- spent one can revoke the whole chain rather than a single row.
  family_id   uuid not null,

  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null,

  -- Non-null means spent: rotated away, or revoked by logout / reuse detection.
  revoked_at  timestamptz,

  -- Diagnostics only. Never an authorisation input: treating a user-agent change
  -- as suspicious would evict people whenever their browser updates.
  client_hint text
);

create index refresh_tokens_user   on refresh_tokens (user_id);
create index refresh_tokens_family on refresh_tokens (family_id);

-- Partial index: cleanup and expiry checks only ever look at live rows, and
-- spent rows accumulate forever otherwise.
create index refresh_tokens_expiry
  on refresh_tokens (expires_at)
  where revoked_at is null;
