// Checks the announcer's credentials before they go on Railway. Publishes NOTHING in public:
// the only message it sends goes to TELEGRAM_TEST_CHAT_ID. X is only asked who the token belongs to.
//
//   npx tsx --env-file=<file with the variables> scripts/check-announcer.ts
//
// Exit: 0 everything verified · 1 something is wrong (the line says what) · 2 could not check (network).
import { oauthHeader, xCredsFromEnv } from "../src/announcer/x.js";

const EXPECTED_X_USER = "jevsaidit";
let wrong = 0;
let unknown = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => (wrong++, console.log(`  FAIL ${m}`));
const unk = (m: string) => (unknown++, console.log(`  ???  ${m}`));

async function call<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T; level: string | null } | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as T, level: res.headers.get("x-access-level") };
  } catch (e) {
    unk(`${new URL(url).host}: no answer (${(e as Error).name})`);
    return null;
  }
}

type Tg<T> = { ok: boolean; result?: T; description?: string };

async function telegram() {
  console.log("telegram");
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return bad("TELEGRAM_BOT_TOKEN missing");
  const api = (m: string) => `https://api.telegram.org/bot${token}/${m}`;

  const me = await call<Tg<{ id: number; username: string }>>(api("getMe"));
  if (!me) return;
  if (!me.body.ok) return bad(`getMe: ${me.body.description ?? me.status}`);
  const botId = me.body.result!.id;
  ok(`bot @${me.body.result!.username}`);

  const channel = process.env.TELEGRAM_CHANNEL_ID?.trim();
  const test = process.env.TELEGRAM_TEST_CHAT_ID?.trim();
  if (!channel || !test) {
    // The ids are not visible in the apps: they come from the updates the bot has received.
    const up = await call<Tg<Array<Record<string, { chat?: { id: number; type: string; title?: string; username?: string } }>>>>(api("getUpdates"));
    const chats = new Map<number, string>();
    for (const u of up?.body.result ?? [])
      for (const v of Object.values(u)) if (v && typeof v === "object" && v.chat) chats.set(v.chat.id, `${v.chat.type} ${v.chat.title ?? v.chat.username ?? ""}`);
    if (chats.size === 0) console.log("  hint no chats seen yet: write /start to the bot and post once in the channel, then rerun");
    for (const [id, what] of chats) console.log(`  seen ${id}  ${what}`);
  }

  if (!channel) bad("TELEGRAM_CHANNEL_ID missing (needed for live)");
  else {
    const m = await call<Tg<{ status: string; can_post_messages?: boolean }>>(api(`getChatMember?chat_id=${encodeURIComponent(channel)}&user_id=${botId}`));
    if (m && !m.body.ok) bad(`channel ${channel}: ${m.body.description}`);
    else if (m) {
      const r = m.body.result!;
      if (r.status === "administrator" && r.can_post_messages) ok(`channel ${channel}: bot is admin and can post`);
      else bad(`channel ${channel}: bot is "${r.status}"${r.status === "administrator" ? " without the right to post" : ""}`);
    }
  }

  if (!test) bad("TELEGRAM_TEST_CHAT_ID missing (needed for test mode)");
  else {
    const s = await call<Tg<unknown>>(api("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: test, text: "announcer check: this chat receives ANNOUNCE_MODE=test" }),
    });
    if (s && !s.body.ok) bad(`test chat ${test}: ${s.body.description}`);
    else if (s) ok(`test chat ${test}: message delivered`);
  }
}

async function x() {
  console.log("x");
  let creds;
  try {
    creds = xCredsFromEnv(process.env);
  } catch (e) {
    return bad((e as Error).message);
  }
  if (!creds) return bad("no X variables: posts would be recorded as `unconfigured`");
  const url = "https://api.x.com/2/users/me";
  const r = await call<{ data?: { username?: string }; title?: string; detail?: string }>(url, {
    headers: { authorization: oauthHeader(creds, "GET", url), "user-agent": "jevsaidit-announcer/1" },
  });
  if (!r) return;
  if (r.status !== 200 || !r.body.data?.username) return bad(`users/me ${r.status}: ${r.body.detail ?? r.body.title ?? "no body"}`);
  const u = r.body.data.username;
  // A token of the wrong account would post as that account: the one check that matters most.
  if (u.toLowerCase() !== EXPECTED_X_USER) bad(`the access token belongs to @${u}, not @${EXPECTED_X_USER}`);
  else ok(`access token is @${u}`);
  // OAuth 1.0a answers carry the token's permission. "read" = generated before "Read and write" was
  // set: the first post would fail with 403. Regenerate the access token after changing the permission.
  const level = r.level;
  if (level === "read-write" || level === "read-write-directmessages") ok(`access level ${level}`);
  else if (level) bad(`access level "${level}": set Read and write in the app, then REGENERATE the access token`);
  else unk("access level not reported by X");
}

await telegram();
await x();
console.log(wrong ? `\n${wrong} to fix` : unknown ? "\nnot verified: network" : "\nall verified");
process.exit(wrong ? 1 : unknown ? 2 : 0);
