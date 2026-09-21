"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPublicClient, createWalletClient, custom, type Abi, type Address, type EIP1193Provider, type Hex } from "viem";
import { CHAINS, DISTRIBUTOR_ABI, LEDGER_ABI } from "@/lib/chains";

// The play panel. It decides nothing: the CallLedger accepts or refuses a call, the engine counts
// the balance at the epoch's start, the distributor checks the proof. The page only shows what
// each of them will say before you pay gas to hear it.

declare global {
  interface Window {
    ethereum?: EIP1193Provider & { on?: (e: string, f: (...a: unknown[]) => void) => void; removeListener?: (e: string, f: (...a: unknown[]) => void) => void };
  }
}

type Config = { chainId: number | null; token: Address; callLedger: Address | null; rewardsDistributor: Address | null };
type Claim = { epoch: number; amount: string; proof: Hex[] };
type Holder = { epoch: number; balanceAtStart: string | null; capacityAtStart: string | null; tokensPerCall: string; maxCallsPerEpoch: string; claims: Claim[] };
type Question = { id: Hex; epoch?: number; symbol?: string | null; token?: string; p?: string; deadline?: number; status?: string };
type ClaimState = Claim & { claimed: boolean; voided: boolean; opensAt: number };
type Tx = { kind: "idle" } | { kind: "wallet" } | { kind: "pending"; hash: Hex } | { kind: "done"; hash: Hex } | { kind: "error"; msg: string; hash?: Hex };

const fmtTokens = (wei: string | bigint) => (BigInt(wei) / 10n ** 18n).toLocaleString("en-US");
const hhmm = (ts: number) => new Date(ts * 1000).toISOString().slice(11, 16) + " UTC";
const dayHhmm = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
// X's post composer with the text filled in. The link is a share page whose card X renders;
// what the card prints comes from the engine, not from this text.
const postUrl = (text: string, path: string) =>
  `https://x.com/intent/post?${new URLSearchParams({ text, url: `${window.location.origin}${path}` }).toString()}`;
type Shared = { kind: "call"; id: Hex; symbol: string; p: number; agree: boolean } | { kind: "win"; epoch: number; amount: string };

const errMsg = (e: unknown) => {
  const x = e as { shortMessage?: string; message?: string };
  return (x.shortMessage ?? x.message ?? "The wallet returned an error.").split("\n")[0]!;
};

async function feed<T>(path: string): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  try {
    const r = await fetch(`/api/feed/${path}`, { cache: "no-store" });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, data: (await r.json()) as T };
  } catch {
    return { ok: false, status: 0 };
  }
}

