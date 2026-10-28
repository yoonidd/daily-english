// ============================================================
//  Daily English — Cloudflare Worker
//  평일 08:00 KST, 텔레그램으로 IELTS 필사 자료 4통 + 음성 2통 발송
//
//  필요한 설정 (Settings → Variables and Secrets)
//    BOT_TOKEN : @BotFather 토큰
//    CHAT_ID   : 텔레그램 chat id
//    RUN_KEY   : 아무 단어나 (지금 바로 받기 URL의 암호)
//  바인딩 (Settings → Bindings)
//    AI        : Workers AI 바인딩. 지문·회화문장 음성(TTS)을 만듭니다.
//                없으면 음성 없이 글만 나갑니다 (고장 아님).
//    STATE     : KV 네임스페이스(선택). 같은 날 중복 발송을 막습니다.
//  Cron Trigger
//    0 23 * * *     ← 한국시간 매일 08:00 (UTC 23:00)
//                     주말 제외는 코드가 처리합니다. 크론에 요일을 넣지 마세요.
// ============================================================

const ACADEMIC_URL =
  "https://raw.githubusercontent.com/yoonidd/daily-english/main/lessons.json";
const GENERAL_URL =
  "https://raw.githubusercontent.com/yoonidd/daily-english/main/general.json";

// ── 진도 기준 ────────────────────────────────────────
// 평일만 셉니다. 주말을 건너뛰어도 번호가 밀리지 않습니다.
// 기준일 다음 평일부터 GENERAL → ACADEMIC → GENERAL … 순으로 하루씩 번갈아 갑니다.
//   2026-09-22(화) = GENERAL 1,  09-23(수) = ACADEMIC 8,  09-24(목) = GENERAL 2 …
const START_UTC = Date.UTC(2026, 8, 21);
// 이미 보낸 ACADEMIC 편수. 이어서 8편부터 나갑니다.
const ACADEMIC_DONE = 7;
const KST_OFFSET = 9 * 60 * 60 * 1000;
const TG_LIMIT = 3800;

// ── 음성(TTS) 설정 ───────────────────────────────────
// 화자를 바꾸려면 TTS_SPEAKER 한 줄만 고치면 됩니다.
//   여성: asteria(차분·미국) luna(밝음) athena hera amalthea
//   남성: orion(낮고 느림) apollo hermes andromeda
const TTS_MODEL = "@cf/deepgram/aura-2-en";
const TTS_SPEAKER = "asteria";
const TTS_CHUNK = 1800; // 한 번에 보낼 글자 수. 지문은 보통 한 덩어리로 끝납니다.

export default {
  async scheduled(event, env, ctx) {
    // 주말(토·일)에는 보내지 않는다. 크론은 매일 돌지만 여기서 걸러낸다.
    const dow = new Date(Date.now() + KST_OFFSET).getUTCDay();
    if (dow === 0 || dow === 6) {
      console.log(`SKIP: ${kstToday().iso} 는 주말입니다.`);
      return;
    }
    ctx.waitUntil(
      sendToday(env).then((r) => console.log(r))
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      const key = clean(env.RUN_KEY);
      if (!key || clean(url.searchParams.get("key")) !== key) {
        return plain("키가 올바르지 않습니다.", 401);
      }
      return plain(await sendToday(env, true));
    }
    return plain("Daily English worker — 정상 동작 중");
  },
};

