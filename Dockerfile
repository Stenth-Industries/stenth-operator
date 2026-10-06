# STENTH Operator V1.1 (SPEC.md §20).
#
# One Dockerfile, two targets: "web" runs the Next.js standalone server, "tools"
# runs the migration step and any other script. Node 22 LTS, one runtime for the
# app and the worker.

# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# --- dependencies -------------------------------------------------------------
#
# The npm_ca secret is optional and exists for networks that terminate TLS on
# an inspecting proxy, where the registry presents a certificate the base image
# does not trust. Pass the proxy's CA bundle and npm trusts it for the install
# only; the certificate never reaches a published layer. On a normal network,
# and in production, nothing is passed and nothing changes.
FROM base AS deps
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=npm_ca,target=/tmp/npm-ca.crt,required=false \
    if [ -s /tmp/npm-ca.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/npm-ca.crt; fi; \
    npm ci --no-audit --no-fund

# --- build --------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- tools: the migration step (§20 "docker compose run --rm migrate") --------
#
# --chown=node:node on every COPY into a target that later runs as USER node.
#
# COPY preserves the host's file modes and only normalises the destination
# directory, so a checkout made under a leaked `umask 077` arrives as 600 files
# inside 700 nested directories, owned by root — and the non-root runtime user
# cannot traverse or read its own application. That reached production once.
# Giving the files to node makes the owner bits the ones that apply, so 600
# becomes "node can read it" and 700 "node can traverse it", and the image no
# longer depends on the permissions of whoever ran git. The runbook's pre-build
# checks stay as defence in depth; this removes the dependency.
#
# Not --chmod=0755: that would make every source file executable, which is a
# wider change than the problem needs.
FROM base AS tools
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node src ./src
USER node
CMD ["npm", "run", "migrate"]

# --- worker: the claim loop, the scheduler and the reaper (§6, §19) -----------
#
# Shares the tools stage's shape — it runs TypeScript directly through tsx, like
# the migration step — so there is one runtime for the app and the worker and no
# second build pipeline to keep in step.
FROM base AS worker
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node src ./src
USER node
CMD ["npx", "tsx", "src/worker/index.ts"]

# --- fetcher: the one process that touches hostile input (§8, §20) ------------
#
# Deliberately the same shape as the others and deliberately the narrowest
# runtime: it is handed no model key, no mail credential, and a database URL for
# operator_fetch. It publishes no host port — compose gives it none — and it
# refuses to start if a model key appears in its environment.
FROM base AS fetcher
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node src ./src
USER node
EXPOSE 8081
CMD ["npx", "tsx", "src/fetcher/server.ts"]

# --- web ----------------------------------------------------------------------
FROM base AS web
ENV NODE_ENV=production
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
COPY --from=build /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
