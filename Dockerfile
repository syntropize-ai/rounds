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

# kubectl is required by the Kubernetes ops connector (spawned as a child
# process). Pinned to a stable minor; bump alongside cluster version skew.
ARG KUBECTL_VERSION=v1.31.4
RUN apk add --no-cache curl ca-certificates \
    && ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/') \
    && curl -fsSL -o /usr/local/bin/kubectl \
        "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl" \
    && chmod +x /usr/local/bin/kubectl \
    && apk del curl

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
