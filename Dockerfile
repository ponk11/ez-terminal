FROM node:24-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 docker.io openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV EZ_TERMINAL_MODE=docker
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000
CMD ["node", "server/index.js"]
