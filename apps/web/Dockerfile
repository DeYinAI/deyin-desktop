# Deyin web image: static SPA + Node host-server.
# Build from the monorepo root:
#   docker build -f apps/web/Dockerfile \
#     --build-arg VITE_DEYIN_OAUTH_ISSUER=https://openference.com \
#     --build-arg VITE_DEYIN_CLIENT_ID=deyin-web \
#     -t deyin-web .
#
# Run:
#   docker run --rm -p 8790:8790 \
#     -e DEYIN_OAUTH_ISSUER=https://openference.com \
#     -e DEYIN_API_BASE_URL=https://api.openference.com/v1 \
#     deyin-web

FROM node:20-bookworm AS build

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages packages/
COPY apps/cli/package.json apps/cli/
COPY apps/desktop/package.json apps/desktop/
COPY native native/

RUN pnpm install --frozen-lockfile

ARG VITE_DEYIN_OAUTH_ISSUER=https://openference.com
ARG VITE_DEYIN_CLIENT_ID=deyin-web
ENV VITE_DEYIN_OAUTH_ISSUER=$VITE_DEYIN_OAUTH_ISSUER
ENV VITE_DEYIN_CLIENT_ID=$VITE_DEYIN_CLIENT_ID

RUN pnpm --filter @deyin/web... build

# --- runtime ---
FROM node:20-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8790
ENV DEYIN_OAUTH_ISSUER=https://openference.com
ENV DEYIN_API_BASE_URL=https://api.openference.com/v1

COPY --from=build /app/apps/web/dist ./dist
COPY --from=build /app/apps/web/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=build /app/packages ./packages

WORKDIR /app/dist/server

EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8790/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