// ── 유틸 ────────────────────────────────────────────────
function plain(body, status = 200) {
  return new Response(body + "\n", {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 설정값에 딸려 들어온 공백·따옴표·줄바꿈을 제거한다.
// (실제로 RUN_KEY 끝의 공백 하나 때문에 발송이 멈춘 적 있음)
const clean = (v) => String(v ?? "").trim().replace(/^["']|["']$/g, "");

function kstToday() {
  const d = new Date(Date.now() + KST_OFFSET);
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  return {
    iso: `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    midnight: Date.UTC(y, m, day),
  };
}

// 기준일 다음 날부터 대상일까지의 평일(월~금) 수
function weekdaysAfter(startUTC, endUTC) {
  let count = 0;
  for (let t = startUTC + 86400000; t <= endUTC; t += 86400000) {
    const dow = new Date(t).getUTCDay();
    if (dow >= 1 && dow <= 5) count++;
  }
  return count;
}

function splitLong(text, limit = TG_LIMIT) {
  if (text.length <= limit) return [text];
  const parts = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur.length + line.length + 1 > limit) { parts.push(cur); cur = ""; }
    cur += line + "\n";
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

async function telegram(token, chatId, text) {
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    return { ok: false, detail: `연결 실패 — ${e}` };
  }
  const body = await res.json().catch(() => ({}));
  return body.ok
    ? { ok: true }
    : { ok: false, detail: `HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}` };
}

// ── 음성 만들기 ─────────────────────────────────────────
// Workers AI 응답은 ReadableStream / ArrayBuffer / base64 중 하나로 올 수 있다.
async function toBytes(out) {
  if (out instanceof Uint8Array) return out;
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  if (out && typeof out.getReader === "function")
    return new Uint8Array(await new Response(out).arrayBuffer());
  if (out && typeof out.arrayBuffer === "function")
    return new Uint8Array(await out.arrayBuffer());
  if (out && typeof out.audio === "string") {
    const bin = atob(out.audio);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  throw new Error("TTS 응답 형식을 알 수 없습니다");
}

// 문장 경계에서만 자른다. 단어 중간에서 끊기면 음성이 어색해진다.
function ttsChunks(text, limit = TTS_CHUNK) {
  const out = [];
  let cur = "";
  for (const para of String(text).split(/\n{2,}/)) {
    for (const sent of para.trim().split(/(?<=[.!?"”])\s+/)) {
      if (!sent) continue;
      if (cur.length + sent.length + 1 > limit && cur.trim()) {
        out.push(cur.trim());
        cur = "";
      }
      cur += sent + " ";
    }
    cur += "\n";
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

async function synth(env, text) {
  const parts = [];
  for (const chunk of ttsChunks(text)) {
    const out = await env.AI.run(TTS_MODEL, {
      text: chunk,
      speaker: TTS_SPEAKER,
      encoding: "mp3",
    });
    parts.push(await toBytes(out));
  }
  if (parts.length === 1) return parts[0];
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { merged.set(p, off); off += p.byteLength; }
  return merged;
}

// 음성 메시지(sendVoice)로 보내면 텔레그램에서 ×1.5 ×2 배속이 됩니다.
// 거부되면 일반 오디오(sendAudio)로 한 번 더 시도합니다.
async function telegramVoice(token, chatId, bytes, filename, caption) {
  let last = "";
  for (const method of ["sendVoice", "sendAudio"]) {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
    form.append(
      method === "sendVoice" ? "voice" : "audio",
      new Blob([bytes], { type: "audio/mpeg" }),
      filename
    );
    let res;
    try {
      res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        body: form,
      });
    } catch (e) {
      return { ok: false, detail: `연결 실패 — ${e}` };
    }
    const body = await res.json().catch(() => ({}));
    if (body.ok) return { ok: true };
    last = `HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`;
  }
  return { ok: false, detail: last };
}

// ── 메시지 조립 ─────────────────────────────────────────
function buildMessages(L, label) {
  // 1. 필사 지문
  const m1 = [
    `<b>${label} · 오늘의 필사</b>`,
    `<i>${esc(L.topic)}</i>`,
    "",
    `<b>${esc(L.title)}</b>`,
    "",
    esc(L.passage),
    "",
    "──────────",
    "✍️ <b>12분</b>: 위 지문을 손으로 그대로 옮겨 쓰세요. 한 문장을 통째로 읽고, 눈을 떼고, 기억해서 쓰는 방식으로.",
  ].join("\n");

  // 2. 문장 해체
  let lines = [
    `<b>${label} · 문장 해체</b>`,
    "",
    "<i>오늘 지문에서 구조가 가장 까다로운 두 문장입니다. 단어가 아니라 뼈대를 보는 훈련입니다.</i>",
  ];
  L.parse.forEach((p, i) => {
    lines.push("", "──────────", `<b>[${i + 1}] 왜 어려운가</b>`, esc(p.why), "", `<i>${esc(p.s)}</i>`, "");
    for (const step of p.steps) lines.push(esc(step));
    lines.push("", `▶ <b>해석</b>  ${esc(p.read)}`);
  });
  lines.push("", "──────────",
    "🔍 <b>8분</b>: ①번 단계를 스스로 먼저 해보고 나머지를 확인하세요. 본동사만 찾을 수 있으면 나머지는 다 붙는 것들입니다.");
  const m2 = lines.join("\n");

  // 3. 어휘 + 문법
  lines = [`<b>${label} · 어휘 &amp; 문법</b>`, "", "<b>■ 핵심 어휘</b>"];
  L.vocab.forEach((v, i) => {
    lines.push(`${i + 1}. <b>${esc(v.w)}</b> — ${esc(v.kr)}`);
    lines.push(`   <i>${esc(v.ex)}</i>`);
  });
  lines.push("", `<b>■ 오늘의 문법: ${esc(L.grammar.point)}</b>`, esc(L.grammar.explain),
    "", "<b>연습</b> (빈칸을 채워 소리 내어 말해보세요)");
  L.grammar.drills.forEach((d, i) => lines.push(`${i + 1}) ${esc(d)}`));
  lines.push("", "──────────", "✍️ <b>10분</b>: 어휘는 예문째로 옮겨 쓰고, 연습문장은 입으로 3번씩.");
  const m3 = lines.join("\n");

  // 4. 회화 전환 + 번역
  lines = [`<b>${label} · 회화로 바꿔 말하기</b>`, ""];
  L.speaking.forEach((s, i) => lines.push(`${i + 1}. ${esc(s)}`));
  lines.push("", "<b>■ 한국어 대조 번역</b>", `<blockquote>${esc(L.translation)}</blockquote>`,
    "", "──────────", "🗣️ <b>5분</b>: 위 5문장을 실제 대화하듯 소리 내어. 내일 또 만나요!");
  const m4 = lines.join("\n");

  return [m1, m2, m3, m4];
}

// 글 4통 사이에 음성 2통을 끼워 넣는다.
function buildItems(L, label) {
  const [m1, m2, m3, m4] = buildMessages(L, label);
  return [
    { kind: "text", body: m1 },
    {
      kind: "voice",
      text: L.passage,
      file: "passage.mp3",
      caption:
        `🔊 <b>${label} · 지문 낭독</b>\n` +
        "먼저 한 번은 글을 보지 말고 귀로만 들으세요. 필사가 끝난 뒤 다시 틀어 소리 내어 따라 읽으면 그 문장이 입으로 넘어옵니다.\n" +
        "<i>재생 중 오른쪽 ×1 을 눌러 ×1.5 ×2 로 바꿀 수 있습니다.</i>",
    },
    { kind: "text", body: m2 },
    { kind: "text", body: m3 },
    { kind: "text", body: m4 },
    {
      kind: "voice",
      text: L.speaking.join("\n\n"),
      file: "speaking.mp3",
      caption:
        `🔊 <b>${label} · 회화 5문장</b>\n` +
        "한 문장 듣고 멈추고 따라 말하기. 억양까지 흉내 내세요.",
    },
  ];
}

// ── 본체 ────────────────────────────────────────────────
async function sendToday(env, force = false) {
  const token = clean(env.BOT_TOKEN);
  const chatId = clean(env.CHAT_ID);
  if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token))
    return "ERROR: BOT_TOKEN 이 없거나 형식이 잘못되었습니다 (공백·따옴표가 섞이지 않았는지 확인하세요).";
  if (!/^-?\d+$/.test(chatId))
    return "ERROR: CHAT_ID 가 숫자가 아닙니다 (공백이 섞이지 않았는지 확인하세요).";

  let academic, general;
  try {
    const [a, g] = await Promise.all([
      fetch(ACADEMIC_URL, { cf: { cacheTtl: 300 } }),
      fetch(GENERAL_URL, { cf: { cacheTtl: 300 } }),
    ]);
    if (!a.ok) return `ERROR: lessons.json 을 가져오지 못했습니다 (HTTP ${a.status}). 저장소가 공개인지 확인하세요.`;
    if (!g.ok) return `ERROR: general.json 을 가져오지 못했습니다 (HTTP ${g.status}). 저장소에 올렸는지 확인하세요.`;
    academic = await a.json();
    general = await g.json();
  } catch (e) {
    return `ERROR: 지문 파일 로드 실패 — ${e}`;
  }
  if (!Array.isArray(academic) || academic.length === 0)
    return "ERROR: lessons.json 내용이 비어 있습니다.";
  if (!Array.isArray(general) || general.length === 0)
    return "ERROR: general.json 내용이 비어 있습니다.";

  const { iso, midnight } = kstToday();

  // 같은 날 이미 보냈으면 건너뛴다 (예비 크론이 중복 발송하지 않도록)
  if (env.STATE && !force) {
    const last = await env.STATE.get("last_sent").catch(() => null);
    if (last === iso) return `SKIP: ${iso} 분량은 이미 발송되었습니다.`;
  }

  // 기준일 이후 몇 번째 평일인가 (1부터). 홀수 = GENERAL, 짝수 = ACADEMIC
  const k = Math.max(1, weekdaysAfter(START_UTC, midnight));
  let L, label;
  if (k % 2 === 1) {
    const i = Math.floor((k - 1) / 2) % general.length;
    L = general[i];
    label = `GENERAL DAY ${i + 1}`;
  } else {
    const i = (ACADEMIC_DONE + k / 2 - 1) % academic.length;
    L = academic[i];
    label = `ACADEMIC DAY ${i + 1}`;
  }
  const dow = new Date(midnight).getUTCDay();
  const weekendNote = dow === 0 || dow === 6 ? " (주말 수동 발송)" : "";

  let sent = 0;
  let voiceSent = 0;
  const voiceNotes = [];

  for (const item of buildItems(L, label)) {
    if (item.kind === "text") {
      for (const chunk of splitLong(item.body)) {
        const r = await telegram(token, chatId, chunk);
        if (!r.ok) return `ERROR: 발송 실패 (${label}, ${sent}통 전송 후) — ${r.detail}`;
        sent++;
        await sleep(700);
      }
      continue;
    }

    // 음성은 실패해도 글 발송을 멈추지 않는다.
    if (!env.AI) {
      if (!voiceNotes.length) voiceNotes.push("AI 바인딩이 없어 음성은 생략");
      continue;
    }
    try {
      const bytes = await synth(env, item.text);
      const r = await telegramVoice(token, chatId, bytes, item.file, item.caption);
      if (r.ok) { voiceSent++; sent++; }
      else voiceNotes.push(`${item.file} 전송 실패 — ${r.detail}`);
      await sleep(700);
    } catch (e) {
      voiceNotes.push(`${item.file} 음성 생성 실패 — ${e}`);
    }
  }

  if (env.STATE) {
    await env.STATE.put("last_sent", iso, { expirationTtl: 172800 }).catch(() => {});
  }
  const voiceTail = voiceNotes.length ? ` | 음성: ${voiceNotes.join(" ; ")}` : "";
  return `OK: ${iso}${weekendNote} — ${label} 발송 완료 (글 ${sent - voiceSent}통, 음성 ${voiceSent}통) — ${L.title}${voiceTail}`;
}
