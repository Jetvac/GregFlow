#!/bin/sh
# GregFlow (GTNH line planner) launcher for Linux / macOS: run ./start.sh (or double-click start.command on macOS).
# Запуск планировщика в Linux / macOS.
cd "$(dirname "$0")" || exit 1
for py in python3 python; do
  if command -v "$py" >/dev/null 2>&1 && "$py" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'; then
    exec "$py" planner.py "$@"
  fi
done
echo "Python 3.9+ is needed: https://www.python.org/downloads/ (or your package manager, e.g. 'sudo apt install python3')"
echo "Нужен Python 3.9+: https://www.python.org/downloads/ (или пакетный менеджер, например 'sudo apt install python3')"
exit 1
