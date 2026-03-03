# syntax=docker/dockerfile:1

FROM node:20-alpine AS build

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN npx tsc

FROM node:20-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN apk add --no-cache ffmpeg

COPY package.json ./
RUN npm install --omit=dev

COPY --from=build /app/dist ./dist

ENTRYPOINT ["node", "dist/index.js"]
CMD []
