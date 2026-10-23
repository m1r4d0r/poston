// poston 서버 — 교실 프로그램과 폰 답장 페이지가 함께 쓰는 창구
//
// 환경 변수
//   CLASS_KEY            교실 프로그램(poston.json)에 들어 있는 열쇠
//   ADMIN_PASSWORD       폰 답장 페이지 비밀번호 — 직접 정한다
//   DISCORD_WEBHOOK_URL  교실에서 메시지가 오면 알릴 디스코드 웹훅
//
// 저장 방식 (Netlify Blobs, 저장소 이름 poston)
//   m/<13자리 밀리초>-<보낸 쪽>-<임의 4자>  메시지 하나. 사전순이 곧 시간순이라 동시에 보내도 덮어쓰지 않는다.
//   img/<메시지 키에서 m/를 뗀 부분>          메시지에 붙은 사진(JPEG)
//   presence/class                         교실 프로그램이 마지막으로 연락한 시각(밀리초)
//   meta/epoch                             마지막으로 대화를 모두 지운 시각(밀리초)
//   meta/cleared                           마지막으로 교실 화면을 비운 시각(밀리초). 메시지는 남는다.
//   memo                                   바탕화면 메모 { text, align, size, visible, updatedAt }
//
// 교실 화면에는 "오늘(한국 시간) 0시"와 "화면을 비운 시각" 중 늦은 때 이후 메시지만 내준다.
// 교실이 받는 epoch는 그 시작 시각과 모두 지운 시각 중 큰 값이라, 자정이나 화면 비우기 때도 바뀌어
// 프로그램이 목록을 새로 받는다. 지난 메시지는 ?days, ?day 로 날짜별로 꺼내 본다.
// 메시지는 KEEP_DAYS 일이 지나면 서버에서 지운다.
//
// 요청
//   GET    ?since=&epoch=&ping=1   새 메시지 + 메모 (+ 폰에는 교실 접속 시각)
//   GET    ?img=<메시지 키>          사진 원본
//   GET    ?days=1                  기록이 있는 날짜 목록 { days: [{ date: "YYYY-MM-DD", count }] } 최근 날짜부터
//   GET    ?day=YYYY-MM-DD          그날(한국 시간) 메시지 모두 { date, messages }
//   POST   { text, image }          메시지 보내기. image는 JPEG data URL
//   POST   { memo: {...} }          메모 고치기 (양쪽 모두)
//   POST   { clear: true }          교실 화면 비우기. 기록은 남는다 (양쪽 모두)
//   DELETE                         대화 기록 모두 지우기 (폰만)

import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";

