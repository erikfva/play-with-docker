FROM node:20-bullseye-slim

LABEL org.opencontainers.image.source="https://github.com/erikfva/vm-manager"

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    openssh-client \
    fuse \
    s3fs \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --only=production \
  && npm cache clean --force

COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && mkdir -p /mnt/s3 /var/log/s3fs \
  && touch /etc/fuse.conf \
  && ( grep -qxF "user_allow_other" /etc/fuse.conf || echo "user_allow_other" >> /etc/fuse.conf )

ENV NODE_ENV=production
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["npm", "start"]
