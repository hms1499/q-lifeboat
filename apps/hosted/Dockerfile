# Placeholder: Task 12 finishes it. Build from the repo root: docker build -f apps/hosted/Dockerfile .
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && (cd contracts && true) && pnpm -F dashboard build
ENV PORT=8080 HOSTED_DATA_DIR=/data DASHBOARD_DIST=/app/apps/dashboard/dist
EXPOSE 8080
CMD ["pnpm", "-F", "hosted", "start"]
