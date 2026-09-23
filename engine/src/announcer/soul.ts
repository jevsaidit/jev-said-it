import { keccak256, stringToBytes } from "viem";
import { forX } from "./x.js";

// What a post will weigh on X, whichever side of the no-hex window it goes out on. X counts every link as
// 23 characters (t.co), whatever its real length.
const xWeight = (t: string) => t.replace(/https?:\/\/\S+/g, "x".repeat(23)).length;
const forXLength = (t: string) => Math.max(xWeight(forX(t)), xWeight(forX(t, 0, 0)));

// The voice of @jevsaidit: the degen of the pfp. Trusts Jev blindly, apes on it, never lies: every
// post carries the receipt, and when Jev is wrong he says it first and laughs at himself hardest.
// Spec: docs/superpowers/specs/2026-09-21-announcer-soul-design.md

export const SIGNATURE = "jev said it.\n#jevsaidit";
const EXPLORER = "https://robinhoodchain.blockscout.com";

/** Numbers the templates may contain on their own: constants of the contracts, nothing else. */
// The play rule from epoch 1 (22/09/2026): hold 1M, one call per 100k, 50 from 5M.
export const CONSTANTS = ["100k", "5M", "1 call", "50", "6h", "12h", "1M"] as const;

export type Unpaid = "empty" | "nobody" | "none_beat" | "unresolvable";
export type Q = { id: string; token: string; symbol: string | null; p: string; outcome: string | null };
export type AnnounceEvent =
  | { kind: "batch_opened"; key: string; epoch: number; deadline: number; questions: Q[] }
  | { kind: "closing_soon"; key: string; epoch: number; deadline: number; count: number }
  | { kind: "outcome"; key: string; question: Q }
  // players = wallets with a counted call; beat = those above the baseline; unpaid = why a NOT_PAYABLE epoch pays nobody.
  | { kind: "epoch_settled"; key: string; epoch: number; winners: number; top: string | null; claimsAt: number | null; players: number; beat: number; unpaid: Unpaid | null }
  | { kind: "claims_open"; key: string; epoch: number }
  | { kind: "swap"; key: string; ethIn: string; burned: string; tx: string }
  | { kind: "pin"; key: string }
  // B4: what shipped (subjects of a public showcase commit) and holders outside the team who played
  | { kind: "dev_log"; key: string; sha: string; notes: string[] }
  | { kind: "dev_milestone"; key: string; callers: number };

