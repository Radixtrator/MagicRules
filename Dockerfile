# Build the frontend, then ship a small image that runs the server with Node's
# built-in TypeScript support (Node 22.18+ / 24 strip types natively).

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server.ts rules.txt ./
COPY server ./server
# Bake in Scryfall's card-name list so cold starts don't wait on the network.
RUN node -e "import('./server/cardNames.ts').then((m) => m.loadCardNames())" && chown -R node:node .cache
USER node
# Cloud Run and most hosts set PORT; 8080 is the default otherwise.
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.ts"]
