#!/bin/sh
# GregFlow (GTNH line planner) launcher for Linux / macOS.
# Запуск планировщика в Linux / macOS.
#
#   ./start.sh                     run in this terminal and open the browser / запустить в этом окне
#   ./start.sh install             Linux: install as a systemd service, start it now and at boot,
#                                  print the address / установить службу systemd, запустить, автозапуск
#       --port N                   port (default 8765) / порт
#       --lan                      listen on the network, not only this machine (there is no login!)
#                                  / слушать сеть, а не только этот компьютер (входа нет!)
#       --host ADDR                listen on one address, e.g. a VPN IP / слушать один адрес
#       --mc-dir PATH              Minecraft folder, read-only / папка Minecraft (только чтение)
#   ./start.sh url                 print the address again / снова показать адрес
#   ./start.sh status | logs       service state / journal  / состояние службы / журнал
#   ./start.sh restart             restart the service (after an update) / перезапустить службу
#   ./start.sh uninstall           stop and remove the service (files stay) / удалить службу (файлы остаются)
#
# Run `install` as your normal user: a user service, started at boot via `loginctl enable-linger`.
# With sudo it becomes a system service that runs as the owner of this folder.
cd "$(dirname "$0")" || exit 1
DIR=$(pwd -P)
NAME=gregflow

PY=
for py in python3 python; do
  if command -v "$py" >/dev/null 2>&1 && "$py" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'; then
    PY=$(command -v "$py")
    break
  fi
done
if [ -z "$PY" ]; then
  echo "Python 3.9+ is needed: https://www.python.org/downloads/ (or your package manager, e.g. 'sudo apt install python3')"
  echo "Нужен Python 3.9+: https://www.python.org/downloads/ (или пакетный менеджер, например 'sudo apt install python3')"
  exit 1
fi

die() { echo "[!!] $*" >&2; exit 1; }

# --- where the service lives: system service when run as root, user service otherwise ---
if [ "$(id -u)" = 0 ]; then
  SCOPE=system
  UNIT=/etc/systemd/system/$NAME.service
  sctl() { systemctl "$@"; }
  jctl() { journalctl -u "$NAME" "$@"; }
else
  SCOPE=user
  UNIT=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$NAME.service
  sctl() { systemctl --user "$@"; }
  jctl() { journalctl --user-unit "$NAME" "$@"; }
fi

need_systemd() {
  [ "$(uname -s)" = Linux ] || die "The service is for Linux with systemd. On macOS run ./start.sh / Служба только для Linux с systemd."
  command -v systemctl >/dev/null 2>&1 || die "systemctl not found: this system does not use systemd / systemd не найден."
  if [ "$SCOPE" = user ] && ! systemctl --user show-environment >/dev/null 2>&1; then
    die "No user systemd session (common over 'su' or in containers). Log in directly over SSH, or run: sudo ./start.sh install
     Нет пользовательской сессии systemd. Войдите напрямую по SSH или запустите: sudo ./start.sh install"
  fi
}

# Value of an option written in the unit's ExecStart line (empty if absent).
unit_opt() { [ -f "$UNIT" ] && sed -n 's/^ExecStart=.*'"$1"' "\{0,1\}\([^" ]*\)"\{0,1\}.*/\1/p' "$UNIT" | head -n 1; }

port_free() {
  "$PY" - "$1" "$2" <<'EOF'
import socket, sys
host = sys.argv[1] if sys.argv[1] not in ("0.0.0.0", "::") else ""
s = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET)
try:
    s.bind((host, int(sys.argv[2])))
except OSError:
    sys.exit(1)
EOF
}

wait_up() {  # up to 30 s for /api/status
  "$PY" - "$1" <<'EOF'
import sys, time, urllib.request
url = f"http://127.0.0.1:{sys.argv[1]}/api/status"
for _ in range(60):
    try:
        with urllib.request.urlopen(url, timeout=2) as r:
            sys.exit(0 if r.status == 200 else 1)
    except Exception:
        time.sleep(0.5)
sys.exit(1)
EOF
}

lan_ips() {
  { hostname -I 2>/dev/null || ip -4 -o addr show scope global 2>/dev/null | awk '{sub(/\/.*/, "", $4); print $4}'; } \
    | tr ' ' '\n' | grep -v -e '^$' -e '^127\.' -e ':'
}

show_url() {
  [ -f "$UNIT" ] || die "The service is not installed. Run: ./start.sh install / Служба не установлена."
  port=$(unit_opt --port); host=$(unit_opt --host)
  echo
  echo "================================================================"
  echo "  GregFlow service / служба GregFlow ($SCOPE): $(sctl is-active "$NAME" 2>/dev/null)"
  echo
  echo "  On this machine / на этом компьютере:  http://127.0.0.1:$port/"
  case "$host" in
    127.0.0.1|localhost|::1)
      ip=$(lan_ips | head -n 1)
      echo
      echo "  From another computer, open an SSH tunnel, then the address above:"
      echo "  С другого компьютера откройте SSH-туннель, затем адрес выше:"
      echo "    ssh -N -L $port:127.0.0.1:$port $(id -un)@${ip:-<this-server>}"
      ;;
    0.0.0.0|::)
      for ip in $(lan_ips); do echo "  On the network / в сети:              http://$ip:$port/"; done
      echo
      echo "  No login: anyone who reaches this port can edit schematics. Keep it on a trusted network."
      echo "  Входа нет: любой, кто видит этот порт, может менять схемы. Только для доверенной сети."
      ;;
    *)
      echo "  On the network / в сети:              http://$host:$port/"
      echo "  No login: anyone who reaches this port can edit schematics. / Входа нет."
      ;;
  esac
  echo "================================================================"
}

