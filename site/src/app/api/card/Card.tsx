import type { ReactNode } from "react";
import { C } from "@/lib/cards";

// The receipt, 1200x630 (X's large card). Rendered by next/og, which only knows flexbox:
// every element with more than one child declares display:flex.

export function Card({ mascot, children, footer }: { mascot: string; children: ReactNode; footer: string }) {
  return (
    <div style={{ width: 1200, height: 630, display: "flex", background: C.ink, padding: 28, fontFamily: "Mono" }}>
      <div style={{ flex: 1, display: "flex", border: `4px solid ${C.line}`, background: C.felt, padding: "44px 52px", gap: 48 }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={mascot} width={300} height={300} alt="" />
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
          <div style={{ display: "flex", fontSize: 24, color: C.dim }}>{footer}</div>
        </div>
      </div>
    </div>
  );
}

export const Label = ({ children }: { children: ReactNode }) => (
  <div style={{ display: "flex", fontSize: 26, color: C.dim, letterSpacing: 1 }}>{children}</div>
);
export const Big = ({ children, color }: { children: ReactNode; color: string }) => (
  <div style={{ display: "flex", fontFamily: "Pixel", fontSize: 104, lineHeight: 1, color }}>{children}</div>
);
export const Mid = ({ children, color }: { children: ReactNode; color: string }) => (
  <div style={{ display: "flex", fontFamily: "Pixel", fontSize: 60, lineHeight: 1.05, color }}>{children}</div>
);
export const Line = ({ children, color = C.mint }: { children: ReactNode; color?: string }) => (
  <div style={{ display: "flex", fontSize: 30, fontWeight: 600, color }}>{children}</div>
);