/** Formats data into text and remembers every string it produced, for the guard. */
export class Fmt {
  readonly produced: string[] = [];
  private keep(s: string) {
    this.produced.push(s);
    return s;
  }
  p(p: string) {
    return this.keep(Number(p).toFixed(2));
  }
  /** A line quoted verbatim from a public, linked source (a commit subject): its numbers are not ours to invent. */
  quote(s: string) {
    return this.keep(s);
  }
  int(n: number) {
    return this.keep(String(n));
  }
  time(ts: number) {
    const d = new Date(ts * 1000);
    return this.keep(`${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} utc`);
  }
  eth(wei: string) {
    return this.keep(`${(Number(BigInt(wei) / 10n ** 12n) / 1e6).toFixed(2)} ETH`);
  }
  /** token amounts in whole tokens, short: 12M, 340k, 900 */
  tokens(units: string) {
    const n = Number(BigInt(units) / 10n ** 18n);
    const s = n >= 1e6 ? `${Math.round(n / 1e6)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
    return this.keep(s);
  }
  addr(a: string) {
    return this.keep(`${a.slice(0, 6)}…${a.slice(-4)}`);
  }
  ticker(q: Q) {
    return this.keep(q.symbol ? `$${q.symbol}` : `${q.token.slice(0, 6)}…${q.token.slice(-4)}`);
  }
}

const DENY = [
  /\bbuy\s+\$?jev\b/i,
  /\$jev\b\s+(will|to|gonna)\s+(pump|moon|run|send)/i,
  /\b\d+x\b/i,
  /\bguarante/i,
  /\bprice (target|prediction)\b/i,
  /\bfinancial advice\b(?!.*\bnot\b)/i,
];

export function guard(text: string, f: Fmt): { ok: true } | { ok: false; reason: string } {
  for (const d of DENY) if (d.test(text)) return { ok: false, reason: `forbidden: ${d}` };
  let rest = text.replace(/https?:\/\/\S+/g, " ").replace(/0x[0-9a-fA-F…]+/g, " ").replace(/#jevsaidit|\$JEV\b/g, " ");
  for (const s of [...f.produced].sort((a, b) => b.length - a.length)) rest = rest.split(s).join(" ");
  for (const c of CONSTANTS) rest = rest.split(c).join(" ");
  const digit = rest.match(/\d/);
  return digit ? { ok: false, reason: `invented number near: ${rest.slice(Math.max(0, rest.indexOf(digit[0]) - 20), rest.indexOf(digit[0]) + 20)}` } : { ok: true };
}

/** Same event -> same variant (reproducible); different events -> different variants. */
function pick<T>(key: string, bank: readonly T[]): T {
  return bank[Number(BigInt(keccak256(stringToBytes(key))) % BigInt(bank.length))]!;
}

const post = (...lines: string[]) => `${lines.filter((l) => l !== "").join("\n")}\n\n${SIGNATURE}`;
const receipt = (site: string, id: string) => `receipt: ${site}/api/feed/q/${id}.json`;

export function render(e: AnnounceEvent, site: string): { telegram: string | null; x: string | null; fmt: Fmt } {
  const f = new Fmt();
  switch (e.kind) {
    case "batch_opened": {
      const hot = [...e.questions].sort((a, b) => Math.abs(Number(b.p) - 0.5) - Math.abs(Number(a.p) - 0.5))[0]!;
      const lines = e.questions.map((q) => `${f.ticker(q)} up? jev says ${f.p(q.p)}`);
      const open = pick(e.key, ["i'm already in.", "i already aped the first one.", "don't fade him.", "jev never sleeps. neither do i."]);
      const tg = post(`epoch ${f.int(e.epoch)} is open. ${f.int(e.questions.length)} questions.`, "", ...lines, "", `${open} call it before ${f.time(e.deadline)}.`);
      const x = post(`epoch ${f.int(e.epoch)} is open.`, `jev thinks ${f.ticker(hot)} ${Number(hot.p) >= 0.5 ? "pumps" : "dumps"}. ${f.p(hot.p)}.`, `${open} call it before ${f.time(e.deadline)}.`);
      return { telegram: tg, x, fmt: f };
    }
    case "closing_soon": {
      const nag = pick(e.key, ["last call. literally.", "calls close soon. pick a side.", "you're still thinking. jev isn't."]);
      return { telegram: post(`epoch ${f.int(e.epoch)}: calls close at ${f.time(e.deadline)}.`, nag), x: null, fmt: f };
    }
    case "outcome": {
      const q = e.question;
      const saidUp = Number(q.p) >= 0.5;
      const right = (q.outcome === "1") === saidUp;
      const dir = saidUp ? "goes up" : "goes down";
      const went = q.outcome === "1" ? "it went up." : "it went down.";
      const verdict = right
        ? pick(e.key, ["i'm up. jev is god.", "i'm up. told you.", "printed. jev is never wrong. (he is. not today.)"])
        : pick(e.key, ["jev lied. i'm cooked. still holding. still calling.", "jev was wrong. rent money gone. still here.", "jev was wrong. i'm rekt. calling the next one anyway."]);
      const text = post(
        `jev said ${f.p(q.p)} that ${f.ticker(q)} ${dir}.`,
        right ? "i aped." : pick(e.key, ["i aped.", "i aped my rent."]),
        went,
        verdict,
        receipt(site, q.id),
      );
      return { telegram: text, x: text, fmt: f };
    }
    case "epoch_settled": {
      // Not paid is not the same as nobody won: with an empty distributor (before $JEV graduates the
      // curve) every epoch closes NOT_PAYABLE, including the ones where wallets did beat the baseline.
      if (e.unpaid) {
        const beat = e.beat > 0 ? `${f.int(e.beat)} of ${f.int(e.players)} wallets out-called the baseline.` : "nobody beat the baseline.";
        const why =
          e.unpaid === "empty" ? [beat, "no payout: the reward pool fills from buybacks, and they start when $JEV graduates the curve."]
          : e.unpaid === "nobody" ? ["no holder called it."]
          : e.unpaid === "unresolvable" ? ["too many questions could not be settled. when in doubt, nothing is paid."]
          : ["nobody beat the baseline. not even me."];
        const text = post(`epoch ${f.int(e.epoch)} is done.`, ...why, e.players > 0 ? `scores: ${site}/e/${e.epoch}` : "");
        return { telegram: text, x: text, fmt: f };
      }
      const lines = [
        `epoch ${f.int(e.epoch)} is done.`,
        e.winners > 0 ? `${f.int(e.winners)} wallets out-called the baseline.` : "nobody beat the baseline. not even me.",
        e.top ? `${f.addr(e.top)} ate the most.` : "",
        e.claimsAt ? `claims open at ${f.time(e.claimsAt)}. ${pick(e.key, ["i got nothing. again.", "i'm not on the list. again.", "i was busy aping."])}` : "",
      ];
      const text = post(...lines);
      return { telegram: text, x: text, fmt: f };
    }
    case "claims_open":
      return { telegram: post(`epoch ${f.int(e.epoch)}: claims are open.`, "if you were right, go get paid."), x: null, fmt: f };
    case "dev_log": {
      // Plain voice, not the degen's: this is the builder saying what changed, with the diff one click away.
      const link = `code: https://github.com/jevsaidit/jev-said-it/commit/${e.sha}`;
      const lines: string[] = [];
      for (const n of e.notes) {
        const next = post("dev log. shipped:", ...lines, `· ${n}`, link);
        if (forXLength(next) > 280) break;
        lines.push(`· ${f.quote(n)}`);
      }
      if (lines.length === 0) return { telegram: null, x: null, fmt: f };
      const text = post("dev log. shipped:", ...lines, link);
      return { telegram: text, x: text, fmt: f };
    }
    case "dev_milestone": {
      const head = e.callers === 1 ? "the first holder outside the team made a call." : `${f.int(e.callers)} holders outside the team have made a call.`;
      const text = post(head, "jev said it first. now it's their word against his.", `play: ${site}/play`);
      return { telegram: text, x: text, fmt: f };
    }
    case "swap": {
      const text = post(
        "the fees came in.",
        `${f.eth(e.ethIn)} bought $JEV. ${f.tokens(e.burned)} burned. the rest pays the callers.`,
        `tx: ${EXPLORER}/tx/${e.tx}`,
      );
      return { telegram: text, x: text, fmt: f };
    }
    case "pin": {
      const text = post(
        "hold $JEV, get calls.",
        `hold ${CONSTANTS[6]} to play. ${CONSTANTS[0]} = ${CONSTANTS[2]}. ${CONSTANTS[1]} = ${CONSTANTS[3]}.`,
        "be right, get paid from the fees.",
        "be wrong, lose nothing but pride.",
        "memes, not positions. nfa.",
      );
      return { telegram: text, x: text, fmt: f };
    }
  }
}
