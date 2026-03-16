FROM node:20-bullseye-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    openssh-client \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
