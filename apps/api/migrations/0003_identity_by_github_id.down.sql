-- 0003 · reverse

-- Refuses if any two rows now share a login — which is expected after this
-- migration existed, and the honest response is to surface it rather than
-- silently delete a row to make the constraint fit.
alter table users add constraint users_github_login_key unique (github_login);

drop index if exists users_github_login;
drop index if exists users_github_id;
alter table users drop column github_id;
