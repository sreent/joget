# syntax=docker/dockerfile:1
# The platform API image. Build from the repository root:
#   docker build -f apps/api/Dockerfile -t platform-api .
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /repo
RUN corepack enable
# Install dependencies first, so this layer is cached until a manifest or the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/authz/package.json packages/authz/
COPY packages/audit/package.json packages/audit/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm turbo run build --filter=@platform/api... \
 && pnpm --filter=@platform/api deploy --prod --legacy /out

FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
# Runs as a non-root user and needs no writable filesystem, so it fits the Kubernetes
# "restricted" Pod Security Standard with readOnlyRootFilesystem: true.
USER node
EXPOSE 3000
CMD ["node", "--import", "./dist/telemetry.js", "dist/main.js"]
