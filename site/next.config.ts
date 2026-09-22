import type { NextConfig } from "next";

// A local-chain build (the e2e, never a real one) talks to anvil over http://127.0.0.1: the strict
// connect-src below would block that fetch and the whole wallet flow would fail for a reason that has
// nothing to do with the product. The loosening rides on the flag that already declares "this build
// knows the local chain", so a production build cannot get it by accident. Found by the e2e itself:
// the first run after the policy went live turned 18 wallet checks red.
const LOCAL_CHAIN = process.env.NEXT_PUBLIC_ALLOW_ANVIL === "1";
const CONNECT = ["'self'", "https:", "wss:", ...(LOCAL_CHAIN ? ["http://127.0.0.1:*", "http://localhost:*"] : [])].join(" ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          // This page asks people to sign transactions. A first visit over http, on a hostile
          // network, is the whole attack: HSTS removes the plaintext hop from the second visit on.
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          // The point of this policy is not inline script — Next's hydration needs it and a nonce
          // would have to be wired through the proxy. It is everything else: an injected
          // `<script src="somewhere-else">`, an <object>, a rewritten <base>, or a form posting a
          // signature somewhere, are all refused even if a dependency is compromised one day.
          // connect-src stays open on https/wss: the page reads the chain over public RPCs.
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self' data:",
              `connect-src ${CONNECT}`,
              "form-action 'self'",
              "base-uri 'self'",
              "object-src 'none'",
              "frame-ancestors 'none'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
