FROM node:20-alpine

# Install build tools needed for better-sqlite3 native compilation, plus su-exec for the
# entrypoint's root->unprivileged-user handoff (see docker-entrypoint.sh)
RUN apk add --no-cache python3 make g++ su-exec

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

# Data directory for SQLite volume mount, plus a non-root user to run the app as — the
# entrypoint chowns this directory at boot (covering both fresh and pre-existing volumes) before
# dropping to this user, so the node process itself never runs as root.
RUN mkdir -p /app/data && \
    addgroup -S jobtracker && adduser -S jobtracker -G jobtracker

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
