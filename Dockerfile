FROM node:18-alpine
WORKDIR /workspace
COPY package.json ./
RUN npm install
COPY . .
CMD ["node", "bot.js"]
