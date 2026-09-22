import type { Db } from "../db/db.js";
import { DeliveryUnknownError, type Channel, type Sender } from "./channels.js";
import { collectEvents } from "./events.js";
import { guard, render, type AnnounceEvent } from "./soul.js";

const MAX_ATTEMPTS = 3;

type Collected = Awaited<ReturnType<typeof collectEvents>>;
type Kind = AnnounceEvent["kind"];

/** The X day has a fixed cap and the sources have different weights. A cap that is first come,
 *  first served lets the weakest source (a batch opening at 06:00) spend the slots the strongest one
 *  (the epoch's verdict, at 18:00) will want, and the two never compete. So the strong kinds hold
 *  reserved slots: a weaker post goes out only if what is still owed to the stronger kinds fits. */
const STRENGTH: Kind[] = ["epoch_settled", "swap", "outcome", "batch_opened", "closing_soon", "claims_open", "pin"];
export const X_RESERVED: Partial<Record<Kind, number>> = { epoch_settled: 2, swap: 1 };

export function xAllowed(kind: Kind, sentToday: Partial<Record<Kind, number>>, cap: number): boolean {
  const total = Object.values(sentToday).reduce((a, b) => a + (b ?? 0), 0);
  if (total >= cap) return false;
  let owed = 0;
  for (const k of STRENGTH) {
    if (k === kind) break;
    owed += Math.max(0, (X_RESERVED[k] ?? 0) - (sentToday[k] ?? 0));
  }
  return total + owed < cap;
}

const KEY_KIND: Record<string, Kind> = { open: "batch_opened", closing: "closing_soon", outcome: "outcome", settled: "epoch_settled", claims: "claims_open", swap: "swap", pin: "pin" };
export const kindOfKey = (key: string): Kind | undefined => KEY_KIND[key.split(":")[0]!];

/** `events` overrides the collection: `announce-pin` posts the pinned explainer and nothing else. */
export async function announce(db: Db, sender: Sender, o: { site: string; xDailyCap: number; now: number; events?: Collected }) {
  const report = { sent: 0, skipped: 0, failed: 0, refused: 0, capped: 0, unconfigured: 0 };
  for (const { event, channels } of o.events ?? (await collectEvents(db, o.now))) {
    const r = render(event, o.site);
    for (const channel of channels as Channel[]) {
      const text = channel === "x" ? r.x : r.telegram;
      if (!text) continue;
      const prev = (await db.query<{ status: string; attempts: number }>("SELECT status, attempts FROM announcements WHERE event_key = $1 AND channel = $2", [event.key, channel])).rows[0];
      // "capped" is not a verdict on the post, it is a verdict on the day: it may fit later, so it is
      // reconsidered on the next cycles (the collector drops it once it is no longer worth posting).
      const retryable = prev?.status === "failed" ? prev.attempts < MAX_ATTEMPTS : prev?.status === "capped";
      if (prev && !retryable) {
        report.skipped++;
        continue;
      }
      if (!sender.has(channel)) {
        // Recorded, so that the day the channel gets its keys it does not post two days of backlog.
        await db.query("INSERT INTO announcements (event_key, channel, status, text, error) VALUES ($1,$2,'unconfigured',$3,'channel not configured') ON CONFLICT DO NOTHING", [event.key, channel, text]);
        report.unconfigured++;
        continue;
      }
      const g = guard(text, r.fmt);
      if (!g.ok) {
        await db.query("INSERT INTO announcements (event_key, channel, status, text, error) VALUES ($1,$2,'refused',$3,$4) ON CONFLICT DO NOTHING", [event.key, channel, text, g.reason]);
        report.refused++;
        continue;
      }
      if (channel === "x") {
        const today = (await db.query<{ event_key: string }>("SELECT event_key FROM announcements WHERE channel = 'x' AND status = 'sent' AND sent_at >= date_trunc('day', now() AT TIME ZONE 'utc')")).rows;
        const byKind: Partial<Record<Kind, number>> = {};
        for (const t of today) {
          const k = kindOfKey(t.event_key);
          if (k) byKind[k] = (byKind[k] ?? 0) + 1;
        }
        if (!xAllowed(event.kind, byKind, o.xDailyCap)) {
          // The text is kept: a limit that does not say what it withheld hides its own cost.
          await db.query("INSERT INTO announcements (event_key, channel, status, text, error) VALUES ($1,'x','capped',$2,$3) ON CONFLICT DO NOTHING", [event.key, text, `x cap ${o.xDailyCap}/day, ${today.length} sent today`]);
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
        // No answer is not "not delivered": a retry could post twice. Recorded as unknown, never retried.
        const status = err instanceof DeliveryUnknownError ? "unknown" : "failed";
        await db.query("UPDATE announcements SET status = $3, error = $4 WHERE event_key = $1 AND channel = $2", [event.key, channel, status, (err as Error).message.slice(0, 300)]);
        report.failed++;
      }
    }
  }
  return report;
}
