// Stands in for `jsonwebtoken` inside Circle's wallet SDK (see next.config.ts). The SDK calls `decode`
// on a social-login token, which FreeIf never uses: logins here are by email code.
export function decode(token: string): unknown {
  try {
    const payload = token.split(".")[1] ?? "";
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

const jwt = { decode };
export default jwt;
