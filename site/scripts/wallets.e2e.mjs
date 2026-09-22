// Two wallets installed, Phantom holding window.ethereum (as it does in real browsers): the header must
// ask which one, never call Phantom behind the person's back, remember the pick, and after Phantom
// fails on Robinhood Chain offer the others again. Wallets are shims; no chain is involved.
// Usage: node wallets.e2e.mjs <siteUrl>   → prints one JSON line
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const PW = process.env.PLAYWRIGHT_MODULE ?? `${process.env.HOME}/.npm-global/lib/node_modules/playwright`;
const { chromium } = require(PW);
const [site] = process.argv.slice(2);
const b = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell`,
});
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
await p.addInitScript(() => {
  const mk = (name, extra) => {
    let chain = "0x1";
    const calls = (window.__calls ||= {})[name] = [];
    return { ...extra, on() {}, removeListener() {}, request: async ({ method, params }) => {
      calls.push(method);
      if (method === "eth_accounts") return window.__authed?.[name] ? ["0x1111111111111111111111111111111111112222"] : [];
      if (method === "eth_requestAccounts") return ((window.__authed ||= {})[name] = true), ["0x1111111111111111111111111111111111112222"];
      if (method === "eth_chainId") return chain;
      if (method === "wallet_switchEthereumChain") throw Object.assign(new Error("Unrecognized chain"), { code: 4902 });
      if (method === "wallet_addEthereumChain") return (chain = params[0].chainId), null;
      return null;
    } };
  };
  const phantom = mk("Phantom", { isPhantom: true });
  const mm = mk("MetaMask", { isMetaMask: true });
  window.ethereum = phantom;
  window.addEventListener("eip6963:requestProvider", () => {
    for (const [provider, name, rdns] of [[phantom, "Phantom", "app.phantom"], [mm, "MetaMask", "io.metamask"]])
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: rdns, name, icon: "", rdns }, provider } }));
  });
});
const out = {};
const btn = () => p.locator(".nav__wallet > button");
try {
  await p.goto(site, { waitUntil: "load" });
  await p.waitForTimeout(1200);
  await btn().click();
  out.picker = await p.locator(".nav__menu .walletpick__item").allInnerTexts();
  await p.locator(".nav__menu .walletpick__item", { hasText: "MetaMask" }).click();
  await p.waitForTimeout(500);
  out.afterPick = await btn().innerText();
  out.phantomCalls = await p.evaluate(() => window.__calls.Phantom.length);
  out.stored = await p.evaluate(() => localStorage.getItem("jsi.wallet"));
  await p.evaluate(() => localStorage.setItem("jsi.wallet", "app.phantom"));
  await p.reload({ waitUntil: "load" });
  await p.waitForTimeout(1200);
  await btn().click();
  await p.waitForTimeout(400);
  out.phantomNote = await btn().innerText();
  await p.waitForTimeout(6500);
  await btn().click();
  out.pickerAgain = await p.locator(".nav__menu .walletpick__item").allInnerTexts();
} catch (e) {
  out.error = String(e).slice(0, 300);
}
console.log(JSON.stringify(out));
await b.close();
