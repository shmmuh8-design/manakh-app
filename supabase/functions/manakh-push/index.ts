// مناخ — إشعارات الخادم عبر Apple Push (APNs)
// action:'sync'  ← التطبيق يرسل رمز الجهاز وموقعه وتفضيلاته ومواعيده الفلكية القادمة
// action:'tick'  ← pg_cron كل دقيقة: يرسل المواعيد المستحقة، وكل ١٠ دقائق يفحص الطقس والمد
// الأسرار (تُضاف من Edge Functions ← Secrets): APNS_KEY_P8 ، APNS_KEY_ID ، APNS_TEAM_ID
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TOPIC = "com.salemaljabri.manakh";
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

// ---------------- APNs ----------------
const b64u = (buf: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof buf === "string" ? new TextEncoder().encode(buf) : new Uint8Array(buf as ArrayBuffer);
  let s = ""; bytes.forEach((b) => s += String.fromCharCode(b));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
let jwtCache = { tok: "", at: 0 };
async function apnsJwt() {
  if (jwtCache.tok && Date.now() - jwtCache.at < 40 * MIN) return jwtCache.tok;
  const pem = (Deno.env.get("APNS_KEY_P8") ?? "").replace(/\\n/g, "\n");
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  if (!body) throw new Error("APNS_KEY_P8 missing");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(JSON.stringify({ alg: "ES256", kid: (Deno.env.get("APNS_KEY_ID") ?? "").trim() }));
  const claims = b64u(JSON.stringify({ iss: (Deno.env.get("APNS_TEAM_ID") ?? "").trim(), iat: Math.floor(Date.now() / 1000) }));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(head + "." + claims));
  jwtCache = { tok: head + "." + claims + "." + b64u(sig), at: Date.now() };
  return jwtCache.tok;
}
// يرجّع: "ok" | "gone" (الرمز انتهى — نحذف الجهاز) | "err"
async function push(token: string, title: string, body: string, collapse?: string): Promise<string> {
  const payload = JSON.stringify({ aps: { alert: { title, body }, sound: "default" } });
  const send = async (host: string) => {
    const h: Record<string, string> = {
      authorization: "bearer " + await apnsJwt(), "apns-topic": TOPIC, "apns-push-type": "alert", "apns-priority": "10", "content-type": "application/json",
    };
    if (collapse) h["apns-collapse-id"] = collapse.slice(0, 60);
    return await fetch(`https://${host}/3/device/${token}`, { method: "POST", headers: h, body: payload });
  };
  try {
    let r = await send("api.push.apple.com");
    if (r.status === 400) {
      const why = (await r.json().catch(() => ({}))).reason;
      if (why === "BadDeviceToken") r = await send("api.sandbox.push.apple.com"); // نسخ التطوير
      else { console.warn("apns 400", why); return "err"; }
    }
    if (r.status === 200) return "ok";
    if (r.status === 410) return "gone";
    const why = (await r.json().catch(() => ({}))).reason;
    console.warn("apns", r.status, why);
    if (r.status === 400 && why === "BadDeviceToken") return "gone";
    if (r.status === 403 && why === "InvalidProviderToken") jwtCache = { tok: "", at: 0 };
    return "err";
  } catch (e) { console.warn("apns fetch", String(e)); return "err"; }
}

// ---------------- أدوات ----------------
const clean = (s: unknown, n: number) => String(s ?? "").replace(/[\u0000-\u001F]/g, " ").trim().slice(0, n);
const num = (v: unknown, lo: number, hi: number) => { const x = Number(v); return Number.isFinite(x) && x >= lo && x <= hi ? x : null; };
const DIRS = ["الشمال", "الشمال الشرقي", "الشرق", "الجنوب الشرقي", "الجنوب", "الجنوب الغربي", "الغرب", "الشمال الغربي"];
const dirName = (deg: number) => DIRS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
const angDiff = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const fmtTime = (t: number, tz: string) => { try { return new Intl.DateTimeFormat("ar-u-nu-latn", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz }).format(t); } catch { return new Date(t).toISOString().slice(11, 16); } };
const on = (p: any, k: string) => p?.[k] !== false;

