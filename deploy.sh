#!/bin/sh

set -eu

unset CDPATH

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_LINES="${LOG_LINES:-120}"
SSH_BIN="${SSH_BIN:-ssh}"
DEPLOY_DEBUG="${DEPLOY_DEBUG:-}"
if [ -z "$DEPLOY_DEBUG" ]; then
    case "${DEBUG:-}" in
        1|true|yes|on) DEPLOY_DEBUG=1 ;;
        0|false|no|off|"") DEPLOY_DEBUG=0 ;;
        *) DEPLOY_DEBUG=0 ;;
    esac
fi
TMP_FILES=""
STEP=0

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    C_RESET="$(printf '\033[0m')"
    C_BOLD="$(printf '\033[1m')"
    C_BLUE="$(printf '\033[34m')"
    C_GREEN="$(printf '\033[32m')"
    C_RED="$(printf '\033[31m')"
    C_YELLOW="$(printf '\033[33m')"
else
    C_RESET=""
    C_BOLD=""
    C_BLUE=""
    C_GREEN=""
    C_RED=""
    C_YELLOW=""
fi

usage() {
    printf '%s\n' "Usage: OPENWRT_HOST=192.168.1.1 $0" >&2
    printf '%s\n' "   or: OPENWRT_HOST=root@192.168.1.1 $0" >&2
    printf '%s\n' "Optional: LOG_LINES=120 DEPLOY_DEBUG=0|1 SSH_BIN=ssh" >&2
}

log() {
    printf '  %s[INFO]%s %s\n' "$C_BLUE" "$C_RESET" "$*"
}

step() {
    STEP=$((STEP + 1))
    printf '\n%s[%02d] %s%s\n' "$C_BOLD" "$STEP" "$*" "$C_RESET"
}

ok() {
    printf '  %s[OK]%s %s\n' "$C_GREEN" "$C_RESET" "$*"
}

warn() {
    printf '  %s[WARN]%s %s\n' "$C_YELLOW" "$C_RESET" "$*"
}

die() {
    printf '%s[ERROR]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2
    exit 1
}

cleanup() {
    for file in $TMP_FILES; do
        [ -n "$file" ] && rm -f "$file"
    done
}

trap cleanup EXIT
trap 'cleanup; exit 129' HUP
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

validate_config() {
    [ -n "${OPENWRT_HOST:-}" ] || {
        usage
        exit 1
    }

    case "$OPENWRT_HOST" in
        *" "*|*"	"*) die "OPENWRT_HOST must not contain whitespace" ;;
    esac

    case "$LOG_LINES" in
        ""|*[!0-9]*) die "LOG_LINES must be a non-negative integer" ;;
    esac

    case "$DEPLOY_DEBUG" in
        0|1) ;;
        *) die "DEPLOY_DEBUG must be 0 or 1" ;;
    esac

    case "$SSH_BIN" in
        ""|*[!A-Za-z0-9_./-]*) die "SSH_BIN must be a command path without shell metacharacters" ;;
    esac
}

check_prerequisites() {
    command -v "$SSH_BIN" >/dev/null 2>&1 || die "SSH binary not found: $SSH_BIN"
    command -v tar >/dev/null 2>&1 || die "local tar command not found"
    [ -d "$ROOT_DIR/luci-app-fanxpert/root" ] || die "missing directory: $ROOT_DIR/luci-app-fanxpert/root"
    [ -d "$ROOT_DIR/luci-app-fanxpert/htdocs" ] || die "missing directory: $ROOT_DIR/luci-app-fanxpert/htdocs"
}

remote_target() {
    case "$OPENWRT_HOST" in
        *@*) printf '%s\n' "$OPENWRT_HOST" ;;
        *) printf 'root@%s\n' "$OPENWRT_HOST" ;;
    esac
}

run_remote() {
    "$SSH_BIN" "$TARGET" "$@"
}

run_remote_script() {
    "$SSH_BIN" "$TARGET" sh -s -- "$@"
}

check_remote_prerequisites() {
    run_remote_script <<'EOF'
command -v sh >/dev/null 2>&1 || exit 1
command -v tar >/dev/null 2>&1 || exit 1
command -v uci >/dev/null 2>&1 || exit 1
EOF
}

backup_remote_config() {
    run_remote_script <<'EOF'
if [ -f /etc/config/fanxpert ]; then
    cp /etc/config/fanxpert /tmp/fanxpert.config.deploy.bak
    echo "[config] existing /etc/config/fanxpert preserved"
else
    rm -f /tmp/fanxpert.config.deploy.bak
    echo "[config] no existing config; default template will be installed"
fi
EOF
}

restore_remote_config() {
    run_remote_script <<'EOF'
if [ -f /tmp/fanxpert.config.deploy.bak ]; then
    cp /tmp/fanxpert.config.deploy.bak /etc/config/fanxpert
    rm -f /tmp/fanxpert.config.deploy.bak
    echo "[config] restored existing /etc/config/fanxpert"
fi
EOF
}

