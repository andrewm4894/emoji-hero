"""Test bootstrap: point image storage at a throwaway dir BEFORE app modules import.

`app.image_processing` resolves `STORAGE` from settings at import time, so the env var
has to be set before any test module imports it.
"""

import os
import tempfile

os.environ.setdefault("IMAGE_STORAGE_DIR", tempfile.mkdtemp(prefix="emoji-hero-test-"))
