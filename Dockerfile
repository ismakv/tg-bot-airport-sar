# Используем небольшой официальный Node-образ
FROM node:20-alpine

# 1. Создаём рабочую папку
WORKDIR /app

# 2. Кэшируем зависимости
COPY package*.json ./
RUN npm ci --production

# 3. Копируем исходники бота
COPY . .

# 4. Точка входа
CMD ["node", "index.js"]
