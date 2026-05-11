#!/usr/bin/env python3
"""
Subsurface クラウドの git リポジトリから XML を取得し、docs/data.json に変換する。

環境変数:
  SUBSURFACE_EMAIL      Subsurface クラウドのログインメール
  SUBSURFACE_PASSWORD   Subsurface クラウドのパスワード
  SUBSURFACE_REPO_URL   git リポジトリの URL（省略時は Email から自動生成）
  OUTPUT_FILE           出力先 JSON パス（デフォルト: docs/data.json）
"""

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote
import xml.etree.ElementTree as ET

import git

# ---------------------------------------------------------------------------
# 設定
# ---------------------------------------------------------------------------
EMAIL = os.environ.get("SUBSURFACE_EMAIL", "")
PASSWORD = os.environ.get("SUBSURFACE_PASSWORD", "")

def build_repo_url() -> str:
    url = os.environ.get("SUBSURFACE_REPO_URL", "")
    if url:
        return url
    if not EMAIL:
        raise SystemExit("ERROR: SUBSURFACE_EMAIL または SUBSURFACE_REPO_URL を設定してください。")
    encoded_email = quote(EMAIL, safe="")
    if PASSWORD:
        encoded_pw = quote(PASSWORD, safe="")
        return f"https://{encoded_email}:{encoded_pw}@cloud.subsurface-divelog.org/git/{encoded_email}"
    return f"https://cloud.subsurface-divelog.org/git/{encoded_email}"

CLONE_DIR = Path("/tmp/subsurface-data")
OUTPUT_FILE = Path(os.environ.get("OUTPUT_FILE", "docs/data.json"))

# ---------------------------------------------------------------------------
# git clone / pull
# ---------------------------------------------------------------------------

def fetch_repo(url: str, dest: Path) -> None:
    if dest.exists():
        print(f"[git] pull: {dest}")
        repo = git.Repo(dest)
        origin = repo.remotes.origin
        # URL が変わっている場合に備えて更新
        with repo.config_writer() as cw:
            cw.set_value("remote \"origin\"", "url", url)
        origin.pull()
    else:
        print(f"[git] clone: {url} -> {dest}")
        git.Repo.clone_from(url, dest)

# ---------------------------------------------------------------------------
# 単位パーサー
# ---------------------------------------------------------------------------

def _num(text: str) -> float | None:
    """文字列から最初の数値を取り出す。"""
    if not text:
        return None
    m = re.search(r"[-+]?\d+\.?\d*", text)
    return float(m.group()) if m else None


def parse_depth_m(text: str | None) -> float | None:
    """'12.40 m' や '40 ft' をメートルに変換。"""
    if not text:
        return None
    v = _num(text)
    if v is None:
        return None
    if "ft" in text:
        return round(v * 0.3048, 2)
    return round(v, 2)


def parse_duration_min(text: str | None) -> float | None:
    """'42:30 min' → 42.5、'1:02:10' → 62.17 のように分に変換。"""
    if not text:
        return None
    parts = re.findall(r"\d+", text)
    if len(parts) == 2:
        return round(int(parts[0]) + int(parts[1]) / 60, 2)
    if len(parts) == 3:
        return round(int(parts[0]) * 60 + int(parts[1]) + int(parts[2]) / 60, 2)
    v = _num(text)
    return round(v, 2) if v is not None else None


def parse_temp_c(text: str | None) -> float | None:
    """'27.0 C' や '80 F' を摂氏に変換。"""
    if not text:
        return None
    v = _num(text)
    if v is None:
        return None
    if "F" in text:
        return round((v - 32) * 5 / 9, 1)
    return round(v, 1)


def parse_pressure_bar(text: str | None) -> float | None:
    """'200 bar' や '3000 psi' をバールに変換。"""
    if not text:
        return None
    v = _num(text)
    if v is None:
        return None
    if "psi" in text.lower():
        return round(v * 0.0689476, 1)
    return round(v, 1)


