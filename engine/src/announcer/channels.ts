import { forX, postTweet, type XCreds } from "./x.js";

export type Channel = "telegram" | "x";

export interface Sender {
  /** false = the channel has no credentials: its posts are recorded as unconfigured, not attempted */
  has(channel: Channel): boolean;
  send(channel: Channel, text: string): Promise<void>;
}

/** The request may have been delivered although no answer came back in time: a retry would post twice. */
export class DeliveryUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryUnknownError";
  }
}

async function telegram(token: string, chatId: string, text: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    if ((e as Error).name === "TimeoutError" || (e as Error).name === "AbortError") throw new DeliveryUnknownError(`telegram: no answer in 15s`);
    throw e;
  }
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!res.ok || !body.ok) throw new Error(`telegram ${res.status}: ${body.description ?? "no body"}`);
}

/** test: every post, both channels' versions, to one private chat. live: the real channels. */
export function makeSender(mode: "test" | "live", env: { tgToken: string; tgChannel?: string; tgTestChat?: string; x?: XCreds | null }): Sender {
  return {
    has(channel) {
      if (mode === "test") return !!env.tgTestChat;
      return channel === "telegram" ? !!env.tgChannel : !!env.x;
    },
    async send(channel, text) {
      if (mode === "test") {
        if (!env.tgTestChat) throw new Error("TELEGRAM_TEST_CHAT_ID not set");
        return telegram(env.tgToken, env.tgTestChat, `[TEST · ${channel}]\n\n${text}`);
      }
      if (channel === "telegram") {
        if (!env.tgChannel) throw new Error("TELEGRAM_CHANNEL_ID not set");
        return telegram(env.tgToken, env.tgChannel, text);
      }
      if (!env.x) throw new Error("X credentials not set");
      try {
        await postTweet(env.x, forX(text));
      } catch (e) {
        if ((e as Error).name === "TimeoutError" || (e as Error).name === "AbortError") throw new DeliveryUnknownError("x: no answer in 15s");
        throw e;
      }
    },
  };
}
