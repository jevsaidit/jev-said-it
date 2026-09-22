"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPublicClient, createWalletClient, custom, type Abi, type Address, type EIP1193Provider, type Hex } from "viem";
import { CHAINS, DISTRIBUTOR_ABI, LEDGER_ABI, REVERT_TEXT } from "@/lib/chains";
import { isJev, said } from "@/lib/say";
import { RULES } from "@/lib/site";
import { cannotAddChain, useWallets } from "@/lib/wallets";
import type { Config } from "./Play";
import { WalletPicker } from "./WalletPicker";

// The live play panel. It decides nothing: the CallLedger accepts or refuses a call, the engine counts
// the balance at the epoch's start, the distributor checks the proof. The page only shows what
// each of them will say before you pay gas to hear it.

type Provider = EIP1193Provider & { on?: (e: string, f: (...a: unknown[]) => void) => void; removeListener?: (e: string, f: (...a: unknown[]) => void) => void };

type Claim = { epoch: number; amount: string; proof: Hex[] };
type Holder = { epoch: number; balanceAtStart: string | null; capacityAtStart: string | null; tokensPerCall: string; maxCallsPerEpoch: string; claims: Claim[] };
type Question = { id: Hex; epoch?: number; symbol?: string | null; token?: string; p?: string; model?: string; deadline?: number; status?: string };
type ClaimState = Claim & { claimed: boolean; voided: boolean; opensAt: number; expiresAt: number };
type Tx = { kind: "idle" } | { kind: "wallet" } | { kind: "pending"; hash: Hex } | { kind: "done"; hash: Hex } | { kind: "error"; msg: string; hash?: Hex };

const CLOSING_SEC = 60;
const fmtTokens = (wei: string | bigint) => (BigInt(wei) / 10n ** 18n).toLocaleString("en-US");
const hhmm = (ts: number) => new Date(ts * 1000).toISOString().slice(11, 16) + " UTC";
const dayHhmm = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
// X's post composer with the text filled in. The link is a share page whose card X renders;
// what the card prints comes from the engine, not from this text.
const postUrl = (text: string, path: string) =>
  `https://x.com/intent/post?${new URLSearchParams({ text, url: `${window.location.origin}${path}` }).toString()}`;
type Shared = { kind: "call"; id: Hex; symbol: string; p: number; model?: string; agree: boolean } | { kind: "win"; epoch: number; amount: string; jev: boolean };

