FROM node:20-alpine

# Install build tools needed for better-sqlite3 native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

# Data directory for SQLite volume mount
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "server.js"]
