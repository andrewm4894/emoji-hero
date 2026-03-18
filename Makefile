BACKEND_PORT ?= 8787
FRONTEND_PORT ?= 5188

.PHONY: help install dev backend frontend build clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

install: ## Install all dependencies
	cd backend && uv sync
	cd frontend && npm install

dev: ## Run backend + frontend in parallel
	@make -j2 backend frontend

backend: ## Run backend (FastAPI, port $(BACKEND_PORT))
	cd backend && uv run uvicorn app.main:app --reload --port $(BACKEND_PORT)

frontend: ## Run frontend (Vite, port $(FRONTEND_PORT))
	cd frontend && npx vite --port $(FRONTEND_PORT)

build: ## Build frontend for production
	cd frontend && npm run build

lint: ## Lint backend + frontend
	cd backend && uv run ruff check app/
	cd frontend && npx tsc --noEmit

format: ## Format backend code
	cd backend && uv run ruff format app/

clean: ## Remove build artifacts
	rm -rf frontend/dist backend/.venv __pycache__ .ruff_cache
