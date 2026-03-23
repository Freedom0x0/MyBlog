create table if not exists public.comments (
  id uuid default gen_random_uuid() primary key,
  article_slug text not null,
  user_id uuid references auth.users not null,
  user_name text not null,
  avatar_url text,
  content text not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Set up Row Level Security (RLS)
alter table public.comments enable row level security;

-- Create policies
create policy "Public comments are viewable by everyone." on public.comments
  for select using (true);

create policy "Users can insert their own comments." on public.comments
  for insert with check (auth.uid() = user_id);

create policy "Users can update their own comments." on public.comments
  for update using (auth.uid() = user_id);

create policy "Users can delete their own comments." on public.comments
  for delete using (auth.uid() = user_id);
