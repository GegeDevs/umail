FROM oven/bun:1-alpine AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

FROM oven/bun:1-alpine
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

COPY --from=build /app/dist ./dist
COPY src ./src

EXPOSE 3000
ENV NODE_ENV=production
ENV PORT=3000

VOLUME ["/app/data"]

CMD ["bun", "src/local.js"]
