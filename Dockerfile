FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache dumb-init wget

COPY package*.json ./
RUN npm ci --only=production

COPY . .

RUN mkdir -p logs uploads data

EXPOSE 5000 5001 5002 5003 5004

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q --spider http://localhost:5000/api/health/ready || exit 1

USER node

ENTRYPOINT ["dumb-init", "--"]

CMD ["node", "server.js"]
