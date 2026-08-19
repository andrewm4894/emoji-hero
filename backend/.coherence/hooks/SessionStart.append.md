EMOJI-HERO NOTE: the coherence root is `backend/` — run every `npx coherence …` command
from `backend/` (or use `make coherence-*` from the repo root). The verify gate is
`make coherence-verify`; the Slack-emoji invariant (PNG, ≤128x128, <128KB) is anchored at
`prepare_for_slack` in `backend/app/image_processing.py` — if you touch that function or
`IMAGE_EXTS`, re-run verify. Specs live in `backend/*.spec.md` and `backend/app/app.spec.md`.
