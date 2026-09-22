"use client";

// The header's wallet button, live before launch too: it connects a browser wallet and puts it on
// Robinhood Chain, so a holder is ready when calls open. With several wallets installed it asks which
// one (lib/wallets.ts); the play panel then uses the same one. No viem here: plain EIP-1193 requests.
import { useEffect, useRef, useState } from "react";
import { CHAIN } from "@/lib/site";
import { cannotAddChain, pickWallet, useWallets, type Wallet } from "@/lib/wallets";
import { WalletPicker } from "./WalletPicker";

const HEX = `0x${CHAIN.id.toString(16)}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function WalletButton() {
  const { wallets, chosen } = useWallets();
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // An account authorized earlier shows up without a click; account and network changes are followed.
  useEffect(() => {
    setAccount(null);
    setChainId(null);
    const eth = chosen?.provider;
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
  }, [chosen]);

  // The menu closes on a click elsewhere or Escape.
  useEffect(() => {
    if (!menu) return;
    const out = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setMenu(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("mousedown", out);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", out);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const say = (m: string) => {
    setNote(m);
    setTimeout(() => setNote(null), 6000);
  };

  const connect = async (w: Wallet) => {
    setMenu(false);
    const eth = w.provider;
    try {
      const a = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      setAccount(a[0] ?? null);
    } catch {
      return say("Request refused");
    }
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: HEX }] });
    } catch (e) {
      if (cannotAddChain(w)) {
        // Forget it, so the next click offers the other wallets instead of trying this one again.
        pickWallet(null);
        return say(`${w.name} can't use ${CHAIN.name}: pick another wallet`);
      }
      // Only an unknown chain (4902) is added; a refusal is a refusal, not a second prompt.
      if ((e as { code?: number }).code !== 4902) return say("Network switch refused");
      try {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: HEX, chainName: CHAIN.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [CHAIN.rpc], blockExplorerUrls: [CHAIN.explorer] }],
        });
      } catch {
        return say(`${w.name} did not add ${CHAIN.name}`);
      }
    }
    setChainId(Number(await eth.request({ method: "eth_chainId" }).catch(() => null)));
  };

  const click = () => {
    if (wallets.length === 0) return say("No browser wallet found");
    if (!chosen || account) return setMenu((m) => !m);
    void connect(chosen);
  };

  const ready = account && chainId === CHAIN.id;
  const label = note ?? (!account ? "Connect wallet" : chainId !== CHAIN.id ? `Switch to ${CHAIN.name}` : short(account));
  return (
    <div className="nav__wallet" ref={box}>
      <button
        className="btn"
        type="button"
        onClick={account && !ready ? () => chosen && connect(chosen) : click}
        aria-expanded={menu}
        aria-live="polite"
        title={ready ? `${account} on ${CHAIN.name}` : undefined}
      >
        {label}
      </button>
      {menu && (
        <div className="nav__menu">
          {account && ready ? (
            <>
              <a href="#play" onClick={() => setMenu(false)}>
                Play
              </a>
              {wallets.length > 1 && (
                <button type="button" onClick={() => (pickWallet(null), setMenu(false))}>
                  Use another wallet
                </button>
              )}
            </>
          ) : (
            <WalletPicker wallets={wallets} onPick={(w) => void connect(w)} />
          )}
        </div>
      )}
    </div>
  );
}
