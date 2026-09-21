import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible_Next, Martian_Mono, Pixelify_Sans } from "next/font/google";
import { SITE_URL, TICKER } from "@/lib/site";
import "./globals.css";

const pixel = Pixelify_Sans({ subsets: ["latin"], weight: ["500", "700"], variable: "--font-pixel" });
const body = Atkinson_Hyperlegible_Next({ subsets: ["latin"], weight: ["400", "500", "700"], variable: "--font-body" });
const mono = Martian_Mono({ subsets: ["latin"], weight: ["400", "600"], variable: "--font-mono" });

const description =
  "Every 6 hours a model commits a probability on-chain before anyone answers. Holders agree or disagree. Calibrated calls get paid from trading fees. On Robinhood Chain.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: `Jev Said It ($${TICKER})`,
  description,
  openGraph: {
    title: "Jev Said It",
    description,
    url: SITE_URL,
    siteName: "Jev Said It",
    images: [{ url: "/brand/og-1200x630.png", width: 1200, height: 630, alt: "Jev Said It: a verdict receipt stamped MATCH, next to the pixel-art mascot" }],
    type: "website",
  },
  twitter: { card: "summary_large_image", site: "@jevsaidit", title: "Jev Said It", description, images: ["/brand/og-1200x630.png"] },
};

export const viewport: Viewport = { themeColor: "#07120B", colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${pixel.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
