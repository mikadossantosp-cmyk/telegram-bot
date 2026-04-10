FROM node:18-alpine
WORKDIR /workspace
RUN mkdir -p /workspace/data && chmod 777 /workspace/data
COPY package.json ./
RUN npm install
COPY . .
RUN chmod 777 /workspace
CMD ["node", "bot.js"]
