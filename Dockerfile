FROM node:18-alpine
WORKDIR /workspace
RUN mkdir -p /workspace/data || true && chmod 777 /workspace/data || true
COPY package.json ./
RUN npm install
COPY . .
RUN chmod 777 /workspace
CMD ["node", "bot.js"]
