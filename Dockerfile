FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 UELT_DB=/data/uelt.db
# За HTTPS-проксі (Caddy) прапорець Secure ставиться автоматично за заголовком X-Forwarded-Proto.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
