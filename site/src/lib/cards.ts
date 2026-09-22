import { readFile } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, http, type Address } from "viem";
import { CHAINS, DISTRIBUTOR_ABI } from "@/lib/chains";
import { isJev } from "@/lib/say";

// Server side of the share receipts. Everything printed on a card comes from the engine, never
// from the URL: a link cannot make a card claim a reward that was not published. The only thing
// the URL carries is which side the sharer took on a question, and that is labelled as theirs.
//
// Two ways to have no card, kept apart: "blind" (the engine could not be asked: not configured,
// unreachable, or answering 5xx) and null (the engine answered that the thing does not exist).
// X and Telegram scrape a link once and cache what they get, so "can't look" must never be served
// as "doesn't exist".

export const BLIND = "blind" as const;
export type Blind = typeof BLIND;

const ENGINE = () => process.env.ENGINE_FEED_URL?.trim().replace(/\/+$/, "");

async function engine<T>(p: string): Promise<T | null | Blind> {
  const base = ENGINE();
  if (!base) return BLIND;
  try {
    const r = await fetch(`${base}${p}`, {
      headers: { accept: "application/json", "user-agent": "jevsaidit-site" },
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) return (await r.json()) as T;
    return r.status === 404 ? null : BLIND;
  } catch {
    return BLIND;
  }
}

export type CallCard = {
  id: string;
  symbol: string;
  p: number; // the model's probability that the price goes up, 0..1
  model: string; // who answered, from the committed receipt: "typesafe/jev-…" or the fallback's id
  deadline: number;
  outcome: string | null; // "1" up, "0" down, VOID/UNRESOLVABLE, null = not yet
};

export async function callCard(id: string): Promise<CallCard | null | Blind> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) return null;
  const q = await engine<{ epoch: string; p: string; deadline: string; token: string; model?: string }>(`/q/${id}.json`);
  if (q === null || q === BLIND) return q;
  const e = await engine<{ questions?: Array<{ id: string; symbol?: string | null; outcome: string | null }> }>(`/epochs/${Number(q.epoch)}`);
  if (e === BLIND) return BLIND;
  const row = e?.questions?.find((x) => x.id.toLowerCase() === id.toLowerCase());
  return {
    id,
    // "$SYMBOL" when the token has one, the short address otherwise: a "$" before an address reads wrong.
    symbol: row?.symbol ? `$${row.symbol}` : `${q.token.slice(0, 6)}…${q.token.slice(-4)}`,
    p: Number(q.p),
    model: q.model ?? "",
    deadline: Number(q.deadline),
    outcome: row?.outcome ?? null,
  };
}

export type WinCard = { epoch: number; account: string; amount: bigint; jev: boolean; models: string[] };

export async function winCard(epoch: string, account: string): Promise<WinCard | null | Blind> {
  if (!/^\d{1,6}$/.test(epoch) || !/^0x[0-9a-fA-F]{40}$/.test(account)) return null;
  const c = await engine<{ amount: string }>(`/claim/${epoch}/${account}`);
  if (c === null || c === BLIND) return c;
  // A published root can still be voided by the guardian: that reward will never be paid, so no card.
  // Asked to the chain, not to the engine, which does not track voids. Not knowing = no card either.
  const cfg = await engine<{ chainId: number | null; rewardsDistributor: Address | null }>("/config");
  if (cfg === BLIND || cfg === null) return BLIND;
  const chain = cfg.chainId ? CHAINS[cfg.chainId] : undefined;
  if (!chain || !cfg.rewardsDistributor) return BLIND;
  try {
    const voided = await createPublicClient({ chain, transport: http(undefined, { timeout: 8000 }) }).readContract({
      address: cfg.rewardsDistributor,
      abi: DISTRIBUTOR_ABI,
      functionName: "epochVoided",
      args: [BigInt(epoch)],
    });
    if (voided) return null;
  } catch {
    return BLIND;
  }
  // "I beat Jev" only if Jev answered every question of that epoch; otherwise the card names the fallback.
  const e = await engine<{ questions?: Array<{ model?: string }> }>(`/epochs/${Number(epoch)}`);
  const models = e && e !== BLIND ? [...new Set((e.questions ?? []).map((q) => q.model ?? "").filter(Boolean))] : [];
  const jev = models.length > 0 && models.every(isJev);
  return { epoch: Number(epoch), account: account.toLowerCase(), amount: BigInt(c.amount), jev, models };
}

export const tokens = (wei: bigint) => (wei / 10n ** 18n).toLocaleString("en-US");
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Did the sharer's side turn out right? null while the question is open or void. */
export function sideWasRight(side: "agree" | "disagree", c: CallCard): boolean | null {
  if (c.outcome !== "0" && c.outcome !== "1") return null;
  const jevSaysUp = c.p >= 0.5;
  const agreeMeansUp = side === "agree" ? jevSaysUp : !jevSaysUp;
  return agreeMeansUp === (c.outcome === "1");
}

/** The answer for a card that cannot be drawn right now: retry soon, and never cache the blank. */
export const blindResponse = () =>
  Response.json({ state: "blind", reason: "engine unreachable" }, { status: 503, headers: { "retry-after": "30", "cache-control": "no-store" } });

const DIR = path.join(process.cwd(), "src/app/api/card");
async function loadAssets() {
  const [pixel, mono, monoBold, mascot] = await Promise.all([
    readFile(path.join(DIR, "fonts/PixelifySans-Bold.ttf")),
    readFile(path.join(DIR, "fonts/MartianMono-Regular.ttf")),
    readFile(path.join(DIR, "fonts/MartianMono-SemiBold.ttf")),
    readFile(path.join(DIR, "mascot-x8.png")),
  ]);
  return {
    fonts: [
      { name: "Pixel", data: pixel, weight: 700 as const, style: "normal" as const },
      { name: "Mono", data: mono, weight: 400 as const, style: "normal" as const },
      { name: "Mono", data: monoBold, weight: 600 as const, style: "normal" as const },
    ],
    mascot: `data:image/png;base64,${mascot.toString("base64")}`,
  };
}
// Three fonts and a PNG never change while the process runs: read and encoded once, not per card.
let assets: ReturnType<typeof loadAssets> | undefined;
export const cardAssets = () => (assets ??= loadAssets().catch((e) => {
  assets = undefined;
  throw e;
}));

export const C = { ink: "#07120b", felt: "#0e2a17", line: "#245c35", hood: "#3df07a", mint: "#e6f4e1", dim: "#a9c4a8", gold: "#f2c230", coral: "#f59a8f", laser: "#ff2828" };
