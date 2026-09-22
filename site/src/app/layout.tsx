import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { SITE_URL, TICKER } from "@/lib/site";
import "./globals.css";

// Self-hosted (OFL, latin subset, variable weight): the build must not depend on reaching Google Fonts,
// which failed two Railway builds out of four on 21/09.
const pixel = localFont({ src: "./fonts/PixelifySans.woff2", weight: "400 700", variable: "--font-pixel", display: "swap" });
const body = localFont({ src: "./fonts/AtkinsonHyperlegibleNext.woff2", weight: "200 800", variable: "--font-body", display: "swap" });
// Used below the fold only (hashes, data): not worth a preload in the critical path.
const mono = localFont({ src: "./fonts/MartianMono.woff2", weight: "100 800", variable: "--font-mono", display: "swap", preload: false });

const description =
  "Every 6 hours a model commits a probability on-chain before anyone answers. Holders agree or disagree. Calibrated calls get paid from trading fees. On Robinhood Chain.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: `Jev Said It ($${TICKER})`,
  description,
  alternates: { canonical: "/" },
  openGraph: {
    title: `Jev Said It ($${TICKER})`,
    description,
    url: SITE_URL,
    siteName: "Jev Said It",
    images: [{ url: "/brand/og-jev-1200x630.png", width: 1200, height: 630, alt: "Jev Said It: the pixel-art mascot with laser eyes says \"so I aped\", over pumping green candles" }],
    type: "website",
  },
  twitter: { card: "summary_large_image", site: "@jevsaidit", creator: "@jevsaidit", title: `Jev Said It ($${TICKER})`, description, images: ["/brand/og-jev-1200x630.png"] },
};

export const viewport: Viewport = { themeColor: "#07120B", colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${pixel.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
