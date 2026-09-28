-- 0001 · Portal schema v2
--
-- Replaces the ad-hoc Supabase-era tables. Also closes three long-standing
-- defects: D9 (no draft/publish state), D10 (comments referenced articles by a
-- mutable slug string with no foreign key), D8 (no comment nesting).
--
-- users.is_admin and articles.views are created but unread in S1 — S2 reads the
-- former, S6 the latter. They exist here so those stages add no new migration.

create table users (
  id           uuid primary key,
  github_login text not null unique,
  display_name text,
  avatar_url   text,
  -- Deliberately NOT sourced from a JWT claim: user_metadata is writable by the
  -- user via supabase.auth.updateUser, which is exactly defect D1.
  is_admin     boolean not null default false,
  created_at   timestamptz not null default now()
);

create table articles (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  title        text not null,
  excerpt      text not null,
  content_md   text not null,
  category     text not null,
  -- Kept as an array, not a join table: at blog scale (tens of tags) this is
  -- queried with `tags @> array[...]` backed by the GIN index below.
  tags         text[] not null default '{}',
  cover_image  text,
  read_time    integer not null default 5 check (read_time > 0),

  status       text not null default 'draft'
               check (status in ('draft', 'published', 'archived')),
  published_at timestamptz,
  views        integer not null default 0 check (views >= 0),

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- The invariant lives in the database, not in application discipline: a
  -- published article cannot exist without a publication timestamp.
  constraint published_needs_timestamp
    check (status <> 'published' or published_at is not null)
);

create table comments (
  id         uuid primary key default gen_random_uuid(),
  -- Foreign key instead of the old `article_slug text`: renaming a slug used to
  -- silently orphan every comment on that article, with nothing objecting.
  article_id uuid not null references articles(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  parent_id  uuid references comments(id) on delete cascade,

  -- The old table had no length bound at all, so a client could post an
  -- arbitrarily large body.
  content    text not null check (length(content) between 1 and 4000),
  created_at timestamptz not null default now(),

  constraint no_self_reply check (parent_id is null or parent_id <> id)
);

-- Keyset pagination for the public list: (status, published_at desc, id desc)
-- matches both the filter and the ORDER BY so the scan stops at the cursor.
create index articles_list_keyset
  on articles (status, published_at desc nulls last, id desc);

create index articles_tags_gin
  on articles using gin (tags);

create index articles_category
  on articles (category);

create index comments_article_time
  on comments (article_id, created_at desc);

create index comments_parent
  on comments (parent_id);
