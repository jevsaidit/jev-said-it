"use client";

import { pickWallet, type Wallet } from "@/lib/wallets";

/** The installed wallets, one button each. Picking one remembers it and hands it back. */
export function WalletPicker({ wallets, onPick }: { wallets: Wallet[]; onPick?: (w: Wallet) => void }) {
  return (
    <ul className="walletpick" aria-label="Choose a wallet">
      {wallets.map((w) => (
        <li key={w.id}>
          <button
            className="walletpick__item"
            type="button"
            onClick={() => {
              pickWallet(w.id);
              onPick?.(w);
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {w.icon ? <img src={w.icon} alt="" width={22} height={22} /> : <span className="walletpick__dot" aria-hidden="true" />}
            {w.name}
          </button>
        </li>
      ))}
    </ul>
  );
}
