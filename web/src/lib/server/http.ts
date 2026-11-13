// Helpers for the route handlers under /api. Errors leave as `{ error: { code, message } }`, the same
// shape the keeper uses; `message` is written for the person using the page.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { clientOf, EVERY_ROUTE, take, type Rule } from "./limit";

export class Refusal extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const NOT_CHARGED = "The payment didn't go through. You were not charged.";

type Body = Record<string, unknown>;

const TOO_MANY = "That's a lot of requests at once. Try again in a minute.";

/**
 * Wraps a POST handler: counts the request against its limits, parses the JSON body and turns a thrown
 * `Refusal` into its response. `limit` is a route's own limit, on top of the one every route shares.
 */
export function post(
  run: (body: Body) => Promise<unknown>,
  limit?: { rule: Rule; message: string },
): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      // Before the body is read, so a request that is turned away costs nothing.
      const who = clientOf(request);
      if (take(EVERY_ROUTE, who) > 0) throw new Refusal(429, "too-many", TOO_MANY);
      if (limit && take(limit.rule, who) > 0) throw new Refusal(429, "too-many", limit.message);
      const body = (await request.json().catch(() => null)) as Body | null;
      if (body === null || typeof body !== "object") throw new Refusal(400, "bad-request", "The request was not understood.");
      return Response.json(await run(body));
    } catch (err) {
      if (err instanceof Refusal) {
        return Response.json({ error: { code: err.code, message: err.message } }, { status: err.status });
      }
      console.error("[api]", err);
      return Response.json(
        { error: { code: "internal", message: "Something went wrong on our side. Try again in a moment." } },
        { status: 500 },
      );
    }
  };
}

/** A required string field of the body. */
export function text(body: Body, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || value === "") throw new Refusal(400, "bad-request", `${name} is required.`);
  return value;
}

let secretsRead = false;

/**
 * A server setting. On Vercel it is a project variable. On a developer machine it is read from the
 * secrets file that lives outside the repo, the same file the keeper reads; nothing secret is kept
 * in this folder.
 */
export function env(name: string): string {
  if (!secretsRead) {
    secretsRead = true;
    const file = process.env.FREEIF_SECRETS ?? join(homedir(), ".freeif", "secrets.env");
    // Variables already set win over the file. The file is outside the project, so the bundler is
    // told not to follow it.
    if (existsSync(/* turbopackIgnore: true */ file)) process.loadEnvFile(/* turbopackIgnore: true */ file);
  }
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`Missing environment variable ${name}`);
  return value;
}