install_remote_default_config() {
    run_remote_script <<'EOF'
if [ ! -f /etc/config/fanxpert ] && [ -f /etc/uci-defaults/80_fanxpert ]; then
    sh /etc/uci-defaults/80_fanxpert
    echo "[config] initialized /etc/config/fanxpert from uci-defaults"
else
    echo "[config] existing /etc/config/fanxpert kept"
fi
EOF
}

migrate_remote_config() {
    run_remote_script <<'EOF'
changed=0
for section in $(uci show fanxpert 2>/dev/null | sed -n "s/^fanxpert\.\([^.=]*\)=curve$/\1/p"); do
    case "$section" in
        silent|standard|performance)
            continue
            ;;
    esac

    if ! uci -q get "fanxpert.$section.label" >/dev/null; then
        uci set "fanxpert.$section.label=$section"
        changed=1
    fi

    if ! uci -q get "fanxpert.$section.sensor" >/dev/null; then
        uci set "fanxpert.$section.sensor=cpu_temp"
        changed=1
    fi
done

if [ "$changed" -eq 1 ]; then
    uci commit fanxpert
    echo "[config] migrated custom curve labels/sensors"
else
    echo "[config] no custom curve migration needed"
fi
EOF
}

copy_tree() {
    src="$1"
    dst="$2"

    [ -d "$src" ] || die "missing source directory: $src"
    case "$dst" in
        /*) ;;
        *) die "remote destination must be absolute: $dst" ;;
    esac
    case "$dst" in
        *"'"*) die "remote destination must not contain single quotes: $dst" ;;
    esac

    tar_file="$(mktemp "${TMPDIR:-/tmp}/fanxpert-deploy.XXXXXX")" || die "failed to create temporary tar file"
    TMP_FILES="$TMP_FILES $tar_file"

    (cd "$src" && COPYFILE_DISABLE=1 tar --exclude='._*' --exclude='.DS_Store' -cf "$tar_file" .) ||
        die "failed to archive $src"

    run_remote "mkdir -p '$dst' && tar -C '$dst' -xf -" < "$tar_file" ||
        die "failed to copy $src to $TARGET:$dst"

    rm -f "$tar_file"
}

cleanup_remote_files() {
    run_remote_script <<'EOF'
echo "[cleanup] removing macOS metadata files"
find /etc/config /etc/init.d /usr/share/luci/menu.d /usr/share/rpcd /www/luci-static/resources/fanxpert \
    -maxdepth 3 \( -name '._*' -o -name '.DS_Store' \) -exec rm -f {} + 2>/dev/null || true
echo "[cleanup] removing legacy Lua LuCI files"
rm -f /usr/lib/lua/luci/controller/fanxpert.lua 2>/dev/null || true
rm -f /usr/lib/lua/luci/model/cbi/fanxpert.lua 2>/dev/null || true
rm -rf /usr/lib/lua/luci/view/fanxpert 2>/dev/null || true
rm -f /www/luci-static/resources/fanxpert/curve.js 2>/dev/null || true
EOF
}

restart_remote_services() {
    run_remote_script "$DEPLOY_DEBUG" <<'EOF'
set -eu
DEPLOY_DEBUG="$1"

[ "$DEPLOY_DEBUG" = "1" ] && set -x

echo "[permissions] applying executable bits and ownership"
chmod +x /etc/init.d/fanxpert 2>/dev/null || true
chmod +x /usr/sbin/fanxpert.sh 2>/dev/null || true
chmod +x /usr/share/rpcd/ucode/fanxpert 2>/dev/null || true
chmod +x /etc/uci-defaults/80_fanxpert 2>/dev/null || true
chown root:root /etc/init.d/fanxpert /usr/sbin/fanxpert.sh 2>/dev/null || true
chown root:root /etc/config/fanxpert 2>/dev/null || true
chown root:root /etc/uci-defaults/80_fanxpert 2>/dev/null || true
chown root:root /usr/share/luci/menu.d/luci-app-fanxpert.json 2>/dev/null || true
chown root:root /usr/share/rpcd/acl.d/luci-app-fanxpert.json 2>/dev/null || true
chown root:root /usr/share/rpcd/ucode/fanxpert 2>/dev/null || true
chown -R root:root /www/luci-static/resources/fanxpert /www/luci-static/resources/view/fanxpert.js 2>/dev/null || true

echo "[rpcd] restarting RPC daemon"
if [ -x /etc/init.d/rpcd ]; then
    /etc/init.d/rpcd restart 2>/dev/null || true
else
    echo "[rpcd] init script not found; skipped"
fi

echo "[luci] clearing cache"
rm -rf /tmp/luci-* 2>/dev/null || true

echo "[uhttpd] reloading web server"
if [ -x /etc/init.d/uhttpd ]; then
    /etc/init.d/uhttpd reload 2>/dev/null || /etc/init.d/uhttpd restart 2>/dev/null || true
elif [ -x /etc/init.d/nginx ]; then
    /etc/init.d/nginx reload 2>/dev/null || /etc/init.d/nginx restart 2>/dev/null || true
else
    echo "[web] no uhttpd/nginx found; skipped"
fi

echo "[fanxpert] checking service"
if [ -f /etc/init.d/fanxpert ]; then
    if /etc/init.d/fanxpert enabled 2>/dev/null; then
        echo "[fanxpert] service is enabled, restarting..."
        /etc/init.d/fanxpert restart
    else
        echo "[fanxpert] service is disabled, skipped restart"
        echo "[fanxpert] to enable: /etc/init.d/fanxpert enable && /etc/init.d/fanxpert start"
    fi
else
    echo "[fanxpert] init script not deployed yet"
fi
EOF
}

print_installed_files() {
    run_remote_script <<'EOF'
echo "[FanXpert Files]"
echo "--- Config ---"
ls -lh /etc/config/fanxpert 2>/dev/null || echo "  (not found)"
echo "--- UCI Defaults ---"
ls -lh /etc/uci-defaults/80_fanxpert 2>/dev/null || echo "  (not found)"
echo "--- Init Script ---"
ls -lh /etc/init.d/fanxpert 2>/dev/null || echo "  (not found)"
echo "--- Main Script ---"
ls -lh /usr/sbin/fanxpert.sh 2>/dev/null || echo "  (not found)"
echo "--- LuCI Menu ---"
ls -lh /usr/share/luci/menu.d/luci-app-fanxpert.json 2>/dev/null || echo "  (not found)"
echo "--- RPCD ACL ---"
ls -lh /usr/share/rpcd/acl.d/luci-app-fanxpert.json 2>/dev/null || echo "  (not found)"
echo "--- RPCD ucode ---"
ls -lh /usr/share/rpcd/ucode/fanxpert 2>/dev/null || echo "  (not found)"
echo "--- Static Resources ---"
ls -lh /www/luci-static/resources/view/fanxpert.js 2>/dev/null || echo "  (view not found)"
ls -lh /www/luci-static/resources/fanxpert/fanxpert.css 2>/dev/null || echo "  (css not found)"
EOF
}

print_service_status() {
    run_remote_script <<'EOF'
echo "[Service Status]"
if [ -f /etc/init.d/fanxpert ]; then
    /etc/init.d/fanxpert status 2>&1 || echo "  Service not running"
else
    echo "  Init script not found"
fi

echo ""
echo "[Runtime Info]"
if [ -x /usr/sbin/fanxpert.sh ]; then
    /usr/sbin/fanxpert.sh info 2>&1 || echo "  No runtime data available"
else
    echo "  Main script not found"
fi

echo ""
echo "[Hardware Detection]"
echo "Temperature sensors:"
ls -l /sys/class/hwmon/hwmon*/temp*_input 2>/dev/null | head -5 || echo "  (none found)"
echo "PWM controllers:"
ls -l /sys/class/hwmon/hwmon*/pwm* 2>/dev/null | head -5 || echo "  (none found)"
EOF
}

