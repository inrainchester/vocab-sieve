#!/usr/bin/env python3
"""
Convert a CSV or TSV vocabulary table into a Vocab Sieve wordbook JSON file.
Uses Python standard library only (no third-party packages required).

Usage:
  python3 tools/csv_to_wordbook.py tools/template_words.csv -o lexicon/my_book.json --id my_book --title "我的词库"
"""

import argparse
import csv
import json
import re
import sys
from collections import Counter
from pathlib import Path


def clean_lookup_word(word: str) -> str:
    w = (word or "").strip()
    w = re.sub(r"\s*\([^)]*\)\s*$", "", w).strip()
    w = re.sub(r"^to\s+", "", w, flags=re.IGNORECASE).strip()
    return w.lower()


def split_list(raw: str) -> list[str]:
    if not raw:
        return []
    return [item.strip() for item in re.split(r"[,;|]+", raw) if item.strip()]


def parse_examples(raw_en: str, raw_zh: str, source_label: str) -> list[dict]:
    if not raw_en.strip():
        return []
    en_parts = [p.strip() for p in raw_en.split("||") if p.strip()]
    zh_parts = [p.strip() for p in raw_zh.split("||")] if raw_zh.strip() else []
    examples = []
    for idx, en in enumerate(en_parts):
        zh = zh_parts[idx] if idx < len(zh_parts) else ""
        examples.append({"en": en, "zh": zh, "source": source_label})
    return examples


def detect_delimiter(path: Path, explicit: str | None) -> str:
    if explicit:
        return "\t" if explicit == "\\t" else explicit
    if path.suffix.lower() == ".tsv":
        return "\t"
    return ","


def convert(
    input_path: Path,
    book_id: str,
    title: str,
    short_title: str,
    description: str,
    delimiter: str,
    source_label: str,
) -> dict:
    with input_path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f, delimiter=delimiter)
        if not reader.fieldnames:
            raise ValueError("CSV/TSV 文件为空或缺少表头")

        rows = list(reader)

    unit_counts: Counter[str] = Counter()
    unit_order: list[str] = []
    root_intros: dict[tuple[str, str], str] = {}
    seen_ids: set[str] = set()
    words: list[dict] = []

    for row_idx, row in enumerate(rows, start=2):
        norm_row = { (k or "").strip(): (v or "").strip() for k, v in row.items() if k }
        word = norm_row.get("word", "")
        if not word:
            continue

        zh_meaning = norm_row.get("zhMeaning", "") or norm_row.get("zh", "")
        en_meaning = norm_row.get("enMeaning", "") or norm_row.get("en", "")
        if not zh_meaning and not en_meaning:
            print(f"[warn] 第 {row_idx} 行单词 '{word}' 缺少中文和英文释义，已保留原词条", file=sys.stderr)

        unit = norm_row.get("unit", "") or "Unit 1"
        if unit not in unit_counts:
            unit_order.append(unit)
        unit_counts[unit] += 1
        order_in_unit = unit_counts[unit]

        root_group = norm_row.get("rootGroup", "") or unit
        root_intro = norm_row.get("rootIntro", "")
        rg_key = (unit, root_group)
        if root_intro and rg_key not in root_intros:
            root_intros[rg_key] = root_intro
        elif not root_intro and rg_key in root_intros:
            root_intro = root_intros[rg_key]

        pos = norm_row.get("pos", "")
        if pos and zh_meaning and not zh_meaning.startswith("["):
            zh_meaning = f"[{pos}] {zh_meaning}"

        word_id = f"{book_id}:{unit}:{word}"
        if word_id in seen_ids:
            word_id = f"{word_id}#{order_in_unit}"
        seen_ids.add(word_id)

        entry = {
            "id": word_id,
            "word": word,
            "cleanWord": clean_lookup_word(word),
            "book": book_id,
            "unit": unit,
            "order": order_in_unit,
            "rootGroup": root_group,
            "rootIntro": root_intro,
            "phonetics": {
                "uk": norm_row.get("uk_ipa", ""),
                "us": norm_row.get("us_ipa", ""),
                "respell": norm_row.get("respell", ""),
            },
            "pos": pos,
            "zhMeaning": zh_meaning,
            "enMeaning": en_meaning,
            "contextExplanation": norm_row.get("contextExplanation", ""),
            "examples": parse_examples(
                norm_row.get("example_en", ""),
                norm_row.get("example_zh", ""),
                source_label or short_title or title,
            ),
            "cognates": split_list(norm_row.get("cognates", "")),
            "rootBreakdown": norm_row.get("rootBreakdown", ""),
            "etymology": norm_row.get("etymology", ""),
        }
        words.append(entry)

    units = [
        {"id": u, "title": u, "wordCount": unit_counts[u]}
        for u in unit_order
    ]

    desc = description or f"{len(units)} 个单元 · {len(words)} 个词汇"
    return {
        "id": book_id,
        "title": title,
        "shortTitle": short_title or title,
        "description": desc,
        "totalWords": len(words),
        "units": units,
        "words": words,
    }


def main():
    parser = argparse.ArgumentParser(description="将 CSV/TSV 词表转换为 Vocab Sieve 词库 JSON")
    parser.add_argument("input", type=Path, help="输入 CSV/TSV 文件路径")
    parser.add_argument("-o", "--output", type=Path, required=True, help="输出 JSON 文件路径，例如 lexicon/my_book.json")
    parser.add_argument("--id", required=True, help="词库唯一 ID（仅限英文/数字/_/-，例如 toefl）")
    parser.add_argument("--title", required=True, help="词库完整标题")
    parser.add_argument("--short-title", default="", help="顶部标签栏显示的短标题（默认同 title）")
    parser.add_argument("--description", default="", help="词库描述（可选）")
    parser.add_argument("--delimiter", default=None, help="分隔符，默认按扩展名判断（.tsv 用制表符，.csv 用逗号）")
    parser.add_argument("--source", default="", help="例句来源标注（可选）")
    args = parser.parse_args()

    clean_id = re.sub(r"[^a-zA-Z0-9_-]", "", args.id)
    if not clean_id:
        raise SystemExit("错误: --id 必须包含英文、数字、下划线或连字符")

    delim = detect_delimiter(args.input, args.delimiter)
    book = convert(
        input_path=args.input,
        book_id=clean_id,
        title=args.title,
        short_title=args.short_title,
        description=args.description,
        delimiter=delim,
        source_label=args.source,
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(book, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[ok] 已生成 {args.output} ({len(book['units'])} 个单元, {book['totalWords']} 个词)")


if __name__ == "__main__":
    main()