do_install() {
  need_systemd
  port=8765; host=127.0.0.1; mcdir=
  while [ $# -gt 0 ]; do
    case "$1" in
      --port) [ -n "$2" ] || die "--port needs a number"; port=$2; shift 2 ;;
      --port=*) port=${1#*=}; shift ;;
      --lan) host=0.0.0.0; shift ;;
      --host) [ -n "$2" ] || die "--host needs an address"; host=$2; shift 2 ;;
      --host=*) host=${1#*=}; shift ;;
      --mc-dir) [ -n "$2" ] || die "--mc-dir needs a path"; mcdir=$2; shift 2 ;;
      --mc-dir=*) mcdir=${1#*=}; shift ;;
      *) die "Unknown option / неизвестный параметр: $1" ;;
    esac
  done
  case "$port" in ''|*[!0-9]*) die "Bad port / неверный порт: $port" ;; esac
  case "$DIR$mcdir" in *'"'*|*'\'*|*'%'*|*'$'*) die "The folder path contains \" \\ % or \$, which systemd cannot take. Move the planner. / Путь содержит недопустимые символы." ;; esac

  # The old copy must not hold the port while we check it.
  if [ -f "$UNIT" ]; then sctl stop "$NAME" 2>/dev/null; fi
  port_free "$host" "$port" || die "Port $port is busy (another program or a planner started by hand). Close it or use --port N.
     Порт $port занят (другая программа или планировщик, запущенный вручную). Закройте его или укажите --port N."

  echo "[..] recipe data / данные рецептов"
  "$PY" planner.py --fetch-data || echo "[!] Download failed; the browser's Setup window can retry. / Не скачалось — повторите в окне «Настройка»."

  extra=
  [ -n "$mcdir" ] && extra=" --mc-dir \"$mcdir\""
  mkdir -p "$(dirname "$UNIT")" || die "Cannot create $(dirname "$UNIT")"
  if [ "$SCOPE" = system ]; then
    owner=$(stat -c %U "$DIR")
    userline="User=$owner"
    wanted=multi-user.target
  else
    userline=
    wanted=default.target
  fi
  cat > "$UNIT" <<EOF
# Created by GregFlow ./start.sh install - remove with ./start.sh uninstall
[Unit]
Description=GregFlow - GTNH production line planner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
$userline
WorkingDirectory=$DIR
ExecStart="$PY" "$DIR/planner.py" --no-browser --fixed-port --host $host --port $port$extra
Environment=PYTHONUNBUFFERED=1
Restart=on-failure
RestartSec=5

[Install]
WantedBy=$wanted
EOF
  echo "[ok] $UNIT"
  sctl daemon-reload || die "systemctl daemon-reload failed"
  sctl enable "$NAME" >/dev/null 2>&1 || die "systemctl enable failed"
  sctl restart "$NAME" || die "The service did not start. See: ./start.sh logs"

  if [ "$SCOPE" = user ]; then
    # Without linger a user service starts only after login and stops at logout.
    if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != yes ]; then
      if loginctl enable-linger "$(id -un)" 2>/dev/null; then
        echo "[ok] autostart at boot (loginctl enable-linger) / автозапуск при загрузке"
      else
        echo "[!] To start at boot without logging in, run once / чтобы служба стартовала при загрузке без входа:"
        echo "      sudo loginctl enable-linger $(id -un)"
      fi
    else
      echo "[ok] autostart at boot / автозапуск при загрузке"
    fi
  else
    echo "[ok] autostart at boot / автозапуск при загрузке"
  fi

  echo "[..] waiting for the planner / жду запуска"
  wait_up "$port" || { jctl -n 30 --no-pager; die "The planner did not answer on port $port. See: ./start.sh logs"; }
  show_url
}

do_uninstall() {
  need_systemd
  [ -f "$UNIT" ] || { echo "Not installed / служба не установлена ($UNIT)"; exit 0; }
  sctl disable --now "$NAME" 2>/dev/null
  rm -f "$UNIT"
  sctl daemon-reload
  echo "[ok] Service removed; your projects and data are untouched. / Служба удалена, проекты и данные на месте."
}

case "$1" in
  install) shift; do_install "$@" ;;
  uninstall|remove) do_uninstall ;;
  url) need_systemd; show_url ;;
  status) need_systemd; sctl status "$NAME" --no-pager ;;
  logs) need_systemd; jctl -n 100 --no-pager ;;
  restart) need_systemd; sctl restart "$NAME" && wait_up "$(unit_opt --port)" && show_url ;;
  *) exec "$PY" planner.py "$@" ;;
esac