print_recent_logs() {
    run_remote_script "$LOG_LINES" <<'EOF'
LOG_LINES="$1"
echo "[Recent FanXpert Logs]"
logread 2>/dev/null | grep -E '[[:space:]](daemon|user)\.[^[:space:]]+[[:space:]]+FANXPERT:' | grep -v '自动检测到' | tail -n "$LOG_LINES" || echo "  (no logs found)"
EOF
}

print_uci_config() {
    run_remote_script <<'EOF'
echo "[UCI Configuration]"
uci show fanxpert 2>/dev/null || echo "  (config not found or empty)"
EOF
}

validate_config
check_prerequisites
TARGET="$(remote_target)"

[ "$DEPLOY_DEBUG" = "1" ] && set -x

step "Deploy settings"
log "target: $TARGET"
log "log lines: $LOG_LINES"
log "debug: $DEPLOY_DEBUG"

step "Checking remote prerequisites"
check_remote_prerequisites || die "remote shell, tar, or uci command not available on $TARGET"
ok "remote prerequisites available"

step "Copying root filesystem files (config, init, scripts)"
backup_remote_config
copy_tree "$ROOT_DIR/luci-app-fanxpert/root" "/"
restore_remote_config
install_remote_default_config
migrate_remote_config
ok "root files copied"

step "Copying LuCI static files (JavaScript, CSS)"
copy_tree "$ROOT_DIR/luci-app-fanxpert/htdocs" "/www"
ok "LuCI static files copied"

step "Removing stale debug files"
cleanup_remote_files
ok "cleanup finished"

step "Restarting services"
restart_remote_services
ok "service reload sequence finished"

step "Installed files"
print_installed_files

step "UCI configuration"
print_uci_config

step "Service status and runtime info"
print_service_status

step "Recent logs"
print_recent_logs

step "Deploy complete"
ok "all deploy steps finished"
printf '\n%s[NEXT STEPS]%s\n' "$C_BOLD" "$C_RESET"
log "1. Access LuCI: http://$OPENWRT_HOST → System → FanXpert"
log "2. Enable service: uci set fanxpert.settings.enabled='1' && uci commit"
log "3. Start service: /etc/init.d/fanxpert enable && /etc/init.d/fanxpert start"
log "4. View logs: logread -f | grep FANXPERT"
log "5. Check status: /usr/sbin/fanxpert.sh status"
