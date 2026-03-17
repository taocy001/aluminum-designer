FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache libc6-compat
EXPOSE 5173
CMD ["sh", "-c", "npm install && npm run dev -- --host"]
