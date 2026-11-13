# syntax=docker/dockerfile:1
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# test: `docker compose run --rm payments-test` (needs the test-db service)
FROM deps AS test
COPY src ./src
COPY test ./test
ENV NODE_ENV=test
CMD ["npm", "test"]

FROM node:20-slim AS runtime
ENV NODE_ENV=production PORT=4002
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
EXPOSE 4002
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:4002/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "--import", "./src/otel.js", "src/server.js"]
