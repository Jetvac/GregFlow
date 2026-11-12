#!/bin/sh
# macOS: double-click to start the planner (runs start.sh).
cd "$(dirname "$0")" && exec ./start.sh "$@"
