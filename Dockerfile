# STENTH Operator V1.1 (SPEC.md §20).
#
# One Dockerfile, two targets: "web" runs the Next.js standalone server, "tools"
# runs the migration step and any other script. Node 22 LTS, one runtime for the
# app and the worker.

FROM node:22-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# --- dependencies -------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# --- build --------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- tools: the migration step (§20 "docker compose run --rm migrate") --------
FROM base AS tools
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY migrations ./migrations
COPY src ./src
USER node
CMD ["npm", "run", "migrate"]

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
