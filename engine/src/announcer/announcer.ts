import type { Db } from "../db/db.js";
import type { Channel, Sender } from "./channels.js";
import { collectEvents } from "./events.js";
import { guard, render } from "./soul.js";

const MAX_ATTEMPTS = 3;

type Collected = Awaited<ReturnType<typeof collectEvents>>;

/** `events` overrides the collection: `announce-pin` posts the pinned explainer and nothing else. */
export async function announce(db: Db, sender: Sender, o: { site: string; xDailyCap: number; now: number; events?: Collected }) {
  const report = { sent: 0, skipped: 0, failed: 0, refused: 0, capped: 0 };
  for (const { event, channels } of o.events ?? (await collectEvents(db, o.now))) {
    const r = render(event, o.site);
    for (const channel of channels as Channel[]) {
      const text = channel === "x" ? r.x : r.telegram;
      if (!text) continue;
      const prev = (await db.query<{ status: string; attempts: number }>("SELECT status, attempts FROM announcements WHERE event_key = $1 AND channel = $2", [event.key, channel])).rows[0];
      if (prev && (prev.status !== "failed" || prev.attempts >= MAX_ATTEMPTS)) {
        report.skipped++;
        continue;
      }
      const g = guard(text, r.fmt);
      if (!g.ok) {
        await db.query("INSERT INTO announcements (event_key, channel, status, text, error) VALUES ($1,$2,'refused',$3,$4) ON CONFLICT DO NOTHING", [event.key, channel, text, g.reason]);
        report.refused++;
        continue;
      }
      if (channel === "x") {
        const today = await db.query<{ n: string }>("SELECT count(*) n FROM announcements WHERE channel = 'x' AND status = 'sent' AND sent_at >= date_trunc('day', now() AT TIME ZONE 'utc')");
        if (Number(today.rows[0]!.n) >= o.xDailyCap) {
          await db.query("INSERT INTO announcements (event_key, channel, status, text) VALUES ($1,'x','capped',$2) ON CONFLICT DO NOTHING", [event.key, text]);
          report.capped++;
          continue;
        }
      }
      // written BEFORE sending: a crash after the send cannot produce a second post
      await db.query(
        `INSERT INTO announcements (event_key, channel, status, text, attempts) VALUES ($1,$2,'pending',$3,1)
         ON CONFLICT (event_key, channel) DO UPDATE SET status = 'pending', attempts = announcements.attempts + 1`,
        [event.key, channel, text],
      );
      try {
        await sender.send(channel, text);
        await db.query("UPDATE announcements SET status = 'sent', sent_at = now(), error = NULL WHERE event_key = $1 AND channel = $2", [event.key, channel]);
        report.sent++;
      } catch (err) {
        await db.query("UPDATE announcements SET status = 'failed', error = $3 WHERE event_key = $1 AND channel = $2", [event.key, channel, (err as Error).message.slice(0, 300)]);
        report.failed++;
      }
    }
  }
  return report;
}