type Dev = { token: string; lat: number | null; lon: number | null; place: string | null; tide_lat: number | null; tide_lon: number | null; tz: string | null; prefs: any; events: any[]; sent: Record<string, number>; wind_deg: number | null; updated_at: string };

// ---------------- الطقس ----------------
async function weatherFor(points: { lat: number; lon: number }[]) {
  const out: any[] = [];
  for (let i = 0; i < points.length; i += 80) {
    const part = points.slice(i, i + 80);
    const url = "https://api.open-meteo.com/v1/forecast?latitude=" + part.map((p) => p.lat).join(",") + "&longitude=" + part.map((p) => p.lon).join(",") +
      "&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m,relative_humidity_2m" +
      "&hourly=weather_code,precipitation_probability,precipitation,wind_gusts_10m&forecast_hours=4&timezone=GMT&wind_speed_unit=kmh";
    try {
      let j = await (await fetch(url)).json();
      if (!Array.isArray(j)) j = [j];
      out.push(...j);
    } catch { part.forEach(() => out.push(null)); }
  }
  return out;
}
async function tidesFor(lat: number, lon: number) {
  try {
    const j = await (await fetch(`https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&hourly=sea_level_height_msl&forecast_days=2&timezone=GMT`)).json();
    const t = (j.hourly?.time ?? []).map((s: string) => new Date(s + "Z").getTime()), v = j.hourly?.sea_level_height_msl ?? [];
    const ex: { high: boolean; t: number }[] = [];
    for (let i = 1; i < v.length - 1; i++) {
      const a = v[i - 1], b = v[i], c = v[i + 1];
      if (a == null || b == null || c == null) continue;
      const hi = b > a && b >= c, lo = b < a && b <= c;
      if (!hi && !lo) continue;
      const den = a - 2 * b + c, off = den ? 0.5 * (a - c) / den : 0;   // قمة القطع المكافئ بين الساعات
      ex.push({ high: hi, t: t[i] + off * HOUR });
    }
    return ex;
  } catch { return null; }
}

