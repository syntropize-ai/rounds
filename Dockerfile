FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.base.json vitest.config.ts ./
COPY bin ./bin
COPY packages ./packages

RUN npm ci
RUN npm run build
RUN npm prune --omit=dev --workspaces --include-workspace-root

FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/var/lib/openobs

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages

VOLUME ["/var/lib/openobs"]

EXPOSE 3000

CMD ["node", "packages/api-gateway/dist/main.js"]
