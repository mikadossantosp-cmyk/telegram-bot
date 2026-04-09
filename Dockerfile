FROM node:18-alpine
WORKDIR /workspace
RUN mkdir -p /workspace/data
COPY package.json ./
RUN npm install
COPY . .
RUN chmod 777 /workspace/data
CMD ["node", "bot.js"]
