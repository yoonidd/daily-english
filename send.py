#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
매일 아침 8시(KST) IELTS 필사 지문을 텔레그램으로 발송.
GitHub Actions에서 실행되므로 PC 전원과 무관합니다.
"""

import json
import os
import sys
import time
import html
import urllib.request
import urllib.error
from datetime import date
from zoneinfo import ZoneInfo
from datetime import datetime

# ── 설정 ──────────────────────────────────────────────
START_DATE = date(2026, 9, 9)   # DAY 1을 소진한 날. 9/10 → DAY 2 부터 시작
KST = ZoneInfo("Asia/Seoul")
TG_LIMIT = 3800                 # 텔레그램 4096자 제한에 여유를 둔 값

BOT_TOKEN = os.environ.get("BOT_TOKEN", "").strip()
CHAT_ID = os.environ.get("CHAT_ID", "").strip()

if not BOT_TOKEN or ":" not in BOT_TOKEN:
    sys.exit("ERROR: BOT_TOKEN 시크릿이 없거나 형식이 잘못되었습니다.")
if not CHAT_ID:
    sys.exit("ERROR: CHAT_ID 시크릿이 없습니다.")

API = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"


def esc(s):
    return html.escape(str(s or ""), quote=False)


def send(text):
    payload = json.dumps({
        "chat_id": CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }).encode("utf-8")
    req = urllib.request.Request(
        API, data=payload,
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        sys.exit(f"ERROR: 텔레그램 발송 실패 (HTTP {e.code}) — {detail}")
    except Exception as e:
        sys.exit(f"ERROR: 텔레그램 연결 실패 — {e}")
    if not body.get("ok"):
        sys.exit(f"ERROR: 텔레그램이 ok=false 를 반환했습니다 — {body}")


def split_long(text, limit=TG_LIMIT):
    if len(text) <= limit:
        return [text]
    parts, cur = [], ""
    for line in text.split("\n"):
        if len(cur) + len(line) + 1 > limit:
            parts.append(cur)
            cur = ""
        cur += line + "\n"
    if cur.strip():
        parts.append(cur)
    return parts


def main():
    with open("lessons.json", encoding="utf-8-sig") as f:
        lessons = json.load(f)

    today = datetime.now(KST).date()
    idx = (today - START_DATE).days % len(lessons)
    L = lessons[idx]
    day_no = idx + 1

    # ── 메시지 1: 필사 지문 ──
    m1 = "\n".join([
        f"<b>DAY {day_no} · 오늘의 필사</b>",
        f"<i>{esc(L['topic'])}</i>",
        "",
        f"<b>{esc(L['title'])}</b>",
        "",
        esc(L["passage"]),
        "",
        "──────────",
        "✍️ <b>15분</b>: 위 지문을 손으로 그대로 옮겨 쓰세요. "
        "한 문장을 통째로 읽고, 눈을 떼고, 기억해서 쓰는 방식으로.",
    ])

    # ── 메시지 2: 어휘 + 문법 ──
    lines = [f"<b>DAY {day_no} · 어휘 &amp; 문법</b>", "", "<b>■ 핵심 어휘</b>"]
    for i, v in enumerate(L["vocab"], 1):
        lines.append(f"{i}. <b>{esc(v['w'])}</b> — {esc(v['kr'])}")
        lines.append(f"   <i>{esc(v['ex'])}</i>")
    g = L["grammar"]
    lines += [
        "",
        f"<b>■ 오늘의 문법: {esc(g['point'])}</b>",
        esc(g["explain"]),
        "",
        "<b>연습</b> (빈칸을 채워 소리 내어 말해보세요)",
    ]
    for i, d in enumerate(g["drills"], 1):
        lines.append(f"{i}) {esc(d)}")
    lines += ["", "──────────",
              "✍️ <b>10분</b>: 어휘는 예문째로 옮겨 쓰고, 연습문장은 입으로 3번씩."]
    m2 = "\n".join(lines)

    # ── 메시지 3: 회화 전환 + 번역 ──
    lines = [f"<b>DAY {day_no} · 회화로 바꿔 말하기</b>", ""]
    for i, s in enumerate(L["speaking"], 1):
        lines.append(f"{i}. {esc(s)}")
    lines += [
        "",
        "<b>■ 한국어 대조 번역</b>",
        f"<blockquote>{esc(L['translation'])}</blockquote>",
        "",
        "──────────",
        "🗣️ <b>5분</b>: 위 5문장을 실제 대화하듯 소리 내어. 내일 또 만나요!",
    ]
    m3 = "\n".join(lines)

    sent = 0
    for msg in (m1, m2, m3):
        for chunk in split_long(msg):
            send(chunk)
            sent += 1
            time.sleep(0.7)

    print(f"OK: {today} — DAY {day_no} 발송 완료 (메시지 {sent}개) — {L['title']}")


if __name__ == "__main__":
    main()
