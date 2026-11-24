# --- build frontend ---
FROM node:22-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
# 프론트 타입 검사(tsc)가 백엔드와 공유하는 API 계약 타입(../shared)을 참조한다. 런타임 코드는 없음.
COPY shared/ /app/shared/
RUN npm run build

# --- build Rust security engine (NAPI-RS native addon + standalone CLI) ---
FROM rust:1.88-slim AS engine
WORKDIR /app
COPY rules/ /app/rules/
COPY security-engine/ /app/security-engine/
RUN cargo build --release --manifest-path /app/security-engine/Cargo.toml

# --- backend + serve built frontend ---
FROM node:22-slim
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install --omit=dev
COPY backend/ ./
COPY rules/ /app/rules/
COPY --from=engine /app/security-engine/target/release/libtrendar_engine_napi.so /app/backend/native/trendar_engine.node
COPY --from=engine /app/security-engine/target/release/trendar-scan /app/backend/native/trendar-scan
COPY --from=frontend /app/frontend/dist /app/frontend/dist
ENV NODE_ENV=production
ENV TRENDAR_RULES_DIR=/app/rules
CMD ["node", "src/server.js"]
