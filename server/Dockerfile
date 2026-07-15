# One image, many roles. Compose overrides `command` to run api / realtime /
# each worker / loadgen from this same build. We run TypeScript directly with
# tsx (no build step) to keep the demo friction-free and the source legible.
FROM node:22-slim

WORKDIR /app

# Install deps first for layer caching.
COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
# default role; overridden per service in docker-compose
CMD ["npm", "run", "api"]
