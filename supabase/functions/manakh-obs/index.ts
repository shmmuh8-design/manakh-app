// مناخ — رصد المشاهدين. عام بدون تسجيل دخول، مع حد يومي لكل جهاز، وبلاغات تخفي المنشور تلقائيًا.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const BUCKET = "manakh-obs";
const TOPICS: Record<string, string[]> = {
  weather: ["rain", "clouds", "fog", "dust", "hail", "rainbow", "wadi", "other"],
  sky: ["moon", "sun", "planets", "stars", "meteors", "eclipse", "other"],
};
const DAILY = 8, HIDE_AT = 3;
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "video/mp4": "mp4", "video/quicktime": "mov" };

async function hash(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("manakh:" + s));
  return Array.from(new Uint8Array(b)).slice(0, 10).map((x) => x.toString(16).padStart(2, "0")).join("");
}
const clean = (s: unknown, n: number) => String(s ?? "").replace(/[\u0000-\u0008\u000B-\u001F]/g, "").trim().slice(0, n);
const spammy = (s: string) => /(https?:\/\/|www\.|\.com\b|wa\.me|t\.me)/i.test(s);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let q: any; try { q = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const dev = await hash(clean(q.device, 80) || ip || "anon");
  const iph = ip ? await hash("ip:" + ip) : "";

  if (q.action === "list") {
    const kind = TOPICS[q.kind] ? q.kind : "weather";
    let s = db.from("manakh_obs").select("id,created_at,kind,topic,body,place,author,media_path,media_type,device").eq("kind", kind).eq("hidden", false).order("id", { ascending: false }).limit(30);
    if (q.topic && TOPICS[kind].includes(q.topic)) s = s.eq("topic", q.topic);
    if (q.before) s = s.lt("id", Number(q.before));
    const { data, error } = await s;
    if (error) return json({ error: error.message }, 500);
    return json({ items: (data ?? []).map((r) => ({ ...r, mine: r.device === dev, media_url: r.media_path ? db.storage.from(BUCKET).getPublicUrl(r.media_path).data.publicUrl : null })) });
  }

  // الحد اليومي لكل جهاز ولكل شبكة
  const since = new Date(Date.now() - 864e5).toISOString();
  const countBy = async (col: string, v: string) => v ? (await db.from("manakh_obs").select("id", { count: "exact", head: true }).eq(col, v).gte("created_at", since)).count ?? 0 : 0;

  if (q.action === "sign") {
    const type = String(q.mime ?? "");
    if (!EXT[type]) return json({ error: "نوع الملف غير مدعوم" }, 400);
    if ((await countBy("device", dev)) >= DAILY || (await countBy("ip", iph)) >= DAILY * 3) return json({ error: "وصلت الحد اليومي للمشاركات، جرّب بكرة 🌙" }, 429);
    const kind = TOPICS[q.kind] ? q.kind : "weather";
    const path = `${kind}/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${EXT[type]}`;
    const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error) return json({ error: error.message }, 500);
    return json({ path, url: data.signedUrl, token: data.token });
  }

  if (q.action === "post") {
    const kind = TOPICS[q.kind] ? q.kind : null;
    if (!kind || !TOPICS[kind].includes(q.topic)) return json({ error: "اختار نوع الرصد" }, 400);
    const body = clean(q.body, 500), place = clean(q.place, 60), author = clean(q.author, 40);
    const media_path = q.media_path && String(q.media_path).startsWith(kind + "/") ? clean(q.media_path, 200) : null;
    const media_type = media_path ? (q.media_type === "video" ? "video" : "image") : null;
    if (!body && !media_path) return json({ error: "اكتب شي أو أرفق صورة أو فيديو" }, 400);
    if (spammy(body + " " + author + " " + place)) return json({ error: "الروابط ممنوعة في الرصد" }, 400);
    if ((await countBy("device", dev)) >= DAILY || (await countBy("ip", iph)) >= DAILY * 3) return json({ error: "وصلت الحد اليومي للمشاركات، جرّب بكرة 🌙" }, 429);
    const { data, error } = await db.from("manakh_obs").insert({ kind, topic: q.topic, body, place, author, media_path, media_type, device: dev, ip: iph }).select("id").single();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, id: data.id });
  }

  if (q.action === "report") {
    const id = Number(q.id); if (!id) return json({ error: "id" }, 400);
    const { error } = await db.from("manakh_obs_reports").insert({ obs_id: id, device: dev, reason: clean(q.reason, 200) });
    if (error && !String(error.message).includes("duplicate")) return json({ error: error.message }, 500);
    const { count } = await db.from("manakh_obs_reports").select("obs_id", { count: "exact", head: true }).eq("obs_id", id);
    await db.from("manakh_obs").update({ reports: count ?? 0, hidden: (count ?? 0) >= HIDE_AT }).eq("id", id);
    return json({ ok: true });
  }

  if (q.action === "delete") {
    const id = Number(q.id);
    const { data } = await db.from("manakh_obs").select("device,media_path").eq("id", id).single();
    if (!data || data.device !== dev) return json({ error: "تقدر تحذف رصدك انت بس" }, 403);
    if (data.media_path) await db.storage.from(BUCKET).remove([data.media_path]);
    await db.from("manakh_obs").delete().eq("id", id);
    return json({ ok: true });
  }
  return json({ error: "unknown action" }, 400);
});
