-- مناخ — إشعارات الخادم (APNs). شغّل هذا الملف مرة وحدة في Supabase ← SQL Editor ← Run
-- ما يحتاج تكتب أي رمز سري: الملف يولّد رمز التشغيل الدوري بنفسه ويحفظه في جدول مقفول.

create extension if not exists pgcrypto;
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- أجهزة الآيفون المسجّلة (رمز الجهاز + الموقع + التفضيلات + المواعيد الفلكية القادمة)
create table if not exists public.mk_devices (
  token       text primary key,
  lat         double precision,
  lon         double precision,
  place       text,
  tide_lat    double precision,
  tide_lon    double precision,
  tz          text default 'Asia/Muscat',
  prefs       jsonb not null default '{}'::jsonb,
  events      jsonb not null default '[]'::jsonb,
  sent        jsonb not null default '{}'::jsonb,
  wind_deg    double precision,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
alter table public.mk_devices enable row level security;   -- بدون أي سياسة = مقفول على الجميع إلا الخادم
revoke all on public.mk_devices from anon, authenticated;

-- إعدادات داخلية (رمز التشغيل الدوري) — مقفولة كذلك
create table if not exists public.mk_config (key text primary key, value text not null);
alter table public.mk_config enable row level security;
revoke all on public.mk_config from anon, authenticated;
insert into public.mk_config(key, value)
  values ('cron_secret', encode(gen_random_bytes(24), 'hex'))
  on conflict (key) do nothing;

-- تشغيل الدالة كل دقيقة
do $$ begin perform cron.unschedule('manakh-push-tick'); exception when others then null; end $$;
select cron.schedule(
  'manakh-push-tick',
  '* * * * *',
  $job$
    select net.http_post(
      url     := 'https://sjnpljsnmbdhykfudebk.supabase.co/functions/v1/manakh--push',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body    := jsonb_build_object('action', 'tick', 'secret', (select value from public.mk_config where key = 'cron_secret')),
      timeout_milliseconds := 55000
    );
  $job$
);

-- تنظيف سجلات pg_net القديمة يوميًا
do $$ begin perform cron.unschedule('manakh-push-clean'); exception when others then null; end $$;
select cron.schedule('manakh-push-clean', '17 3 * * *', $c$ delete from net._http_response where created < now() - interval '1 day' $c$);
