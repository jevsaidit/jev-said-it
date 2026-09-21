export type Channel = "telegram" | "x";

export interface Sender {
  send(channel: Channel, text: string): Promise<void>;
}

async function telegram(token: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!res.ok || !body.ok) throw new Error(`telegram ${res.status}: ${body.description ?? "no body"}`);
}

/** test: every post, both channels' versions, to one private chat. live: the real channels. */
export function makeSender(mode: "test" | "live", env: { tgToken: string; tgChannel?: string; tgTestChat?: string }): Sender {
  return {
    async send(channel, text) {
      if (mode === "test") {
        if (!env.tgTestChat) throw new Error("TELEGRAM_TEST_CHAT_ID not set");
        return telegram(env.tgToken, env.tgTestChat, `[TEST · ${channel}]\n\n${text}`);
      }
      if (channel === "telegram") {
        if (!env.tgChannel) throw new Error("TELEGRAM_CHANNEL_ID not set");
        return telegram(env.tgToken, env.tgChannel, text);
      }
      throw new Error("x: not configured yet");
    },
  };
}
