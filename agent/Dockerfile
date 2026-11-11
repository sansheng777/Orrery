# Built from the repository root (see deploy/docker-compose.yml) so the image carries the agent and the
# provider modules in providers/ (npm workspaces). The root .dockerignore keeps everything else,
# including deploy/data and .env, out of the build context.
# Debian bookworm, not the floating node:22-alpine: Alpine 3.24's OpenSSH 10.3p1 client segfaults when
# logging in with an OpenSSH certificate, which is how onboarding reaches Lightsail. Bookworm keeps
# OpenSSH on the 9.2p1 line for its whole lifetime.
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY agent/package.json agent/
COPY providers/aws/package.json providers/aws/
COPY providers/netcup/package.json providers/netcup/
COPY providers/linode/package.json providers/linode/
COPY providers/gcp/package.json providers/gcp/
COPY providers/aliyun/package.json providers/aliyun/
COPY providers/vultr/package.json providers/vultr/
COPY providers/digitalocean/package.json providers/digitalocean/
COPY providers/kamatera/package.json providers/kamatera/
RUN npm ci --omit=dev --no-audit --no-fund
COPY agent/src agent/src
COPY providers/aws/*.js providers/aws/
COPY providers/netcup/*.js providers/netcup/
COPY providers/linode/*.js providers/linode/
COPY providers/gcp/*.js providers/gcp/
COPY providers/aliyun/*.js providers/aliyun/
COPY providers/vultr/*.js providers/vultr/
COPY providers/digitalocean/*.js providers/digitalocean/
COPY providers/kamatera/*.js providers/kamatera/
WORKDIR /app/agent
ENV HOST=0.0.0.0 PORT=8787 ORRERY_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "src/index.js", "--http"]
