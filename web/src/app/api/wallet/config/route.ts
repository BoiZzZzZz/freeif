// What the browser needs to start Circle's wallet SDK. The app id is not a secret.
import { connection } from "next/server";
import { env } from "@/lib/server/http";

export async function GET() {
  // Answered per request, so the id is never frozen into a build.
  await connection();
  return Response.json({ appId: env("CIRCLE_APP_ID") });
}
