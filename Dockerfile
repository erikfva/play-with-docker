FROM mcr.microsoft.com/playwright:v1.62.1-jammy

LABEL org.opencontainers.image.source="https://github.com/erikfva/vm-manager"

# Playwright base (Ubuntu 22.04 jammy) already ships Node 20, Chromium/Firefox/WebKit,
# their system deps, and xvfb. We keep the VM-manager additions on top.
# Pin to v1.51.1-jammy so Node stays on the 20.x line (original project base was node:20-bullseye-slim)
# and playwright-core 1.51.x matches the baked browsers. Bump both together when upgrading.

USER root

WORKDIR /app

ARG NODE_ENV=production

# Keep original play-with-docker deps + headless display support for scripts/get-codesandbox-credits.js (xvfb-run)
# s3fs/fuse/openssh-client/gh are required by the orchestrator (see ai/project-overview.md and docker-entrypoint.sh)
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
    xvfb \
  && mkdir -p /usr/share/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
     | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
     | tee /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && gh --version \
  && xvfb-run --help >/dev/null 2>&1 || true \
  && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0
# VPS Cloudflare bypass needs realistic locale/timezone + headed Chromium via xvfb
ENV TZ=UTC
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

COPY package.json package-lock.json* ./
RUN if [ "$NODE_ENV" = "local" ]; then \
      npm install; \
    else \
      npm install --only=production; \
    fi \
  && npm cache clean --force

# Ensure Chromium/Chrome match the installed playwright-core version.
# Base image ships browsers at $PLAYWRIGHT_BROWSERS_PATH (/ms-playwright), but
# npm may expect a different revision. Install for the *local* version (from package.json)
# not a pinned 1.51.1, so GH Actions image and VPS container both resolve.
# Install both chromium and chrome (chrome channel is more trusted by Cloudflare).
RUN npx playwright install --with-deps chromium chrome 2>&1 | tail -30 \
  || npx --yes playwright install --with-deps chromium chrome 2>&1 | tail -30 \
  || echo "playwright install fallback: browsers already present at $PLAYWRIGHT_BROWSERS_PATH" \
  && ls -R /ms-playwright 2>&1 | head -n 120 || true \
  && ls -R /root/.cache/ms-playwright 2>&1 | head -n 30 || true \
  && npx playwright --version 2>&1 | head -5; node -e "console.log(require('playwright-core/package.json').version, require('playwright-core').chromium.executablePath())" 2>&1 | head -5

COPY src ./src
COPY scripts ./scripts
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && mkdir -p /mnt/s3 /mnt/s3/github /var/log/s3fs \
  && touch /etc/fuse.conf \
  && ( grep -qxF "user_allow_other" /etc/fuse.conf || echo "user_allow_other" >> /etc/fuse.conf )

ENV NODE_ENV=$NODE_ENV
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["npm", "start"]
