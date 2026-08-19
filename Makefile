BACKEND_PORT ?= 8787
FRONTEND_PORT ?= 5188

.PHONY: help install dev backend frontend build clean lint format deploy logs status open coherence-verify coherence-journal coherence-docs coherence-check

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

install: ## Install all dependencies
	cd backend && uv sync
	cd backend && npm install
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
	cd backend && uv run ruff check app/ tests/
	cd frontend && npx tsc --noEmit

format: ## Format backend code
	cd backend && uv run ruff format app/

coherence-verify: ## Run the coherence gate (specs + claims + test oracles) for the backend
	cd backend && npx coherence verify

coherence-journal: ## Watch the agent decision journal live
	cd backend && npx coherence journal

coherence-docs: ## Regenerate coherence artifacts (graph, AGENTS.md, CLAUDE.md block)
	cd backend && npx coherence docs && npx coherence claude

coherence-check: ## CI-style: hooks installed + docs fresh + verify
	cd backend && npx coherence hooks --check --host claude && npx coherence docs --check && npx coherence verify

clean: ## Remove build artifacts
	rm -rf frontend/dist backend/.venv __pycache__ .ruff_cache

deploy: ## Deploy to Railway
	railway up

logs: ## Tail Railway deploy logs
	railway logs

status: ## Show Railway service status
	railway service status

open: ## Open Railway dashboard
	railway open
