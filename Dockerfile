# Two published shapes from one file.
#
# The default (last) stage is the deployable image: production dependencies
# only, non-root, no test or build toolchain. The previous single-stage image
# ran `npm ci` with dev dependencies and never dropped them, so ts-jest's
# handlebars (critical) and jest's js-yaml/minimatch/picomatch (high) shipped in
# an image that never runs a test.
#
# The `dev` stage keeps the full toolchain. docker-compose.yml targets it,
# because CI runs `npm test` and `npm run smoke:revocations` inside the running
# container and that needs typescript, jest and tests/.

FROM node:20-bookworm AS base

WORKDIR /app

# The relay shells out to redis-cli when AIMTP_STORE=redis, so both stages need it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends redis-tools \
  && rm -rf /var/lib/apt/lists/*

# ---

FROM base AS dev

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 8787
CMD ["node", "dist/runtime/relay.js"]

# ---

FROM base AS runtime

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=dev /app/dist ./dist
COPY runtime ./runtime
COPY sdk ./sdk
COPY cli ./cli
COPY tools ./tools
COPY schemas ./schemas
COPY spec ./spec
COPY config ./config
COPY LICENSE LICENSING.md NOTICE TRADEMARKS.md ./
COPY LICENSES ./LICENSES

# Drop root. The relay and gateway bind ports above 1024 and write only under
# runtime/, so nothing here needs privilege.
RUN mkdir -p runtime && chown -R node:node /app
USER node

EXPOSE 8787
CMD ["node", "dist/runtime/relay.js"]