// A revert is shown by what it means, a rejection by what happened; anything else by viem's first line.
const errMsg = (e: unknown) => {
  for (let x = e as { code?: number; data?: { errorName?: string }; cause?: unknown } | undefined; x; x = x.cause as typeof x) {
    if (x.code === 4001) return "You rejected it in the wallet. Nothing was sent.";
    const name = x.data?.errorName;
    if (name) return REVERT_TEXT[name] ?? `The contract refused it: ${name}.`;
  }
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

export function PlayLive({ ticker, cfg, chainId: wantId }: { ticker: string; cfg: Config; chainId: number }) {
  const T = `$${ticker}`;
  const chain = CHAINS[wantId]!;
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
  const onChain = chainId === chain.id;
  // The account a transaction was started for: a receipt arriving after the wallet switched accounts
  // must not be shown under the new one.
  const accountRef = useRef<Address | null>(null);
  accountRef.current = account;

  // The wallet: the one picked in lib/wallets.ts (EIP-6963 or window.ethereum), shared with the header.
  const { wallets, chosen: wallet } = useWallets();
  const provider: Provider | null | undefined = wallet === undefined ? undefined : ((wallet?.provider as Provider | undefined) ?? null);
  useEffect(() => {
    const t = setInterval(() => setTick(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, []);

  // A different wallet or network makes every pick, receipt and pending state meaningless.
  const reset = () => {
    setPicks({});
    setShared([]);
    setTx({ kind: "idle" });
    setHolder(null);
    setClaims([]);
    setUsed(null);
    setCapNow(null);
    setAnswered({});
  };

  // Keep account and chain in step with the wallet, including changes made inside the wallet.
  useEffect(() => {
    const eth = provider;
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
  }, [provider]);

  // Each refresh is numbered: a slow one for the previous account must not overwrite a newer one.
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    if (!account || !onChain || !cfg.callLedger || !provider) return;
    const my = ++seq.current;
    const pub = createPublicClient({ chain, transport: custom(provider) });
    const [h, e] = await Promise.all([feed<Holder>(`holder/${account}`), feed<{ questions?: Question[] }>("epochs/current")]);
    const head = await pub.getBlock({ blockTag: "latest" });
    if (my !== seq.current) return;
    setSkew(Number(head.timestamp) - Math.floor(Date.now() / 1000));
    setTick(Math.floor(Date.now() / 1000));
    const ep = await pub.readContract({ address: cfg.callLedger, abi: LEDGER_ABI, functionName: "currentEpoch" });
    if (my !== seq.current) return;
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
      const [delay, window] = await Promise.all([
        pub.readContract({ address: d, abi: DISTRIBUTOR_ABI, functionName: "CLAIM_DELAY" }),
        pub.readContract({ address: d, abi: DISTRIBUTOR_ABI, functionName: "CLAIM_WINDOW" }),
      ]);
      const cs = await Promise.all(
        h.data.claims.map(async (cl) => {
          const ep2 = BigInt(cl.epoch);
          const [claimed, voided, setAt] = await Promise.all([
            pub.readContract({ address: d, abi: DISTRIBUTOR_ABI, functionName: "hasClaimed", args: [ep2, account] }),
            pub.readContract({ address: d, abi: DISTRIBUTOR_ABI, functionName: "epochVoided", args: [ep2] }),
            pub.readContract({ address: d, abi: DISTRIBUTOR_ABI, functionName: "epochSetAt", args: [ep2] }),
          ]);
          return { ...cl, claimed, voided, opensAt: Number(setAt + delay), expiresAt: Number(setAt + window) };
        }),
      );
      if (my === seq.current) setClaims(cs);
    } else setClaims([]);
  }, [account, onChain, cfg, chain, provider]);

  // Batches open every couple of hours and rewards appear after each epoch: keep looking, while visible.
  useEffect(() => {
    refresh().catch(() => {});
    const t = setInterval(() => {
      if (document.visibilityState === "visible") refresh().catch(() => {});
    }, 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  const connect = async () => {
    if (!provider) return;
    try {
      const a = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      setAccount((a[0] as Address) ?? null);
    } catch (e) {
      setTx({ kind: "error", msg: errMsg(e) });
    }
  };

  // Some wallets switch without emitting chainChanged: the chain is re-read, not assumed.
  const readChain = async (eth: Provider) => setChainId(Number(await eth.request({ method: "eth_chainId" })));
  const switchChain = async () => {
    const eth = provider;
    if (!eth) return;
    const hex = `0x${chain.id.toString(16)}`;
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
      await readChain(eth);
    } catch (e) {
      // Only an unknown chain (4902) is added; a refusal is a refusal, not a second prompt.
      if ((e as { code?: number }).code !== 4902) return setTx({ kind: "error", msg: errMsg(e) });
      try {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: hex,
            chainName: chain.name,
            nativeCurrency: chain.nativeCurrency,
            rpcUrls: chain.rpcUrls.default.http,
            blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : undefined,
          }],
        });
        await readChain(eth);
      } catch (e) {
        setTx({ kind: "error", msg: errMsg(e) });
      }
    }
  };

  type Req = { address: Address; abi: Abi; functionName: string; args: readonly unknown[] };
  const txSeq = useRef(0);
  const send = async (req: Req, onDone?: () => void | Promise<void>) => {
    if (!provider || !account || !onChain) return;
    // Sequenced: if the wallet changes account or chain while this transaction is in flight, its
    // receipt and its share links belong to the old account and are dropped, not shown under the new one.
    const acct = account;
    const my = ++txSeq.current;
    const stale = () => my !== txSeq.current || acct !== accountRef.current;
    const wallet = createWalletClient({ account, chain, transport: custom(provider) });
    const pub = createPublicClient({ chain, transport: custom(provider) });
    try {
      setTx({ kind: "wallet" });
      // Ask the chain first: a call that would revert (sold since the page loaded, deadline passed,
      // claims not open yet) is refused here, with the contract's reason, before any gas is spent.
      const { request } = await pub.simulateContract({ ...req, account } as never);
      const hash = await wallet.writeContract(request);
      if (stale()) return;
      setTx({ kind: "pending", hash });
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 }).catch(() => null);
      if (stale()) return;
      if (!r) return setTx({ kind: "error", msg: "Not mined after 2 minutes. Check the transaction before sending again.", hash });
      setTx(r.status === "success" ? { kind: "done", hash } : { kind: "error", msg: "The transaction reverted on-chain.", hash });
      if (r.status === "success") await onDone?.();
      if (stale()) return;
      setPicks({});
      await refresh();
    } catch (e) {
      if (!stale()) setTx({ kind: "error", msg: errMsg(e) });
    }
  };

  const capStart = holder?.capacityAtStart != null ? BigInt(holder.capacityAtStart) : null;
  // What will actually be scored: the contract enforces the balance now, the engine the balance at start.
  const counted = capNow === null ? null : capStart === null ? capNow : capStart < capNow ? capStart : capNow;
  const left = counted !== null && used !== null ? (counted > used ? counted - used : 0n) : null;
  // A question in its last minute stays on screen as "closing", with its buttons off: a call sent in
  // its last seconds may land after the deadline, and a row that vanishes explains nothing.
  const closing = (q: Question) => (q.deadline ?? 0) <= now + CLOSING_SEC;
  const shownQs = useMemo(() => questions.filter((q) => (q.deadline ?? 0) > now), [questions, now]);
  // What gets sent is derived from what is still on screen: a pick on a question that has since closed,
  // or that this account already answered, would revert.
  const toSend = shownQs.filter((q) => !closing(q) && picks[q.id] !== undefined && !answered[q.id]);
  const chosen = toSend.length;
  const explorer = chain.blockExplorers?.default.url;

  const submit = () => {
    const snapshot: Shared[] = toSend.map((q) => ({ kind: "call", id: q.id, symbol: q.symbol ? `$${q.symbol}` : short(q.token ?? q.id), p: Number(q.p ?? 0), model: q.model, agree: picks[q.id]! }));
    return send(
      { address: cfg.callLedger!, abi: LEDGER_ABI, functionName: "submit", args: [toSend.map((q) => q.id), toSend.map((q) => picks[q.id]!)] },
      () => setShared(snapshot),
    );
  };
  const claim = (c: ClaimState) =>
    send(
      { address: cfg.rewardsDistributor!, abi: DISTRIBUTOR_ABI, functionName: "claim", args: [BigInt(c.epoch), BigInt(c.amount), c.proof] },
      async () => {
        // "I beat Jev" only if Jev answered that epoch; the post never dresses a fallback as Jev.
        const e = await feed<{ questions?: Question[] }>(`epochs/${c.epoch}`);
        const models = e.ok ? (e.data.questions ?? []).map((q) => q.model) : [];
        setShared([{ kind: "win", epoch: c.epoch, amount: c.amount, jev: models.length > 0 && models.every(isJev) }]);
      },
    );

  let body: ReactNode;
  if (provider === undefined) body = <p className="play__note">Looking for a wallet.</p>;
  else if (provider === null && wallets.length > 1)
    body = (
      <>
        <p className="play__note">Several wallets are installed. Pick the one to play with{cannotAddChain(wallets.find((w) => w.provider.isPhantom)) ? ` (Phantom can't use ${chain.name})` : ""}:</p>
        <WalletPicker wallets={wallets} />
      </>
    );
  else if (provider === null)
    body = (
      <>
        <p className="play__note">No browser wallet found. On a computer, install Rabby or MetaMask and reload this page.</p>
        <p className="play__note">
          On a phone, open this page inside your wallet&apos;s browser:{" "}
          <a href={`https://metamask.app.link/dapp/${window.location.host}${window.location.pathname}#play`}>open in MetaMask</a>, or paste{" "}
          <span className="mono">{window.location.host}</span> into Rabby&apos;s in-app browser.
        </p>
      </>
    );
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

        {shownQs.length === 0 ? (
          <p className="play__note">No question is open right now. The next batch opens at the start of the next epoch.</p>
        ) : (
          <ul className="play__qs">
            {shownQs.map((q) => {
              const done = answered[q.id];
              const pick = picks[q.id];
              const late = closing(q);
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
                  <span className="play__p">
                    {isJev(q.model) ? "Jev" : `${q.model ?? "model"} (fallback)`}: {q.p ? said(Number(q.p)) : "—"}
                  </span>
                  <span className="play__dl">{late ? "closing" : `closes ${q.deadline ? hhmm(q.deadline) : "—"}`}</span>
                  {done ? (
                    <span className="play__done">answered</span>
                  ) : (
                    <span className="play__pick" role="group" aria-label={`Your call on ${q.symbol ?? q.id}`}>
                      <button type="button" aria-pressed={pick === true} disabled={late || full || left === 0n} onClick={() => set(true)}>
                        Agree
                      </button>
                      <button type="button" aria-pressed={pick === false} disabled={late || full || left === 0n} onClick={() => set(false)}>
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
          className="btn play__submit"
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
                  ) : now >= c.expiresAt ? (
                    <span className="play__note--warn">expired {dayHhmm(c.expiresAt)}</span>
                  ) : (
                    <span className="play__claim">
                      <span className="play__dl">expires {dayHhmm(c.expiresAt)}</span>
                      <button className="btn btn--ghost" type="button" onClick={() => claim(c)} disabled={tx.kind === "wallet" || tx.kind === "pending"}>
                        Claim
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <p className="play__note play__note--small">A reward can be claimed for {RULES.claimWindowDays} days after its root is published; after that it goes back to the pool.</p>
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
            const text = `I beat ${x.jev ? "Jev" : "the model"}: +${fmtTokens(x.amount)} ${T} in epoch ${x.epoch}. @jevsaidit #jevsaidit`;
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
          const who = isJev(x.model) ? "Jev" : `${x.model ?? "The model"} (fallback)`;
          const text = `${who} said ${said(x.p)} on ${x.symbol}. I said ${mine}. @jevsaidit #jevsaidit`;
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
