FROM node:20-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/erikfva/vm-manager"

WORKDIR /app

ARG NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    openssh-client \
    fuse \
    s3fs \
    ca-certificates \
    curl \
    gnupg \
  && mkdir -p /usr/share/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
     | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
     | tee /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && gh --version \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN if [ "$NODE_ENV" = "local" ]; then \
      npm install; \
    else \
      npm install --only=production; \
    fi \
  && npm cache clean --force

COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && mkdir -p /mnt/s3 /var/log/s3fs \
  && touch /etc/fuse.conf \
  && ( grep -qxF "user_allow_other" /etc/fuse.conf || echo "user_allow_other" >> /etc/fuse.conf )

ENV NODE_ENV=$NODE_ENV
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["npm", "start"]
