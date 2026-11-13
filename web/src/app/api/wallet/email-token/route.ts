// Step 1 of a login: Circle emails a 6-digit code to the address and returns the tokens the browser's
// SDK needs to check it. The code is typed into Circle's own window, never into this app.
import { randomUUID } from "node:crypto";
import { circle } from "@/lib/server/circle";
import { post, Refusal, text } from "@/lib/server/http";
import { LOGIN_CODES } from "@/lib/server/limit";

type Tokens = { deviceToken: string; deviceEncryptionKey: string; otpToken: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const POST = post(async (body) => {
  const deviceId = text(body, "deviceId");
  const email = text(body, "email").trim();
  if (!EMAIL.test(email)) throw new Refusal(400, "email", "That email address doesn't look right.");

  const reply = await circle<Tokens>("POST", "/users/email/token", {
    body: { idempotencyKey: randomUUID(), deviceId, email },
  });
  const tokens = reply.data;
  if (!tokens?.deviceToken || !tokens.otpToken) {
    console.error("[email-token]", reply.status, reply.code, reply.message);
    if (reply.code === 155135) throw new Refusal(400, "email", "That email address doesn't look right.");
    if (reply.code === 155142) {
      throw new Refusal(429, "too-many", "Too many codes were sent to this email. Try again in a few minutes.");
    }
    throw new Refusal(502, "no-code", "We couldn't send a code right now. Try again in a moment.");
  }
  return { deviceToken: tokens.deviceToken, deviceEncryptionKey: tokens.deviceEncryptionKey, otpToken: tokens.otpToken };
}, { rule: LOGIN_CODES, message: "Too many codes were asked for from this connection. Try again in a few minutes." });
