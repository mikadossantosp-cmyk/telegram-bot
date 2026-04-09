FROM node:18-alpine
WORKDIR /workspace
COPY package.json ./
RUN npm install
COPY . .
RUN chmod 777 /workspace
CMD ["node", "bot.js"]