export function Play({ ticker }: { ticker: string }) {
  const T = `$${ticker}`;
  // null = loading, "offline" = the site has no engine yet (pre-launch), "blind" = the engine did not answer
  const [cfg, setCfg] = useState<Config | null | "blind" | "offline">(null);
  const [hasWallet, setHasWallet] = useState<boolean | null>(null);
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [holder, setHolder] = useState<Holder | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [chainEpoch, setChainEpoch] = useState<bigint | null>(null);
  const [used, setUsed] = useState<bigint | null>(null);
  const [capNow, setCapNow] = useState<bigint | null>(null);
  const [answered, setAnswered] = useState<Record<string, boolean>>({});
  const [claims, setClaims] = useState<ClaimState[]>([]);
  const [picks, setPicks] = useState<Record<string, boolean>>({});
  const [tx, setTx] = useState<Tx>({ kind: "idle" });
  const [shared, setShared] = useState<Shared[]>([]);
  const [tick, setTick] = useState(() => Math.floor(Date.now() / 1000));
  // The contract judges deadlines and claim windows by the chain's clock, not this computer's.
  const [skew, setSkew] = useState(0);
  const now = tick + skew;

  const live = cfg && cfg !== "blind" && cfg !== "offline" ? cfg : null;
  const chain = live?.chainId ? CHAINS[live.chainId] : undefined;
  const onChain = chain !== undefined && chainId === chain.id;

  useEffect(() => {
    setHasWallet(typeof window !== "undefined" && !!window.ethereum);
    feed<Config>("config").then((r) => setCfg(r.ok ? r.data : r.status === 503 ? "offline" : "blind"));
    const t = setInterval(() => setTick(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, []);

  // A different wallet or network makes every pick, receipt and pending state meaningless.
  const reset = () => {
    setPicks({});
    setShared([]);
    setTx({ kind: "idle" });
  };

  // Keep account and chain in step with the wallet, including changes made inside the wallet.
  useEffect(() => {
    const eth = window.ethereum;
    if (!eth) return;
    const onAcc = (a: unknown) => {
      reset();
      setAccount(((a as string[])[0] as Address) ?? null);
    };
    const onChainChanged = (c: unknown) => {
      reset();
      setChainId(Number(c as string));
    };
    eth.request({ method: "eth_accounts" }).then((a) => onAcc(a)).catch(() => {});
    eth.request({ method: "eth_chainId" }).then((c) => onChainChanged(c)).catch(() => {});
    eth.on?.("accountsChanged", onAcc);
    eth.on?.("chainChanged", onChainChanged);
    return () => {
      eth.removeListener?.("accountsChanged", onAcc);
      eth.removeListener?.("chainChanged", onChainChanged);
    };
  }, []);

  // Each refresh is numbered: a slow one for the previous account must not overwrite a newer one.
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    const cfg = live;
    if (!account || !onChain || !cfg || !cfg.callLedger || !window.ethereum) return;
    const my = ++seq.current;
    const pub = createPublicClient({ chain, transport: custom(window.ethereum) });
    const [h, e] = await Promise.all([feed<Holder>(`holder/${account}`), feed<{ questions?: Question[] }>("epochs/current")]);
    const head = await pub.getBlock({ blockTag: "latest" });
    if (my !== seq.current) return;
    setSkew(Number(head.timestamp) - Math.floor(Date.now() / 1000));
    setTick(Math.floor(Date.now() / 1000));
    const ep = await pub.readContract({ address: cfg.callLedger, abi: LEDGER_ABI, functionName: "currentEpoch" });
    setChainEpoch(ep);
    // The feed can lag the chain by a cache window. Around an epoch change it can still list last
    // epoch's questions, and the contract would revert them with QuestionClosed after you paid gas:
    // only the questions of the epoch the contract is in, and still open by the chain's clock.
    const open = e.ok
      ? (e.data.questions ?? []).filter((q) => q.status === "OPEN" && q.epoch === Number(ep) && (q.deadline ?? 0) > Number(head.timestamp))
      : [];
    setQuestions(open);
    setHolder(h.ok ? h.data : null);
    const [u, c, ...ans] = await Promise.all([
      pub.readContract({ address: cfg.callLedger, abi: LEDGER_ABI, functionName: "callsUsed", args: [ep, account] }),
      pub.readContract({ address: cfg.callLedger, abi: LEDGER_ABI, functionName: "capacity", args: [account] }),
      ...open.map((q) => pub.readContract({ address: cfg.callLedger!, abi: LEDGER_ABI, functionName: "answered", args: [ep, account, q.id] })),
    ]);
    if (my !== seq.current) return;
    setUsed(u);
    setCapNow(c);
    setAnswered(Object.fromEntries(open.map((q, i) => [q.id, ans[i] as boolean])));
    if (h.ok && cfg.rewardsDistributor && h.data.claims.length > 0) {
      const d = cfg.rewardsDistributor;
      const delay = await pub.readContract({ address: d, abi: DISTRIBUTOR_ABI, functionName: "CLAIM_DELAY" });
      const cs = await Promise.all(
          h.data.claims.map(async (cl) => {
            const ep2 = BigInt(cl.epoch);
            const [claimed, voided, setAt] = await Promise.all([
              pub.readContract({ address: d, abi: DISTRIBUTOR_ABI, functionName: "hasClaimed", args: [ep2, account] }),
              pub.readContract({ address: d, abi: DISTRIBUTOR_ABI, functionName: "epochVoided", args: [ep2] }),
              pub.readContract({ address: d, abi: DISTRIBUTOR_ABI, functionName: "epochSetAt", args: [ep2] }),
            ]);
            return { ...cl, claimed, voided, opensAt: Number(setAt + delay) };
          }),
        );
      if (my === seq.current) setClaims(cs);
    } else setClaims([]);
  }, [account, onChain, live, chain]);

  // Batches open every couple of hours and rewards appear after each epoch: keep looking, while visible.
  useEffect(() => {
    refresh().catch(() => {});
    const t = setInterval(() => {
      if (document.visibilityState === "visible") refresh().catch(() => {});
    }, 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  const connect = async () => {
    if (!window.ethereum) return;
    try {
      const a = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
      setAccount((a[0] as Address) ?? null);
    } catch (e) {
      setTx({ kind: "error", msg: errMsg(e) });
    }
  };

  const switchChain = async () => {
    if (!window.ethereum || !chain) return;
    const hex = `0x${chain.id.toString(16)}`;
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (e) {
      // Only an unknown chain (4902) is added; a refusal is a refusal, not a second prompt.
      if ((e as { code?: number }).code !== 4902) return setTx({ kind: "error", msg: errMsg(e) });
      try {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: hex,
            chainName: chain.name,
            nativeCurrency: chain.nativeCurrency,
            rpcUrls: chain.rpcUrls.default.http,
            blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : undefined,
          }],
        });
      } catch (e) {
        setTx({ kind: "error", msg: errMsg(e) });
      }
    }
  };

  type Req = { address: Address; abi: Abi; functionName: string; args: readonly unknown[] };
  const send = async (req: Req, onDone?: () => void) => {
    if (!window.ethereum || !account || !chain) return;
    const wallet = createWalletClient({ account, chain, transport: custom(window.ethereum) });
    const pub = createPublicClient({ chain, transport: custom(window.ethereum) });
    try {
      setTx({ kind: "wallet" });
      // Ask the chain first: a call that would revert (sold since the page loaded, deadline passed,
      // claims not open yet) is refused here, with the contract's reason, before any gas is spent.
      const { request } = await pub.simulateContract({ ...req, account } as never);
      const hash = await wallet.writeContract(request);
      setTx({ kind: "pending", hash });
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 }).catch(() => null);
      if (!r) return setTx({ kind: "error", msg: "Not mined after 2 minutes. Check the transaction before sending again.", hash });
      setTx(r.status === "success" ? { kind: "done", hash } : { kind: "error", msg: "The transaction reverted on-chain.", hash });
      if (r.status === "success") onDone?.();
      setPicks({});
      await refresh();
    } catch (e) {
      setTx({ kind: "error", msg: errMsg(e) });
    }
  };

  const capStart = holder?.capacityAtStart != null ? BigInt(holder.capacityAtStart) : null;
  // What will actually be scored: the contract enforces the balance now, the engine the balance at start.
  const counted = capNow === null ? null : capStart === null ? capNow : capStart < capNow ? capStart : capNow;
  const left = counted !== null && used !== null ? (counted > used ? counted - used : 0n) : null;
  // Hide a question a minute before it closes: a call sent in its last seconds may land after the deadline.
  const openQs = useMemo(() => questions.filter((q) => (q.deadline ?? 0) > now + 60), [questions, now]);
  // What gets sent is derived from what is still on screen: a pick on a question that has since closed,
  // or that this account already answered, would revert.
  const toSend = openQs.filter((q) => picks[q.id] !== undefined && !answered[q.id]);
  const chosen = toSend.length;
  const explorer = chain?.blockExplorers?.default.url;

  const submit = () => {
    const snapshot: Shared[] = toSend.map((q) => ({ kind: "call", id: q.id, symbol: q.symbol ? `$${q.symbol}` : short(q.token ?? q.id), p: Number(q.p ?? 0), agree: picks[q.id]! }));
    return send(
      { address: live!.callLedger!, abi: LEDGER_ABI, functionName: "submit", args: [toSend.map((q) => q.id), toSend.map((q) => picks[q.id]!)] },
      () => setShared(snapshot),
    );
  };
  const claim = (c: ClaimState) =>
    send(
      { address: live!.rewardsDistributor!, abi: DISTRIBUTOR_ABI, functionName: "claim", args: [BigInt(c.epoch), BigInt(c.amount), c.proof] },
      () => setShared([{ kind: "win", epoch: c.epoch, amount: c.amount }]),
    );

  let body: ReactNode;
  if (cfg === null) body = <p className="play__note">Reading the engine.</p>;
  else if (cfg === "blind") body = <p className="play__note">The engine didn&apos;t answer, so there is nothing to sign right now. Try again in a minute.</p>;
  else if (cfg === "offline" || !cfg.callLedger || !chain)
    body = <p className="play__note">Calls open at launch, when the CallLedger is deployed. Its address will be printed here.</p>;
  else if (hasWallet === false)
    body = <p className="play__note">No browser wallet found. Install Rabby or MetaMask, then reload this page.</p>;
  else if (!account)
    body = (
      <button className="btn" type="button" onClick={connect}>
        Connect wallet
      </button>
    );
  else if (!onChain)
    body = (
      <>
        <p className="play__note">Your wallet is on another network. Calls live on {chain.name}.</p>
        <button className="btn" type="button" onClick={switchChain}>
          Switch to {chain.name}
        </button>
      </>
    );
  else
    body = (
      <>
        <dl className="play__stats">
          <div>
            <dt>Wallet</dt>
            <dd>{short(account)}</dd>
          </div>
          <div>
            <dt>Held at epoch {holder?.epoch ?? String(chainEpoch ?? "")} start</dt>
            <dd>{holder?.balanceAtStart != null ? `${fmtTokens(holder.balanceAtStart)} ${T}` : "not indexed yet"}</dd>
          </div>
          <div>
            <dt>Calls left</dt>
            <dd>{left === null ? "—" : `${left} of ${counted}`}</dd>
          </div>
        </dl>

        {capNow === 0n && <p className="play__note">You need at least {holder ? fmtTokens(holder.tokensPerCall) : "10,000"} {T} in this wallet to make a call.</p>}
        {capNow !== null && capNow > 0n && capStart === 0n && (
          <p className="play__note play__note--warn">
            You bought after this epoch started. Calls sent now would be dropped at scoring, so they are disabled. You play from the next epoch.
          </p>
        )}
        {capStart === null && capNow !== null && capNow > 0n && (
          <p className="play__note">Your balance at epoch start isn&apos;t indexed yet. Only calls within it will count.</p>
        )}

        {openQs.length === 0 ? (
          <p className="play__note">No question is open right now. The next batch opens at the start of the next epoch.</p>
        ) : (
          <ul className="play__qs">
            {openQs.map((q) => {
              const done = answered[q.id];
              const pick = picks[q.id];
              const full = left !== null && chosen >= Number(left) && pick === undefined;
              const set = (v: boolean) =>
                setPicks((p) => {
                  const n = { ...p };
                  if (n[q.id] === v) delete n[q.id];
                  else n[q.id] = v;
                  return n;
                });
              return (
                <li key={q.id} className="play__q">
                  <span className="play__sym">{q.symbol ?? short(q.token ?? q.id)}</span>
                  <span className="play__p">Jev: {q.p ? `${Math.round(Number(q.p) * 100)}% up` : "—"}</span>
                  <span className="play__dl">closes {q.deadline ? hhmm(q.deadline) : "—"}</span>
                  {done ? (
                    <span className="play__done">answered</span>
                  ) : (
                    <span className="play__pick" role="group" aria-label={`Your call on ${q.symbol ?? q.id}`}>
                      <button type="button" aria-pressed={pick === true} disabled={full || left === 0n} onClick={() => set(true)}>
                        Agree
                      </button>
                      <button type="button" aria-pressed={pick === false} disabled={full || left === 0n} onClick={() => set(false)}>
                        Disagree
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <button
          className="btn"
          type="button"
          disabled={chosen === 0 || left === null || left === 0n || capStart === 0n || tx.kind === "wallet" || tx.kind === "pending"}
          onClick={submit}
        >
          Submit {chosen || ""} call{chosen === 1 ? "" : "s"}
        </button>

        {claims.length > 0 && (
          <div className="play__claims">
            <h3>Your rewards</h3>
            <ul>
              {claims.map((c) => (
                <li key={c.epoch}>
                  <span>
                    Epoch {c.epoch}: {fmtTokens(c.amount)} {T}
                  </span>
                  {c.claimed ? (
                    <span className="play__done">claimed</span>
                  ) : c.voided ? (
                    <span className="play__note--warn">voided by the guardian</span>
                  ) : now < c.opensAt ? (
                    <span>claims open {dayHhmm(c.opensAt)}</span>
                  ) : (
                    <button className="btn btn--ghost" type="button" onClick={() => claim(c)} disabled={tx.kind === "wallet" || tx.kind === "pending"}>
                      Claim
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </>
    );

  const share = shared.length > 0 && (
    <div className="play__share">
      <h3>{shared[0]!.kind === "win" ? "Post the receipt" : "Post your calls"}</h3>
      <ul>
        {shared.map((x) => {
          if (x.kind === "win") {
            const text = `I beat Jev: +${fmtTokens(x.amount)} ${T} in epoch ${x.epoch}. @jevsaidit #jevsaidit`;
            return (
              <li key={`w${x.epoch}`}>
                <span>
                  Epoch {x.epoch}: +{fmtTokens(x.amount)} {T}
                </span>
                <a className="btn" href={postUrl(text, `/w/${x.epoch}/${account}`)} target="_blank" rel="noopener">
                  Post on X
                </a>
              </li>
            );
          }
          const up = x.p >= 0.5;
          const mine = x.agree === up ? "up" : "down";
          const text = `Jev said ${Math.round((up ? x.p : 1 - x.p) * 100)}% ${up ? "up" : "down"} on ${x.symbol}. I said ${mine}. @jevsaidit #jevsaidit`;
          return (
            <li key={x.id}>
              <span>
                {x.symbol}: you said {mine}
              </span>
              <a className="btn btn--ghost" href={postUrl(text, `/c/${x.id}/${x.agree ? "agree" : "disagree"}`)} target="_blank" rel="noopener">
                Post on X
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );

  return (
    <div className="play">
      {body}
      {share}
      {tx.kind !== "idle" && (
        <p className={`play__tx${tx.kind === "error" ? " play__note--warn" : ""}`} data-tx={"hash" in tx ? tx.hash : undefined} aria-live="polite">
          {tx.kind === "wallet" && "Confirm in your wallet."}
          {tx.kind === "pending" && "Sent. Waiting for the block."}
          {tx.kind === "done" && "Confirmed on-chain."}
          {tx.kind === "error" && tx.msg}{" "}
          {"hash" in tx && tx.hash && explorer && (
            <a href={`${explorer}/tx/${tx.hash}`} target="_blank" rel="noreferrer">
              View transaction
            </a>
          )}
        </p>
      )}
    </div>
  );
}
