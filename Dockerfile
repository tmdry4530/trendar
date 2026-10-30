# --- build frontend ---
FROM node:22-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
# 프론트 타입 검사(tsc)가 백엔드와 공유하는 API 계약 타입(../shared)을 참조한다. 런타임 코드는 없음.
COPY shared/ /app/shared/
RUN npm run build

# --- backend + serve built frontend ---
FROM node:22-slim
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install --omit=dev
COPY backend/ ./
COPY --from=frontend /app/frontend/dist /app/frontend/dist
ENV NODE_ENV=production
CMD ["node", "src/server.js"]