def parse_gps(text: str | None) -> list[float] | None:
    """'35.123 139.456' → [35.123, 139.456]"""
    if not text:
        return None
    parts = text.strip().split()
    if len(parts) == 2:
        try:
            return [float(parts[0]), float(parts[1])]
        except ValueError:
            return None
    return None

# ---------------------------------------------------------------------------
# Subsurface XML パーサー
# ---------------------------------------------------------------------------

def parse_ssrf(path: Path) -> tuple[dict, list]:
    """
    .ssrf ファイルをパースし (sites_dict, dives_list) を返す。
    sites_dict: {uuid: {name, gps, notes}}
    dives_list: [dive_dict, ...]
    """
    try:
        tree = ET.parse(path)
    except ET.ParseError as e:
        print(f"[WARN] XML パースエラー ({path}): {e}")
        return {}, []

    root = tree.getroot()
    sites: dict = {}
    dives: list = []

    # --- ダイブサイト ---
    for site in root.iter("site"):
        uid = site.get("uuid", "")
        if not uid:
            continue
        sites[uid] = {
            "name": site.get("name", ""),
            "gps": parse_gps(site.get("gps")),
            "notes": (site.findtext("notes") or "").strip(),
        }

    # --- ダイブ ---
    for dive in root.iter("dive"):
        d = _parse_dive(dive, sites)
        if d:
            dives.append(d)

    return sites, dives


def _parse_dive(elem: ET.Element, sites: dict) -> dict | None:
    date_str = elem.get("date", "")
    time_str = elem.get("time", "00:00")
    if not date_str:
        return None

    number = int(elem.get("number", 0)) if elem.get("number") else None
    rating = int(elem.get("rating", 0)) if elem.get("rating") else None
    visibility = int(elem.get("visibility", 0)) if elem.get("visibility") else None

    # サイト
    site_uuid = ""
    site_name = ""
    ds_elem = elem.find("divesite")
    if ds_elem is not None:
        site_uuid = ds_elem.get("uuid", "")
        site_name = sites.get(site_uuid, {}).get("name", "")

    # タグ
    tags_text = elem.findtext("tags") or ""
    tags = [t.strip() for t in tags_text.split(",") if t.strip()]

    # スーツ・バディなど（notes に含まれることが多い）
    notes = (elem.findtext("notes") or "").strip()

    # 深度・時間はダイブコンピュータ要素から取得
    dc = elem.find("divecomputer")
    max_depth_m = mean_depth_m = None
    water_temp_c = air_temp_c = None
    profile: list[dict] = []
    dc_model = ""

    if dc is not None:
        dc_model = dc.get("model", "")
        depth_el = dc.find("depth")
        if depth_el is not None:
            max_depth_m = parse_depth_m(depth_el.get("max"))
            mean_depth_m = parse_depth_m(depth_el.get("mean"))

        temp_el = dc.find("temperature")
        if temp_el is not None:
            water_temp_c = parse_temp_c(temp_el.get("water"))
            air_temp_c = parse_temp_c(temp_el.get("air"))

        profile = _parse_profile(dc)

    # depth/temperature が dive 直下にある場合のフォールバック
    if max_depth_m is None:
        depth_el = elem.find("depth")
        if depth_el is not None:
            max_depth_m = parse_depth_m(depth_el.get("max"))
            mean_depth_m = parse_depth_m(depth_el.get("mean"))

    if water_temp_c is None:
        temp_el = elem.find("temperature")
        if temp_el is not None:
            water_temp_c = parse_temp_c(temp_el.get("water"))
            air_temp_c = parse_temp_c(temp_el.get("air"))

    # シリンダー（最初の1本）
    cylinder = _parse_cylinder(elem)

    return {
        "number": number,
        "date": date_str,
        "time": time_str,
        "duration_min": parse_duration_min(elem.get("duration")),
        "max_depth_m": max_depth_m,
        "mean_depth_m": mean_depth_m,
        "water_temp_c": water_temp_c,
        "air_temp_c": air_temp_c,
        "site_uuid": site_uuid,
        "site_name": site_name,
        "rating": rating,
        "visibility": visibility,
        "tags": tags,
        "notes": notes,
        "dc_model": dc_model,
        "cylinder": cylinder,
        "profile": profile,
    }


