FROM node:20-slim

# Workspace root lives at /workspace (= repo root).  All npm workspace
# members (app, app/packages/*, scripts) are installed from here.
WORKDIR /workspace

# Copy root manifest + lockfile first for layer-cache-efficient installs.
COPY package.json package-lock.json ./

# Copy every workspace member's package.json so npm ci can resolve them.
COPY app/package.json app/
COPY app/packages/shared/package.json app/packages/shared/
COPY app/packages/desktop-main/package.json app/packages/desktop-main/
COPY app/packages/web/package.json app/packages/web/
COPY app/packages/lambda/interactions/package.json app/packages/lambda/interactions/
COPY app/packages/lambda/followup/package.json app/packages/lambda/followup/
COPY app/packages/lambda/update-dns/package.json app/packages/lambda/update-dns/
COPY app/packages/lambda/watchdog/package.json app/packages/lambda/watchdog/
COPY app/packages/lambda/efs-seeder/package.json app/packages/lambda/efs-seeder/

COPY scripts/package.json scripts/

RUN npm ci --ignore-scripts

# Copy source and build the server + web bundle for the management app. The
# Lambda packages are NOT built here — they are bundled and deployed by
# `terraform apply` (see `setup.sh`) and have no place inside the container.
COPY app/ app/
RUN npm run build -w game-server-manager

WORKDIR /workspace/app

EXPOSE 3001

ENV NODE_ENV=production

CMD ["node", "packages/desktop-main/dist/main.js"]
