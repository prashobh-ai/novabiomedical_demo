#!/usr/bin/env python3
"""Crawl an IFU / documentation library and download every PDF into docs_source/.

Requires outbound web access — run this from a Claude Code environment whose
network policy allows it (the default locked-down web environment blocks it).

Usage:
    python scripts/crawl_ifu.py                         # defaults to the Nova IFU meters page
    python scripts/crawl_ifu.py --url <START_URL> --depth 2 --out docs_source

It discovers PDF links on the start page, follows same-site product/category
links up to --depth levels, downloads each unique PDF, and gives it a clean,
citation-friendly filename. Re-runnable: existing files are skipped.
"""
from __future__ import annotations

import argparse
import re
import sys
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

DEFAULT_URL = "https://novabiomedicaldocs.com/ifu-meters/"
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; NovaKnowledgeFabric/1.0; +demo)"}


def clean_name(url: str, link_text: str) -> str:
    """Build a readable filename from the link text, falling back to the URL."""
    base = (link_text or "").strip()
    if not base or len(base) < 4:
        base = Path(urlparse(url).path).stem
    base = re.sub(r"[^A-Za-z0-9]+", "_", base).strip("_")
    base = re.sub(r"_+", "_", base)
    if not base:
        base = "document"
    return base[:120] + ".pdf"


def is_pdf(url: str) -> bool:
    return urlparse(url).path.lower().endswith(".pdf")


def same_site(a: str, b: str) -> bool:
    return urlparse(a).netloc.replace("www.", "") == urlparse(b).netloc.replace("www.", "")


def crawl(start_url: str, depth: int, out: Path, delay: float = 0.5) -> None:
    out.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers.update(HEADERS)

    seen_pages: set[str] = set()
    seen_pdfs: set[str] = set()
    downloaded = 0
    queue: list[tuple[str, int]] = [(start_url, 0)]

    while queue:
        page_url, d = queue.pop(0)
        if page_url in seen_pages or d > depth:
            continue
        seen_pages.add(page_url)
        try:
            resp = session.get(page_url, timeout=30)
            resp.raise_for_status()
        except Exception as exc:  # noqa: BLE001
            print(f"  ! failed to fetch {page_url}: {exc}", file=sys.stderr)
            continue

        soup = BeautifulSoup(resp.text, "html.parser")
        for a in soup.find_all("a", href=True):
            href = urljoin(page_url, a["href"].split("#")[0])
            if is_pdf(href):
                if href in seen_pdfs:
                    continue
                seen_pdfs.add(href)
                name = clean_name(href, a.get_text(" ", strip=True))
                dest = out / name
                if dest.exists():
                    print(f"  = skip (exists) {name}")
                    continue
                try:
                    pdf = session.get(href, timeout=60)
                    pdf.raise_for_status()
                    dest.write_bytes(pdf.content)
                    downloaded += 1
                    print(f"  + {name}  ({len(pdf.content)//1024} KB)  <- {href}")
                    time.sleep(delay)
                except Exception as exc:  # noqa: BLE001
                    print(f"  ! failed to download {href}: {exc}", file=sys.stderr)
            elif d < depth and same_site(start_url, href) and href not in seen_pages:
                # Follow same-site product/category pages one level deeper.
                queue.append((href, d + 1))

    print(f"\n[done] downloaded {downloaded} new PDF(s) into {out}")
    print("Next: python -m pipeline.build_index --source docs_source --out site/data/index.json")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL, help="Start URL to crawl")
    ap.add_argument("--depth", type=int, default=2, help="How many link levels to follow")
    ap.add_argument("--out", type=Path, default=Path("docs_source"), help="Output directory")
    args = ap.parse_args()
    print(f"[*] crawling {args.url} (depth {args.depth}) → {args.out}")
    crawl(args.url, args.depth, args.out)


if __name__ == "__main__":
    main()