// ---------------- التشغيل الدوري ----------------
async function tick(force = false) {
  const now = Date.now(), minute = new Date(now).getUTCMinutes();
  const wxTurn = force || minute % 10 === 0;
  const { data, error } = await db.from("mk_devices").select("*").limit(5000);
  if (error) throw error;
  const devs = (data ?? []) as Dev[];
  const changed = new Map<string, Partial<Dev>>();
  const gone: string[] = [];
  let sentCount = 0;
  const mark = (d: Dev, key: string) => { d.sent[key] = now; changed.set(d.token, { ...(changed.get(d.token) ?? {}), sent: d.sent }); };
  const was = (d: Dev, key: string) => !!d.sent[key];
  const send = async (d: Dev, key: string, title: string, body: string) => {
    if (gone.includes(d.token) || was(d, key)) return;
    const r = await push(d.token, title, body, key);
    if (r === "gone") { gone.push(d.token); return; }
    if (r === "ok") { mark(d, key); sentCount++; }
  };

  for (const d of devs) { d.sent = d.sent ?? {}; d.prefs = d.prefs ?? {}; d.events = Array.isArray(d.events) ? d.events : []; }

  // ١) المواعيد الفلكية المستحقة (القمر، الأنواء، الاقترانات، الشهب، المحطة)
  for (const d of devs) {
    for (const e of d.events) {
      const at = Number(e.at);
      if (!(at <= now && at > now - 4 * MIN)) continue;
      if (e.k && !on(d.prefs, e.k)) continue;
      await send(d, "ev:" + e.id, clean(e.title, 120), clean(e.body, 240));
    }
    // تذكير لطيف إذا ما فُتح التطبيق من زمان (عشان تتحدّث المواعيد)
    const age = now - new Date(d.updated_at).getTime();
    if (age > 12 * DAY && !Object.keys(d.sent).some((k) => k.startsWith("stale:") && now - d.sent[k] < 14 * DAY))
      if (new Date(now).getUTCHours() === 5 && minute === 30) await send(d, "stale:" + Math.floor(now / DAY), "🌙 مناخ", "افتح التطبيق لحظة عشان نحدّث مواعيد القمر والأنواء والاقترانات القادمة");
  }

  // ٢) الطقس والمد كل ١٠ دقائق
  if (wxTurn) {
    const wxDevs = devs.filter((d) => d.lat != null && d.lon != null && ["thunder", "rain", "wind", "humidity"].some((k) => on(d.prefs, k)));
    const keyOf = (d: Dev) => (Math.round(d.lat! * 10) / 10) + "," + (Math.round(d.lon! * 10) / 10);
    const uniq = [...new Set(wxDevs.map(keyOf))];
    const res = await weatherFor(uniq.map((k) => ({ lat: +k.split(",")[0], lon: +k.split(",")[1] })));
    const wx = new Map(uniq.map((k, i) => [k, res[i]]));
    const b6 = Math.floor(now / (6 * HOUR)), b12 = Math.floor(now / (12 * HOUR)), bDay = Math.floor((now + 4 * HOUR) / DAY);

    for (const d of wxDevs) {
      const w = wx.get(keyOf(d));
      if (!w?.hourly) continue;
      const place = d.place || "منطقتك", h = w.hourly, c = w.current ?? {};
      const codes: number[] = h.weather_code ?? [], prob: number[] = h.precipitation_probability ?? [], pr: number[] = h.precipitation ?? [];
      // ⚡ الرعد والبرق
      if (on(d.prefs, "thunder")) {
        const i = codes.slice(0, 4).findIndex((x) => x >= 95);
        if (i >= 0) await send(d, "th:" + b6, "⚡ عواصف رعدية متوقعة", (i === 0 ? "الآن" : "خلال " + i + " ساعة") + " في " + place + " — رعد وبرق محتمل، خذ الحيطة");
      }
      // 🌧️ المطر
      if (on(d.prefs, "rain")) {
        const i = [0, 1, 2, 3].find((k) => (prob[k] ?? 0) >= 60 && (pr[k] ?? 0) >= 0.5);
        if (i !== undefined) await send(d, "rn:" + b6, "🌧️ أمطار متوقعة", (i === 0 ? "الآن" : "خلال " + i + " ساعة") + " في " + place + " — احتمال " + prob[i] + "٪ وكمية تقارب " + pr[i] + " ملم");
      }
      // 💨 الرياح: هبّات قوية أو تغيّر اتجاه واضح
      if (on(d.prefs, "wind")) {
        const gust = Math.max(c.wind_gusts_10m ?? 0, ...((h.wind_gusts_10m ?? []).slice(0, 3).map((x: number) => x ?? 0)));
        if (gust >= 45) await send(d, "wg:" + b12, "💨 رياح قوية", "هبّات تصل " + Math.round(gust) + " كم/س في " + place + " خلال الساعات القادمة");
        const spd = c.wind_speed_10m ?? 0, deg = c.wind_direction_10m;
        if (deg != null && spd >= 8) {
          if (d.wind_deg != null && spd >= 12 && angDiff(deg, d.wind_deg) >= 90)
            await send(d, "wd:" + Math.floor(now / (3 * HOUR)), "🧭 تغيّر اتجاه الرياح", "صارت الرياح من " + dirName(deg) + " بسرعة " + Math.round(spd) + " كم/س في " + place + " (كانت من " + dirName(d.wind_deg) + ")");
          if (d.wind_deg == null || angDiff(deg, d.wind_deg) >= 90 || spd >= 12) { d.wind_deg = deg; changed.set(d.token, { ...(changed.get(d.token) ?? {}), wind_deg: deg }); }
        }
      }
      // 💧 الرطوبة
      if (on(d.prefs, "humidity")) {
        const rh = c.relative_humidity_2m;
        if (rh != null && rh >= 85) await send(d, "hm:" + bDay, "💧 رطوبة عالية", "الرطوبة " + Math.round(rh) + "٪ الحين في " + place + " — احتمال ضباب أو ندى");
      }
    }

    // 🌊 المد والجزر — قبل الموعد بـ ٤٥ دقيقة تقريبًا
    const tdDevs = devs.filter((d) => d.tide_lat != null && d.tide_lon != null && on(d.prefs, "tides"));
    const tKey = (d: Dev) => d.tide_lat!.toFixed(2) + "," + d.tide_lon!.toFixed(2);
    const tides = new Map<string, any>();
    for (const k of new Set(tdDevs.map(tKey))) tides.set(k, await tidesFor(+k.split(",")[0], +k.split(",")[1]));
    for (const d of tdDevs) {
      const ex = tides.get(tKey(d));
      if (!ex) continue;
      for (const e of ex) {
        const left = e.t - now;
        if (left <= 0 || left > 50 * MIN) continue;
        await send(d, "td:" + Math.round(e.t / HOUR), e.high ? "🌊 المد العالي قريب" : "🏖️ الجزر قريب",
          (e.high ? "المد العالي" : "أدنى جزر") + " الساعة " + fmtTime(e.t, d.tz || "Asia/Muscat") + " (بعد " + Math.round(left / MIN) + " دقيقة) — " + (d.place || ""));
      }
    }
  }

  // ٣) حفظ التغييرات + تنظيف السجل القديم + حذف الأجهزة المنتهية
  for (const [token, patch] of changed) {
    if (gone.includes(token)) continue;
    if (patch.sent) for (const k of Object.keys(patch.sent)) if (now - patch.sent[k] > 20 * DAY) delete patch.sent[k];
    await db.from("mk_devices").update(patch).eq("token", token);
  }
  if (gone.length) await db.from("mk_devices").delete().in("token", gone);
  return { devices: devs.length, sent: sentCount, removed: gone.length, weather: wxTurn };
}

