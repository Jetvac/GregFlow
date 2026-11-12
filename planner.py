#!/usr/bin/env python3
"""GregFlow, a GTNH production line planner — entry point / GregFlow, планировщик линий GTNH — точка входа.

    python planner.py                    # start and open the browser / запустить и открыть браузер
    python planner.py --mc-dir PATH      # Minecraft folder, read-only / папка Minecraft (только чтение)
    python planner.py --fetch-data       # download + verify the recipe snapshot / скачать снимок рецептов
    python planner.py --fetch-lang       # download Russian names (GTNH-Translations, GPL-3.0)
    python planner.py --check            # check data and installation without a server

Everything above can also be done in the browser: the «Setup / Настройка» window.
"""
from __future__ import annotations

import argparse
import os
import socket
import sys
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

if sys.version_info < (3, 9):
    print("Python 3.9 or newer is required / нужен Python 3.9 или новее:", sys.version.split()[0])
    sys.exit(1)

from server import app, install_check, lang, setup  # noqa: E402


def fetch_data(data_dir: str) -> int:
    todo = setup.missing_files(data_dir)
    if not todo:
        print("[ok] recipe data already present, SHA-256 match / данные рецептов на месте")
        return 0
    for item in todo:
        print(f"[..] downloading / скачиваю {item['url']}")

        def prog(done, total, name=item["file"]):
            if total:
                print(f"\r     {name}: {done * 100 // total}%", end="", flush=True)
        try:
            setup.download(item, prog)
            print(f"\n[ok] {item['file']} saved and verified / сохранён и проверен")
        except Exception as e:
            print(f"\n[!!] {item['file']}: {e}")
            return 1
    return 0


def free_port(start: int) -> int:
    """First free local port starting at `start` (a second copy of the planner may be running)."""
    for p in range(start, start + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", p)) != 0:
                return p
    return start


def main():
    ap = argparse.ArgumentParser(description="GregFlow, a GTNH production line planner")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--mc-dir", help="Minecraft/GTNH folder (read-only); by default searched upwards and in settings")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--fetch-data", action="store_true")
    ap.add_argument("--fetch-lang", action="store_true", help="download Russian names (GTNH-Translations)")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    data_dir = os.path.join(ROOT, "data")
    if a.fetch_data:
        sys.exit(fetch_data(data_dir))
    if a.fetch_lang:
        m = lang.fetch_translations(data_dir)
        print(f"[ok] {m['repo']} @ {m['commit']}, files: {len(m['files'])}, license {m['license']}")
        sys.exit(0)
    mc = a.mc_dir or install_check.find_install(os.getcwd()) or install_check.find_install(ROOT)
    planner = app.Planner(ROOT, mc_dir=mc)
    st = planner.status()
    act = st["active"] or {}
    print(f"Recipe data / рецепты: {act.get('label')} (format {act.get('format')}, verified: {act.get('verified')})")
    if st["catalog"]:
        c = st["catalog"]
        print(f"  items {c['items']}, fluids {c['fluids']}, recipes {c['recipes']}")
    else:
        print("  not loaded yet / не загружены — the browser will offer to download them / браузер предложит скачать")
    nm = st.get("names") or {}
    if nm.get("goods"):
        print(f"Russian names / русские названия: {nm['goods']} resources, {nm['machines']} machines")
    inst = st["install"]
    if inst.get("found"):
        print(f"Minecraft (read-only / только чтение): {inst['path']} — pack {inst.get('packVersion')}, "
              f"GregTech {inst['jars'].get('gregtech', {}).get('version')}")
    else:
        print("Minecraft folder: not set (optional) / папка Minecraft не задана (необязательно)")
    if a.check:
        sys.exit(0 if st["catalog"] else 1)
    port = free_port(a.port)
    srv = app.make_server(planner, port=port)
    url = f"http://127.0.0.1:{port}/"
    print()
    print("=" * 64)
    print(f"  GregFlow is running / GregFlow запущен:  {url}")
    print("  Keep this window open while you use it; close it to stop.")
    print("  Не закрывайте это окно, пока работаете; закройте — чтобы остановить.")
    print("=" * 64)
    if not a.no_browser:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
