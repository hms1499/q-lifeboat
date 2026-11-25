# Q-Lifeboat hosted service: the built dashboard, diana REST/RPC proxies, starter packs, and one agent per owner.
#
# Build from the repo root, AFTER `cd contracts && forge build` (the dashboard bundles the GuardianVault artifact;
# Foundry is not in the image):
#   docker build -f apps/hosted/Dockerfile -t qlifeboat-hosted .
# Run with a persistent volume for owner state and secrets, and the secrets as env (never baked in):
#   docker run -p 8080:8080 -v qlifeboat-data:/data \
#     -e FUNDER_MNEMONIC=… -e FUSD_ADDRESS=… -e FETH_ADDRESS=… -e FBTC_ADDRESS=… [-e TRUST_PROXY=1] qlifeboat-hosted
FROM node:22-slim

ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable

WORKDIR /app
# Manifests first, so a source change does not reinstall every dependency.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/agent/package.json apps/agent/
COPY apps/cli/package.json apps/cli/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/hosted/package.json apps/hosted/
# Dev dependencies stay: the service and every agent run TypeScript through tsx.
RUN pnpm install --frozen-lockfile

COPY . .
RUN test -f contracts/out/GuardianVault.sol/GuardianVault.json \
      || (echo "contracts/out is missing: run 'cd contracts && forge build' before docker build" && exit 1) \
  && VITE_HOSTED=1 pnpm -F dashboard build

# Owner state, guardian secrets (mode 0600) and incidents live on the volume, outside the image.
RUN mkdir -p /data /app/data && chown node:node /data /app/data
USER node
ENV NODE_ENV=production PORT=8080 HOSTED_DATA_DIR=/data DASHBOARD_DIST=/app/apps/dashboard/dist
VOLUME ["/data"]
EXPOSE 8080
WORKDIR /app/apps/hosted
CMD ["node", "--import", "tsx", "src/index.ts"]
