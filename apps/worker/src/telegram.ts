import type { SendTelegram } from "./jobs/notify.js";

const TIMEOUT_MS = 10_000;

function isApiResult(body: unknown): body is { ok: boolean; description?: string } {
  return typeof body === "object" && body !== null && "ok" in body;
}

/**
 * Bot API sendMessage, plain text. Link previews are disabled: a preview makes
 * Telegram fetch the listing page and show its photo (DECISIONS #007).
 * Error messages never include the request URL, which contains the token.
 */
export function createTelegramSender(botToken: string): SendTelegram {
  return async function sendTelegram(chatId, text) {
    let res: Response;
    try {
      res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          link_preview_options: { is_disabled: true },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`telegram sendMessage: ${err instanceof Error ? err.message : String(err)}`);
    }
    const body: unknown = await res.json().catch(() => undefined);
    if (res.ok && isApiResult(body) && body.ok) return;
    const description = isApiResult(body) && body.description ? ` ${body.description}` : "";
    throw new Error(`telegram sendMessage: HTTP ${res.status}${description}`);
  };
}
