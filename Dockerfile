# Stage 1: Build frontend
FROM node:22-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Python backend
FROM python:3.12-slim AS backend

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Install a basic font for Pillow text rendering
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev

# Copy backend source
COPY backend/app/ ./app/

# Copy built frontend
COPY --from=frontend-build /app/frontend/dist ./static

ENV FRONTEND_DIR=/app/static

EXPOSE 8000

CMD uv run uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}
