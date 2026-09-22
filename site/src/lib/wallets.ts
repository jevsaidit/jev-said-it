"use client";

// Which browser wallet the page talks to. With several extensions installed, window.ethereum belongs
// to whichever injected last (often Phantom, which cannot add Robinhood Chain), so the page listens
// to EIP-6963 announcements and lets the person pick; the pick is remembered in this browser.
// Shared by the header button and the play panel: one choice, not two. No viem here.
import { useSyncExternalStore } from "react";

export type Eip1193 = {
  request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (e: string, f: (...a: unknown[]) => void) => void;
  removeListener?: (e: string, f: (...a: unknown[]) => void) => void;
  isPhantom?: boolean;
  isRabby?: boolean;
  isMetaMask?: boolean;
};
export type Wallet = { id: string; name: string; icon: string | null; provider: Eip1193 };
type State = { searching: boolean; wallets: Wallet[]; pickedId: string | null };

const KEY = "jsi.wallet";
const SEARCH_MS = 600;
let state: State = { searching: true, wallets: [], pickedId: null };
const subs = new Set<() => void>();
let started = false;

const set = (s: Partial<State>) => {
  state = { ...state, ...s };
  subs.forEach((f) => f());
};

const injectedName = (p: Eip1193) => (p.isPhantom ? "Phantom" : p.isRabby ? "Rabby" : p.isMetaMask ? "MetaMask" : "Browser wallet");

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  try {
    set({ pickedId: window.localStorage.getItem(KEY) });
  } catch {}
  const add = (w: Wallet) => {
    if (!state.wallets.some((x) => x.id === w.id)) set({ wallets: [...state.wallets, w] });
  };
  window.addEventListener("eip6963:announceProvider", (e: Event) => {
    const d = (e as CustomEvent<{ info?: { uuid?: string; name?: string; icon?: string; rdns?: string }; provider?: Eip1193 }>).detail;
    if (!d?.provider) return;
    add({ id: d.info?.rdns || d.info?.uuid || d.info?.name || "eip6963", name: d.info?.name || "Wallet", icon: d.info?.icon || null, provider: d.provider });
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  // A wallet that does not announce itself is only reachable as window.ethereum: used when nobody announced.
  const injected = () => {
    const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
    if (eth && state.wallets.length === 0) add({ id: "injected", name: injectedName(eth), icon: null, provider: eth });
  };
  window.addEventListener("ethereum#initialized", injected);
  setTimeout(() => {
    injected();
    set({ searching: false });
  }, SEARCH_MS);
}

export function pickWallet(id: string | null) {
  try {
    if (id) window.localStorage.setItem(KEY, id);
    else window.localStorage.removeItem(KEY);
  } catch {}
  set({ pickedId: id });
}

const subscribe = (f: () => void) => {
  start();
  subs.add(f);
  return () => subs.delete(f);
};
const SERVER: State = { searching: true, wallets: [], pickedId: null };

/** `chosen`: undefined while looking, null when there is none or the person must pick among several. */
export function useWallets() {
  const s = useSyncExternalStore(subscribe, () => state, () => SERVER);
  const picked = s.wallets.find((w) => w.id === s.pickedId);
  const chosen = s.searching ? undefined : picked ?? (s.wallets.length === 1 ? s.wallets[0]! : null);
  return { wallets: s.wallets, chosen, searching: s.searching };
}

/** Phantom's EVM side cannot add a custom network: say so instead of a raw error. */
export const cannotAddChain = (w: Wallet | null | undefined) => !!w && (w.provider.isPhantom || /phantom/i.test(w.id));
