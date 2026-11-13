import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
    resolveAlias: {
      // Circle's wallet SDK imports the Node library `jsonwebtoken` and uses only `decode`, for social
      // login. The real library needs Node's `crypto` and `stream`, which a browser bundle does not have.
      jsonwebtoken: "./src/lib/jwt-shim.ts",
    },
  },
};

export default nextConfig;
