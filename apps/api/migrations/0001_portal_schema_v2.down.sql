-- 0001 · Portal schema v2 — reverse

-- Drop order is the reverse of creation because of the foreign keys: comments
-- depends on articles and users, so it must go first. Postgres will refuse to
-- drop a table another table still references.

drop table comments;
drop table articles;
drop table users;
