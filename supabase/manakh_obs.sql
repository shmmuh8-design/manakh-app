-- مناخ: رصد المشاهدين (كتابة + صور + فيديو). الوصول فقط من الدالة السحابية manakh-obs.
create table if not exists public.manakh_obs (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  kind        text not null check (kind in ('weather','sky')),
  topic       text not null,
  body        text not null default '',
  place       text not null default '',
  author      text not null default '',
  media_path  text,
  media_type  text check (media_type in ('image','video')),
  device      text not null,
  ip          text not null default '',
  reports     int  not null default 0,
  hidden      boolean not null default false
);
create index if not exists manakh_obs_feed on public.manakh_obs (kind, hidden, id desc);
create table if not exists public.manakh_obs_reports (
  obs_id  bigint references public.manakh_obs(id) on delete cascade,
  device  text not null,
  reason  text not null default '',
  created_at timestamptz not null default now(),
  primary key (obs_id, device)
);
alter table public.manakh_obs         enable row level security;
alter table public.manakh_obs_reports enable row level security;
revoke all on public.manakh_obs, public.manakh_obs_reports from anon, authenticated;

-- مخزن الصور والفيديو: عام للقراءة، والرفع فقط بروابط موقّعة من الدالة. حد أقصى 25 ميجا للملف.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('manakh-obs', 'manakh-obs', true, 26214400, array['image/jpeg','image/png','image/webp','image/heic','video/mp4','video/quicktime'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
