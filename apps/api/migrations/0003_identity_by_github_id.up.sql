-- 0003 · key identity on GitHub's immutable id, not the login
--
-- Two facts about the login made it an unsafe identity key:
--
-- 1. GitHub logins are mutable — a person renames, and the old name is released.
-- 2. When it is released, *someone else can register it*.
--
-- Login used to be this table's unique identity, so the OAuth upsert
-- (`on conflict (github_login) do update … returning id`) resolved a brand new
-- account into an existing row: register a vacated login, complete OAuth, and you
-- are signed in as that other account, with its is_admin and its comment history.
-- `admin grant <login>` and comments' author join made the same mistake smaller.
--
-- GitHub's numeric user id never changes and is never released, so it is the only
-- durable key available. Login stays, demoted to display and lookup.
--
-- 0001 is already applied locally, so this is a new migration rather than an edit.

alter table users add column github_id bigint;

-- Partial: existing dev rows have no id until their owners sign in once again.
create unique index users_github_id on users (github_id) where github_id is not null;

-- The uniqueness itself is the vulnerability: two genuinely different people can
-- hold the same login at different times, and a unique constraint turns that
-- collision into a merge.
alter table users drop constraint users_github_login_key;

create index users_github_login on users (github_login);