const MAX_TEXT = 2000;
const MAX_MEMO = 2000;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const RECENT = 300;
const KEEP_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const KST_MS = 9 * 60 * 60 * 1000;
const ALIGNS = ["left", "center", "right"];
const DEFAULT_MEMO = { text: "", align: "left", size: 28, visible: true, updatedAt: 0 };

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function same(given, expected) {
  if (!given || !expected) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function roleOf(req) {
  const key = req.headers.get("x-poston-key") || "";
  if (same(key, process.env.CLASS_KEY)) return "class";
  if (same(key, process.env.ADMIN_PASSWORD)) return "home";
  return null;
}

const openStore = () => getStore({ name: "poston", consistency: "strong" });

function newKey(from) {
  const t = String(Date.now()).padStart(13, "0");
  const r = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `m/${t}-${from}-${r}`;
}

const imageKey = (id) => "img/" + id.slice(2);
const keyAt = (ms) => "m/" + String(ms).padStart(13, "0");
const timeOfKey = (k) => Number(k.slice(2, 15));
const kstDayStart = (ms) => Math.floor((ms + KST_MS) / DAY_MS) * DAY_MS - KST_MS;
const kstDate = (ms) => new Date(ms + KST_MS).toISOString().slice(0, 10);

async function messageKeys(store) {
  const { blobs } = await store.list({ prefix: "m/" });
  return blobs.map((b) => b.key).sort();
}

// 키의 13자리 시각 중 앞 5자리가 같으면 약 28시간 안에 쓰인 메시지다.
// 그 묶음 단위로 필요한 구간만 훑어서, 기록이 쌓여도 4초마다 오는 확인 요청이 가볍게 한다.
const BUCKET = 1e8;
async function keysBetween(store, fromMs, toMs) {
  const prefixes = [];
  for (let b = Math.floor(fromMs / BUCKET); b <= Math.floor(toMs / BUCKET); b++) {
    prefixes.push("m/" + String(b).padStart(5, "0"));
  }
  const lists = await Promise.all(prefixes.map((prefix) => store.list({ prefix })));
  const lo = keyAt(fromMs);
  return lists
    .flatMap((l) => l.blobs.map((b) => b.key))
    .filter((k) => k >= lo)
    .sort();
}

// 서버마다 시계가 조금씩 달라도 방금 쓰인 메시지를 놓치지 않도록 끝을 넉넉히 잡는다.
const keysSince = (store, fromMs) => keysBetween(store, fromMs, Date.now() + 60_000);

async function classView(store) {
  const [deleted, cleared] = await Promise.all([store.get("meta/epoch"), store.get("meta/cleared")]);
  const start = Math.max(Number(cleared) || 0, kstDayStart(Date.now()));
  return { start, epoch: String(Math.max(Number(deleted) || 0, start)) };
}

async function readMessages(store, keys) {
  const items = await Promise.all(keys.map((k) => store.get(k, { type: "json" })));
  return items.map((m, i) => (m ? { id: keys[i], ...m } : null)).filter(Boolean);
}

async function readMemo(store) {
  return { ...DEFAULT_MEMO, ...((await store.get("memo", { type: "json" })) || {}) };
}

function decodeJpeg(dataUrl) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  if (!m) return null;
  const bytes = Buffer.from(m[1], "base64");
  const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return isJpeg ? bytes : null;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

async function notifyDiscord(siteUrl, text, jpeg) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return false;
  const lead = text ? `**교실** ${clip(text, 1700)}` : "**교실** 화면 캡처를 보냈습니다.";
  const payload = {
    username: "poston",
    content: `${lead}\n답장하기 <${siteUrl}/>`,
    allowed_mentions: { parse: [] },
  };
  let init;
  if (jpeg) {
    const form = new FormData();
    form.append("payload_json", JSON.stringify(payload));
    form.append("files[0]", new Blob([jpeg], { type: "image/jpeg" }), "capture.jpg");
    init = { method: "POST", body: form };
  } else {
    init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
  }
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function deleteMessages(store, keys) {
  await Promise.all(keys.flatMap((k) => [store.delete(k), store.delete(imageKey(k))]));
}

async function handleGet(req, role, store) {
  const params = new URL(req.url).searchParams;

  const img = params.get("img");
  if (img) {
    if (!/^m\/\d{13}-(class|home)-[a-z0-9]{4}$/.test(img)) return json(400, { error: "bad-id" });
    const bytes = await store.get(imageKey(img), { type: "arrayBuffer" });
    if (!bytes) return json(404, { error: "no-image" });
    return new Response(bytes, {
      status: 200,
      headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" },
    });
  }

  if (params.get("days")) return json(200, { days: await dayList(store) });
  const day = params.get("day");
  if (day !== null) return dayMessages(store, day);

  const view = role === "class" ? await classView(store) : null;
  const epoch = view ? view.epoch : (await store.get("meta/epoch")) || "0";
  const clientEpoch = params.get("epoch");
  const reset = clientEpoch !== null && clientEpoch !== epoch;
  const since = reset ? "" : params.get("since") || "";

  let wanted;
  if (view) {
    wanted = (await keysSince(store, view.start)).filter((k) => k > since);
  } else if (/^m\/\d{13}-/.test(since)) {
    wanted = (await keysSince(store, timeOfKey(since))).filter((k) => k > since);
  } else {
    const all = await messageKeys(store);
    wanted = since ? all.filter((k) => k > since) : all.slice(-RECENT);
  }
  const [messages, memo] = await Promise.all([readMessages(store, wanted), readMemo(store)]);

  const out = { role, epoch, reset, messages, memo };
  if (role === "class" && params.get("ping") === "1") {
    await store.set("presence/class", String(Date.now()));
  }
  if (role === "home") {
    out.classSeen = Number((await store.get("presence/class")) || 0);
  }
  return json(200, out);
}

async function dayList(store) {
  const counts = new Map();
  for (const k of await messageKeys(store)) {
    const date = kstDate(timeOfKey(k));
    counts.set(date, (counts.get(date) || 0) + 1);
  }
  return [...counts].map(([date, count]) => ({ date, count })).reverse();
}

async function dayMessages(store, date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return json(400, { error: "bad-day" });
  const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - KST_MS;
  if (kstDate(start) !== date) return json(400, { error: "bad-day" });
  const end = keyAt(start + DAY_MS);
  const keys = (await keysBetween(store, start, start + DAY_MS - 1)).filter((k) => k < end);
  return json(200, { date, messages: await readMessages(store, keys) });
}

async function clearClassView(store) {
  await store.set("meta/cleared", String(Date.now()));
  const { epoch } = await classView(store);
  return json(200, { ok: true, epoch });
}

async function saveMemo(store, input) {
  const memo = await readMemo(store);
  if (input.text !== undefined) {
    if (typeof input.text !== "string") return json(400, { error: "bad-memo" });
    const text = input.text.replace(/\r\n/g, "\n");
    if (text.length > MAX_MEMO) return json(413, { error: "too-long", max: MAX_MEMO });
    memo.text = text;
  }
  if (input.align !== undefined) {
    if (!ALIGNS.includes(input.align)) return json(400, { error: "bad-memo" });
    memo.align = input.align;
  }
  if (input.size !== undefined) {
    if (!Number.isFinite(input.size)) return json(400, { error: "bad-memo" });
    memo.size = Math.min(80, Math.max(14, Math.round(input.size)));
  }
  if (input.visible !== undefined) {
    if (typeof input.visible !== "boolean") return json(400, { error: "bad-memo" });
    memo.visible = input.visible;
  }
  memo.updatedAt = Date.now();
  await store.setJSON("memo", memo);
  return json(200, { ok: true, memo });
}

async function handlePost(req, role, store) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "bad-json" });
  }
  if (body && typeof body.memo === "object" && body.memo !== null) return saveMemo(store, body.memo);
  if (body?.clear === true) return clearClassView(store);

  const text = typeof body?.text === "string" ? body.text.replace(/\r\n/g, "\n").trim() : "";
  let jpeg = null;
  if (body?.image) {
    jpeg = decodeJpeg(body.image);
    if (!jpeg) return json(400, { error: "bad-image" });
    if (jpeg.length > MAX_IMAGE_BYTES) return json(413, { error: "image-too-big" });
  }
  if (!text && !jpeg) return json(400, { error: "empty" });
  if (text.length > MAX_TEXT) return json(413, { error: "too-long", max: MAX_TEXT });

  const id = newKey(role);
  const message = { from: role, text, at: new Date().toISOString() };
  if (jpeg) {
    message.image = true;
    await store.set(imageKey(id), jpeg);
  }
  await store.setJSON(id, message);

  const expired = keyAt(Date.now() - KEEP_DAYS * DAY_MS);
  const old = (await messageKeys(store)).filter((k) => k < expired);
  if (old.length) await deleteMessages(store, old);

  let notified = false;
  if (role === "class") {
    const siteUrl = process.env.URL || new URL(req.url).origin;
    notified = await notifyDiscord(siteUrl, text, jpeg);
  }
  return json(200, { ok: true, message: { id, ...message }, notified });
}

async function handleDelete(role, store) {
  if (role !== "home") return json(403, { error: "forbidden" });
  await deleteMessages(store, await messageKeys(store));
  const epoch = String(Date.now());
  await store.set("meta/epoch", epoch);
  return json(200, { ok: true, epoch });
}

export default async (req) => {
  const role = roleOf(req);
  if (!role) return json(401, { error: "bad-key" });
  const store = openStore();
  if (req.method === "GET") return handleGet(req, role, store);
  if (req.method === "POST") return handlePost(req, role, store);
  if (req.method === "DELETE") return handleDelete(role, store);
  return json(405, { error: "method" });
};

export const config = { path: "/api/chat" };
