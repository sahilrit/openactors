# The Playwright image is used rather than a plain Node base because
# maps/google-maps drives a real browser, and its system libraries are the
# tedious part to get right. The tag must track the playwright dependency in
# package.json: a mismatch between the bundled browsers and the client library
# fails at launch, not at build.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app
ENV NODE_ENV=production

# Dependencies are copied and installed before the source so that editing an
# Actor does not invalidate the install layer.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
COPY actors ./actors
COPY scripts ./scripts
RUN npx tsc && node scripts/copy-manifests.mjs

# Scraped results live here. Mount a volume to keep them across restarts.
VOLUME /app/storage

ENV PORT=8080
EXPOSE 8080

# The HTTP transport is the entry point: a container is only useful remotely,
# and stdio cannot cross a container boundary.
CMD ["node", "dist/src/http.js"]
