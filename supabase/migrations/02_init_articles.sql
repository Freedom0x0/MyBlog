create table if not exists public.articles (
  id uuid default gen_random_uuid() primary key,
  slug text not null unique,
  title text not null,
  excerpt text not null,
  content_md text not null,
  category text not null,
  tags text[] not null default '{}',
  cover_image text,
  read_time int not null default 5,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select coalesce((auth.jwt() -> 'user_metadata' ->> 'user_name') = 'guoshaoran', false);
$$;

alter table public.articles enable row level security;

create policy "Articles are viewable by everyone." on public.articles
  for select using (true);

create policy "Only admin can insert articles." on public.articles
  for insert with check (public.is_admin());

create policy "Only admin can update articles." on public.articles
  for update using (public.is_admin());

create policy "Only admin can delete articles." on public.articles
  for delete using (public.is_admin());

insert into public.articles (slug, title, excerpt, content_md, category, tags, cover_image, read_time)
values
(
  'react-server-components-deep-dive',
  '深入浅出 React Server Components',
  '探索 React Server Components 的核心概念及其对现代 Web 开发的影响。',
  '# 深入浅出 React Server Components\n\nReact Server Components (RSC) 是 React 团队近年来最重大的创新之一...\n\n```ts\nexport type Hello = { message: string }\n```\n',
  'React',
  array['React','Server Components','Next.js'],
  'https://coresg-normal.trae.ai/api/ide/v1/text_to_image?prompt=abstract%20modern%20web%20development%20concept%20with%20react%20logo%20dark%20theme&image_size=landscape_16_9',
  8
),
(
  'typescript-5-new-features',
  'TypeScript 5.0 新特性全解析',
  '详细介绍 TypeScript 5.0 带来的装饰器支持、性能提升及语法改进。',
  '# TypeScript 5.0 新特性全解析\n\nTypeScript 5.0 引入了许多令人兴奋的新特性...\n\n```ts\nconst hello: string = "TS5"\n```\n',
  'TypeScript',
  array['TypeScript','Frontend'],
  'https://coresg-normal.trae.ai/api/ide/v1/text_to_image?prompt=typescript%20logo%20with%20code%20and%20abstract%20geometric%20shapes%20dark%20blue%20theme&image_size=landscape_16_9',
  12
),
(
  'gsap-animation-tutorial',
  '使用 GSAP 打造电影级的 Web 动画',
  '学习如何利用 GSAP 库创建流畅、高性能的网页交互动画。',
  '# 使用 GSAP 打造电影级的 Web 动画\n\nGSAP (GreenSock Animation Platform) 是 Web 动画领域的黄金标准...\n\n```js\nimport gsap from "gsap"\n```\n',
  'Animation',
  array['GSAP','Animation','UX'],
  'https://coresg-normal.trae.ai/api/ide/v1/text_to_image?prompt=dynamic%20flowing%20abstract%20animation%20visuals%20colorful%20and%20futuristic&image_size=landscape_16_9',
  10
),
(
  'micro-frontends-practice',
  '微前端架构实践指南',
  '在大型企业级应用中实施微前端架构的挑战与最佳实践。',
  '# 微前端架构实践指南\n\n微前端将微服务的理念延伸到了前端开发领域...\n\n```md\n- 独立部署\n- 技术栈无关\n```\n',
  'Architecture',
  array['Architecture','Micro-Frontends'],
  'https://coresg-normal.trae.ai/api/ide/v1/text_to_image?prompt=complex%20modular%20architecture%20diagram%20style%20abstract%20tech%20background&image_size=landscape_16_9',
  15
)
on conflict (slug) do update set
  title = excluded.title,
  excerpt = excluded.excerpt,
  content_md = excluded.content_md,
  category = excluded.category,
  tags = excluded.tags,
  cover_image = excluded.cover_image,
  read_time = excluded.read_time,
  updated_at = timezone('utc'::text, now());

