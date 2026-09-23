import type { Db } from "../db/db.js";
import type { AnnounceEvent } from "./soul.js";

// B4, posts "from the dev" (23/09/2026): what shipped, read from the PUBLIC showcase commits (the sync
// script writes the feat/fix/perf subjects of the working repo into the commit body, so every claim links
// to the diff that proves it), and how many holders outside the team have played. Nothing here invents a
// fact: a line is either a commit subject anyone can open, or a count from the calls on-chain.

export const SHOWCASE = "jevsaidit/jev-said-it";
const MILESTONES = [1, 10, 25, 50, 100, 250];

/** The notable changes listed in a sync commit's body, without the type prefix or a trailing "(…)" note. */
export function devNotes(message: string): string[] {
  return message
    .split("\n")
    .map((l) => l.match(/^- (?:feat|fix|perf)(?:\([^)]*\))?: (.+)$/)?.[1])
    .filter((x): x is string => !!x)
    .map((s) => s.replace(/\s*\((?:[^()]*\d{1,2}\/\d{1,2}[^()]*)\)\s*$/, "").trim());
}

export function milestoneReached(callers: number): number | null {
  const hit = MILESTONES.filter((m) => callers >= m);
  return hit.length ? hit[hit.length - 1]! : null;
}

type Commit = { sha: string; message: string; at: number };
let cache: { at: number; commits: Commit[] } | null = null;
const REFETCH_SEC = 1800; // unauthenticated GitHub API: 60 requests an hour, the announcer runs every 15s

async function showcaseCommits(now: number, fetchImpl: typeof fetch): Promise<Commit[]> {
  if (cache && now - cache.at < REFETCH_SEC) return cache.commits;
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${SHOWCASE}/commits?per_page=10`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "jevsaidit-announcer/1" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`github ${r.status}`);
    const j = (await r.json()) as Array<{ sha: string; commit: { message: string; committer: { date: string } } }>;
    cache = { at: now, commits: j.map((c) => ({ sha: c.sha.slice(0, 7), message: c.commit.message, at: Date.parse(c.commit.committer.date) / 1000 })) };
  } catch {
    // Not reachable: nothing to say this cycle, and the last good answer is kept. A dev post is never urgent.
    cache = { at: now - REFETCH_SEC + 300, commits: cache?.commits ?? [] };
  }
  return cache.commits;
}

/** At most one dev_log candidate (the newest sync of the last 48h that shipped something) and one milestone. */
export async function collectDev(db: Db, now: number, excluded: string[] | null, fetchImpl: typeof fetch = fetch): Promise<AnnounceEvent[]> {
  const out: AnnounceEvent[] = [];
  const sync = (await showcaseCommits(now, fetchImpl)).find((c) => now - c.at < 48 * 3600 && devNotes(c.message).length > 0);
  if (sync) out.push({ kind: "dev_log", key: `devlog:${sync.sha}`, sha: sync.sha, notes: devNotes(sync.message) });
  if (excluded === null) return out; // without the team's list, "outside the team" cannot be counted
  const ex = excluded.map((a) => a.toLowerCase());
  const n = Number(
    (await db.query<{ n: string }>("SELECT count(DISTINCT lower(caller)) n FROM calls WHERE NOT (lower(caller) = ANY($1::text[]))", [ex])).rows[0]?.n ?? 0,
  );
  const m = milestoneReached(n);
  if (m !== null) out.push({ kind: "dev_milestone", key: `devmile:${m}`, callers: m });
  return out;
}
