FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations

ENV NODE_ENV=production
EXPOSE 8787

# 用内置的 strip-types 直接跑 TS，省一个构建步骤
CMD ["node", "--experimental-strip-types", "src/index.ts"]
