FROM node:18-alpine
WORKDIR /workspace
COPY package.json ./
RUN npm install
COPY . .
RUN node patch-bot.cjs
RUN mkdir -p /workspace/data && chmod 777 /workspace/data
CMD ["node", "bot.js"]
