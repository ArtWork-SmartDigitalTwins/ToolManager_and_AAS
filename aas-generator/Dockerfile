FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY lib ./lib
COPY public ./public
COPY server.js ./

ENV HOST=0.0.0.0
EXPOSE 4100
CMD ["node", "server.js"]
