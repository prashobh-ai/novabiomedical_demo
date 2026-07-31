#!/usr/bin/env bash
# Local dev: build the index from docs_source and serve the site on :8000.
# Phone-friendly — open http://localhost:8000 in a browser.
set -e

cd "$(dirname "$0")/.."

echo "[*] Installing pipeline dependencies..."
pip install -q -r pipeline/requirements.txt

echo "[*] Building index..."
python -m pipeline.build_index --source docs_source --out site/data/index.json

echo "[*] Serving site at http://localhost:8000"
echo "    Press Ctrl+C to stop."
python -m http.server 8000 --directory site