// ---------------- الطلبات ----------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let q: any; try { q = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  if (q.action === "sync") {
    const token = clean(q.token, 200).toLowerCase();
    if (!/^[0-9a-f]{64,200}$/.test(token)) return json({ error: "bad token" }, 400);
    const prefs: Record<string, boolean> = {};
    for (const k of ["thunder", "rain", "wind", "humidity", "tides", "moon", "anwaa", "conj", "meteors", "space"]) prefs[k] = q.prefs?.[k] !== false;
    if (q.enabled === false) for (const k of Object.keys(prefs)) prefs[k] = false;
    const now = Date.now();
    const events = (Array.isArray(q.events) ? q.events : []).slice(0, 120)
      .map((e: any) => ({ id: clean(e.id, 60), k: clean(e.k, 12), at: Number(e.at), title: clean(e.title, 120), body: clean(e.body, 240) }))
      .filter((e: any) => e.id && e.title && Number.isFinite(e.at) && e.at > now - HOUR && e.at < now + 400 * DAY);
    let tz = clean(q.tz, 60) || "Asia/Muscat";
    try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { tz = "Asia/Muscat"; }
    const row = {
      token, prefs, events, tz,
      lat: num(q.lat, -90, 90), lon: num(q.lon, -180, 180), place: clean(q.place, 60) || null,
      tide_lat: num(q.tide_lat, -90, 90), tide_lon: num(q.tide_lon, -180, 180),
      updated_at: new Date().toISOString(),
    };
    const { error } = await db.from("mk_devices").upsert(row, { onConflict: "token" });
    if (error) return json({ error: error.message }, 500);
    if (q.test) {
      const r = await push(token, "✅ إشعار تجريبي من مناخ", "وصلك من الخادم — يعني الإشعارات بتوصلك حتى والتطبيق مقفل 👌", "test");
      return json({ ok: true, test: r });
    }
    return json({ ok: true, events: events.length });
  }

  if (q.action === "tick") {
    const { data } = await db.from("mk_config").select("value").eq("key", "cron_secret").maybeSingle();
    if (!data?.value || q.secret !== data.value) return json({ error: "forbidden" }, 403);
    try { return json(await tick(!!q.force)); } catch (e) { return json({ error: String(e) }, 500); }
  }

  return json({ error: "unknown action" }, 400);
});
