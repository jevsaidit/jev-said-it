"use client";

// The header's wallet button, live before launch too: it connects a browser wallet and puts it on
// Robinhood Chain, so a holder is ready when calls open. No viem here (it stays in PlayLive): plain
// EIP-1193 requests. Once connected, PlayLive finds the same account with eth_accounts, no second prompt.
import { useEffect, useState } from "react";
import { CHAIN } from "@/lib/site";

type Eip1193 = {
  request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (e: string, f: (...a: unknown[]) => void) => void;
  removeListener?: (e: string, f: (...a: unknown[]) => void) => void;
};

const HEX = `0x${CHAIN.id.toString(16)}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function WalletButton() {
  const [eth, setEth] = useState<Eip1193 | null | undefined>(undefined);
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // The wallet: injected at load, injected late (ethereum#initialized), or announced by EIP-6963.
  useEffect(() => {
    const w = window as unknown as { ethereum?: Eip1193 };
    const found = (p: Eip1193 | undefined) => setEth((cur) => cur ?? p ?? null);
    const onInit = () => found(w.ethereum);
    const onAnnounce = (e: Event) => found((e as CustomEvent<{ provider?: Eip1193 }>).detail?.provider);
    window.addEventListener("ethereum#initialized", onInit);
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    found(w.ethereum);
    return () => {
      window.removeEventListener("ethereum#initialized", onInit);
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
    };
  }, []);

  // An account authorized earlier shows up without a click; account and network changes are followed.
  useEffect(() => {
    if (!eth) return;
    const onAcc = (a: unknown) => setAccount(Array.isArray(a) && typeof a[0] === "string" ? a[0] : null);
    const onChain = (c: unknown) => setChainId(typeof c === "string" ? Number(c) : null);
    eth.request({ method: "eth_accounts" }).then(onAcc).catch(() => {});
    eth.request({ method: "eth_chainId" }).then(onChain).catch(() => {});
    eth.on?.("accountsChanged", onAcc);
    eth.on?.("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAcc);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, [eth]);

  const say = (m: string) => {
    setNote(m);
    setTimeout(() => setNote(null), 4000);
  };

  const toChain = async (p: Eip1193) => {
    try {
      await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: HEX }] });
    } catch (e) {
      // Only an unknown chain (4902) is added; a refusal is a refusal, not a second prompt.
      if ((e as { code?: number }).code !== 4902) return;
      await p.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: HEX, chainName: CHAIN.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [CHAIN.rpc], blockExplorerUrls: [CHAIN.explorer] }],
      });
    }
    setChainId(Number(await p.request({ method: "eth_chainId" })));
  };

  const click = async () => {
    if (!eth) return say("No browser wallet found");
    try {
      if (!account) {
        const a = (await eth.request({ method: "eth_requestAccounts" })) as string[];
        setAccount(a[0] ?? null);
      }
      await toChain(eth);
    } catch {
      say("Request refused");
    }
  };

  const ready = account && chainId === CHAIN.id;
  const label = note ?? (!account ? "Connect wallet" : chainId !== CHAIN.id ? `Switch to ${CHAIN.name}` : short(account));
  if (ready && !note)
    return (
      <a className="btn nav__wallet" href="#play" title={`${account} on ${CHAIN.name}`}>
        {label}
      </a>
    );
  return (
    <button className="btn nav__wallet" type="button" onClick={click} aria-live="polite">
      {label}
    </button>
  );
}
