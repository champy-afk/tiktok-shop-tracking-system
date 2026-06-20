FROM node:22-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

EXPOSE 3010

CMD ["npm", "start"]
