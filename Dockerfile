# ── Stage 1: deps ────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

COPY package*.json ./
# ci = clean install, respects package-lock.json, no devDeps in prod
RUN npm ci --omit=dev

# ── Stage 2: production image ─────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

# Create non-root user for security
RUN addgroup -S nightcrawlers && adduser -S nightcrawlers -G nightcrawlers

# Copy deps from stage 1
COPY --from=deps /app/node_modules ./node_modules

# Copy source (respects .dockerignore)
COPY . .

# Own the app directory
RUN chown -R nightcrawlers:nightcrawlers /app

USER nightcrawlers

EXPOSE 5000

ENV NODE_ENV=production
ENV PORT=5000

# Healthcheck — hits the root status endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:5000/ || exit 1

CMD ["node", "server.js"]
