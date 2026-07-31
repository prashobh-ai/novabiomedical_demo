"""Main pipeline: docs → index.json.

Usage:
    python -m pipeline.build_index --source docs_source --out site/data/index.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .bm25_index import build_bm25_index
from .chunker import chunk_paragraphs
from .entities import build_relationships, extract_entities_from_chunks
from .parsers import iter_sources, parse_any


def build(source_dir: Path, out_path: Path) -> dict:
    documents: list[dict] = []
    all_chunks: list = []
    chunk_id_seq = 0

    sources = list(iter_sources(source_dir))
    if not sources:
        print(f"[!] No documents found in {source_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"[*] Found {len(sources)} source documents")

    for doc_id, src in enumerate(sources):
        try:
            parsed = parse_any(src)
        except Exception as exc:
            print(f"  ! Failed to parse {src.name}: {exc}", file=sys.stderr)
            continue

        chunks = chunk_paragraphs(
            parsed.paragraphs,
            document_id=doc_id,
            document_name=parsed.name,
            start_chunk_id=chunk_id_seq,
        )
        chunk_id_seq += len(chunks)
        all_chunks.extend(chunks)

        documents.append({
            "id": doc_id,
            "name": parsed.name,
            "source_path": str(src.relative_to(source_dir)),
            "page_count": parsed.page_count,
            "paragraph_count": len(parsed.paragraphs),
            "chunk_count": len(chunks),
        })
        print(f"  ✓ {parsed.name:50s} pages={parsed.page_count:>3} paragraphs={len(parsed.paragraphs):>3} chunks={len(chunks):>3}")

    # Extract entities + relationships
    print(f"[*] Extracting entities from {len(all_chunks)} chunks...")
    entities, mentions = extract_entities_from_chunks(all_chunks)
    print(f"  ✓ {len(entities)} unique entities, {len(mentions)} mentions")

    print("[*] Mining relationships...")
    relationships = build_relationships(entities, mentions)
    print(f"  ✓ {len(relationships)} relationships")

    # Build BM25 index
    print("[*] Building BM25 index...")
    bm25 = build_bm25_index(all_chunks)
    print(f"  ✓ vocab={len(bm25['vocab'])} avgdl={bm25['avgdl']:.1f}")

    # Map: entity_id -> [chunk_indices] for "reasoning trace"
    canonical_to_id = {e["canonical"]: e["id"] for e in entities}
    chunk_to_entities: list[list[int]] = [[] for _ in all_chunks]
    chunk_idx_by_id = {c.chunk_id: i for i, c in enumerate(all_chunks)}
    for m in mentions:
        eid = canonical_to_id.get(m.canonical)
        if eid is None:
            continue
        cidx = chunk_idx_by_id.get(m.chunk_id)
        if cidx is not None and eid not in chunk_to_entities[cidx]:
            chunk_to_entities[cidx].append(eid)

    # Serialize chunks (drop tokens — they're embedded in BM25 postings)
    serialized_chunks = [
        {
            "id": c.chunk_id,
            "document_id": c.document_id,
            "document_name": c.document_name,
            "page": c.page,
            "section_path": c.section_path,
            "paragraph_indices": c.paragraph_indices,
            "text": c.text,
            "paragraph_excerpt": c.paragraph_excerpt,
            "entities": chunk_to_entities[i],
        }
        for i, c in enumerate(all_chunks)
    ]

    index = {
        "version": "1.0",
        "documents": documents,
        "chunks": serialized_chunks,
        "entities": entities,
        "relationships": relationships,
        "bm25": bm25,
        "stats": {
            "document_count": len(documents),
            "chunk_count": len(all_chunks),
            "entity_count": len(entities),
            "relationship_count": len(relationships),
            "vocab_size": len(bm25["vocab"]),
        },
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))

    size_kb = out_path.stat().st_size / 1024
    print(f"\n[✓] Wrote {out_path} ({size_kb:.1f} KB)")
    return index


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", type=Path, default=Path("docs_source"))
    ap.add_argument("--out", type=Path, default=Path("site/data/index.json"))
    args = ap.parse_args()
    build(args.source, args.out)


if __name__ == "__main__":
    main()
