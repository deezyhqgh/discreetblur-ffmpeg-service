FROM node:20-bullseye-slim

# Install ffmpeg system binary (required - the npm "fluent-ffmpeg" package is just
# a wrapper, it does not include the actual ffmpeg binary)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Where temp files live during a job - cleaned up after each job
RUN mkdir -p /app/tmp

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
