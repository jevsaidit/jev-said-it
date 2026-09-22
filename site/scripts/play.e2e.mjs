// Drives the play panel in a real browser. The wallet is a tiny EIP-1193 shim that forwards to anvil,
// whose dev accounts are unlocked: every click below ends in a real transaction on the local chain.
// Usage: node play.e2e.mjs <siteUrl> <rpcUrl> <account> <step>
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const PW = process.env.PLAYWRIGHT_MODULE ?? `${process.env.HOME}/.npm-global/lib/node_modules/playwright`;
const { chromium } = require(PW);

const [site, rpc, account, step] = process.argv.slice(2);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell`,
});
const page = await browser.newPage();
await page.addInitScript(
  ({ rpc, account, reject }) => {
    let id = 0;
    const call = async (method, params = []) => {
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      const j = await r.json();
      if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
      return j.result;
    };
    window.ethereum = {
      request: async ({ method, params }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
        // The "reject" step: the person presses Reject in the wallet (EIP-1193 code 4001).
        if (reject && method === "eth_sendTransaction") throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        return call(method, params);
      },
      on() {},
      removeListener() {},
    };
  },
  { rpc, account, reject: step === "reject" },
);

const out = {};
const text = async () => (await page.locator(".play").innerText()).replace(/\s+/g, " ");
try {
  await page.goto(`${site}/#play`, { waitUntil: "networkidle" });
  const connect = page.getByRole("button", { name: "Connect wallet" });
  if (await connect.count()) await connect.click();
  await page.locator(".play__stats").waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector(".play__stats")?.textContent?.includes("—"), null, { timeout: 20_000 });
  out.before = await text();

  if (step === "call") {
    const rows = page.locator(".play__q");
    out.questions = await rows.count();
    for (let i = 0; i < out.questions; i++) {
      // The test market: token …0002 goes down, …0001 and …0003 go up. Pick by token, not by row order.
      const down = (await rows.nth(i).innerText()).includes("…0002");
      await rows.nth(i).getByRole("button", { name: down ? "Disagree" : "Agree", exact: true }).click();
    }
    out.submitLabel = await page.locator(".play > .btn").innerText();
    await page.locator(".play > .btn").click();
    await page.locator(".play__tx").filter({ hasText: /Confirmed on-chain|revert|error/i }).waitFor({ timeout: 30_000 });
    out.tx = (await page.locator(".play__tx").innerText()).trim();
    out.hash = await page.locator(".play__tx").getAttribute("data-tx");
    await page.waitForFunction(() => document.querySelectorAll(".play__done").length > 0, null, { timeout: 20_000 });
    out.after = await text();
    out.share = await page.locator(".play__share a").evaluateAll((as) => as.map((a) => a.href));
  }
  if (step === "late") {
    out.submitDisabled = await page.locator(".play > .btn").isDisabled();
    out.agreeDisabled = await page.locator(".play__pick button").first().isDisabled();
  }
  if (step === "reject") {
    await page.locator(".play__q").first().getByRole("button", { name: "Agree", exact: true }).click();
    await page.locator(".play > .btn").click();
    await page.locator(".play__tx").filter({ hasText: /rejected|revert|error/i }).waitFor({ timeout: 30_000 });
    out.tx = (await page.locator(".play__tx").innerText()).trim();
    out.hash = await page.locator(".play__tx").getAttribute("data-tx");
  }
  if (step === "claim") {
    const btn = page.locator(".play__claims").getByRole("button", { name: "Claim" });
    await btn.waitFor({ timeout: 20_000 });
    await btn.click();
    await page.locator(".play__tx").filter({ hasText: /Confirmed on-chain|revert|error/i }).waitFor({ timeout: 30_000 });
    out.tx = (await page.locator(".play__tx").innerText()).trim();
    await page.locator(".play__claims .play__done").waitFor({ timeout: 20_000 });
    out.after = await text();
    out.share = await page.locator(".play__share a").evaluateAll((as) => as.map((a) => a.href));
  }
} catch (e) {
  out.error = String(e).split("\n")[0];
  out.panel = await text().catch(() => "");
}
await page.screenshot({ path: process.env.SHOT ?? `/tmp/play-${step}.png`, fullPage: false }).catch(() => {});
await browser.close();
console.log(JSON.stringify(out));