def _parse_profile(dc: ET.Element) -> list[dict]:
    samples = []
    for s in dc.iter("sample"):
        time_s = None
        time_text = s.get("time")
        if time_text:
            parts = re.findall(r"\d+", time_text)
            if len(parts) == 2:
                time_s = int(parts[0]) * 60 + int(parts[1])
            elif len(parts) == 1:
                time_s = int(parts[0])

        entry: dict = {}
        if time_s is not None:
            entry["time_s"] = time_s
        d = parse_depth_m(s.get("depth"))
        if d is not None:
            entry["depth_m"] = d
        t = parse_temp_c(s.get("temp"))
        if t is not None:
            entry["temp_c"] = t
        p = parse_pressure_bar(s.get("pressure"))
        if p is not None:
            entry["pressure_bar"] = p
        if entry:
            samples.append(entry)
    return samples


def _parse_cylinder(elem: ET.Element) -> dict | None:
    cyl = elem.find("cylinder")
    if cyl is None:
        return None
    return {
        "description": cyl.get("description", ""),
        "size_l": _num(cyl.get("size", "")),
        "workpressure_bar": parse_pressure_bar(cyl.get("workpressure")),
        "start_bar": parse_pressure_bar(cyl.get("start")),
        "end_bar": parse_pressure_bar(cyl.get("end")),
        "o2_pct": _num(cyl.get("o2", "")),
    }

# ---------------------------------------------------------------------------
# 全ファイルを集約して JSON 出力
# ---------------------------------------------------------------------------

def collect_all(repo_dir: Path) -> tuple[dict, list]:
    all_sites: dict = {}
    all_dives: list = []

    ssrf_files = sorted(repo_dir.rglob("*.ssrf"))
    if not ssrf_files:
        # ルートに単一ファイルとして置かれているケースも探す
        ssrf_files = sorted(repo_dir.rglob("*.xml"))

    if not ssrf_files:
        print("[WARN] .ssrf / .xml ファイルが見つかりませんでした。")
        return all_sites, all_dives

    for f in ssrf_files:
        print(f"[parse] {f.name}")
        sites, dives = parse_ssrf(f)
        all_sites.update(sites)
        all_dives.extend(dives)

    # 番号 → 日付の順でソート（番号がない場合は日付優先）
    all_dives.sort(key=lambda d: (d["date"], d["time"]))
    return all_sites, all_dives


def build_summary(dives: list) -> dict:
    if not dives:
        return {}

    total_min = sum(d["duration_min"] or 0 for d in dives)
    depths = [d["max_depth_m"] for d in dives if d["max_depth_m"]]
    sites = {d["site_uuid"] for d in dives if d["site_uuid"]}
    dates = [d["date"] for d in dives if d["date"]]

    return {
        "total_dives": len(dives),
        "total_time_min": round(total_min, 1),
        "max_depth_m": max(depths) if depths else None,
        "avg_depth_m": round(sum(depths) / len(depths), 2) if depths else None,
        "unique_sites": len(sites),
        "date_range": {
            "first": min(dates) if dates else None,
            "last": max(dates) if dates else None,
        },
    }


def main() -> None:
    repo_url = build_repo_url()
    fetch_repo(repo_url, CLONE_DIR)

    sites, dives = collect_all(CLONE_DIR)
    summary = build_summary(dives)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "summary": summary,
        "sites": sites,
        "dives": dives,
    }

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_FILE.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print(f"[done] {len(dives)} dives → {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
