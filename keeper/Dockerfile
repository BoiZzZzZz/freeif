# The keeper as one container. Node 24 runs the TypeScript directly, so there is no build step.
FROM node:24-slim
WORKDIR /app
RUN npm install -g pnpm@12.15.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY src ./src
ENV NODE_ENV=production
# The host sets PORT. KEEPER_DATA_DIR should point at a volume so the keeper's file survives a redeploy.
CMD ["node", "src/main.ts"]
