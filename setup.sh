#!/usr/bin/env bash
# =============================================================================
#  ██╗   ██╗ ██████╗ ██╗  ████████╗ █████╗  ██████╗ ███████╗
#  ██║   ██║██╔═══██╗██║  ╚══██╔══╝██╔══██╗██╔════╝ ██╔════╝
#  ██║   ██║██║   ██║██║     ██║   ███████║██║  ███╗█████╗
#  ╚██╗ ██╔╝██║   ██║██║     ██║   ██╔══██║██║   ██║██╔══╝
#   ╚████╔╝ ╚██████╔╝███████╗██║   ██║  ██║╚██████╔╝███████╗
#    ╚═══╝   ╚═════╝ ╚══════╝╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚══════╝
#  Voltage Setup & Configuration Script — v2.0
#  Full TUI · Connection Testing · Root Escalation · Animations
# =============================================================================
# Do NOT use set -e — animations must never abort on non-zero subshell exits
set -uo pipefail

# ─── ANSI Colours & Styles ────────────────────────────────────────────────────
ESC=$'\033'
R="${ESC}[0m"
B="${ESC}[1m"
DIM="${ESC}[2m"
IT="${ESC}[3m"
UL="${ESC}[4m"

# Regular
BLK="${ESC}[30m" RED="${ESC}[31m" GRN="${ESC}[32m" YLW="${ESC}[33m"
BLU="${ESC}[34m" MAG="${ESC}[35m" CYN="${ESC}[36m" WHT="${ESC}[37m"

# Bright
BRED="${ESC}[91m"  BGRN="${ESC}[92m"  BYLW="${ESC}[93m"
BBLU="${ESC}[94m"  BMAG="${ESC}[95m"  BCYN="${ESC}[96m"  BWHT="${ESC}[97m"

# Background
BG_BLK="${ESC}[40m"  BG_RED="${ESC}[41m"  BG_GRN="${ESC}[42m"
BG_YLW="${ESC}[43m"  BG_BLU="${ESC}[44m"  BG_MAG="${ESC}[45m"
BG_CYN="${ESC}[46m"  BG_WHT="${ESC}[47m"

# ─── Terminal Dimensions ──────────────────────────────────────────────────────
COLS=80; ROWS=24
if command -v tput &>/dev/null; then
  _c=$(tput cols  2>/dev/null) && [[ "$_c" =~ ^[0-9]+$ ]] && (( _c > 0 )) && COLS=$_c
  _r=$(tput lines 2>/dev/null) && [[ "$_r" =~ ^[0-9]+$ ]] && (( _r > 0 )) && ROWS=$_r
fi

# ─── Cursor Helpers ───────────────────────────────────────────────────────────
cur_hide()  { printf '%s' "${ESC}[?25l"; }
cur_show()  { printf '%s' "${ESC}[?25h"; }
cur_up()    { printf '%s' "${ESC}[${1:-1}A"; }
cur_col()   { printf '%s' "${ESC}[${1:-1}G"; }
cur_save()  { printf '%s' "${ESC}[s"; }
cur_rest()  { printf '%s' "${ESC}[u"; }
clr_line()  { printf '%s' "${ESC}[2K"; }
clr_right() { printf '%s' "${ESC}[0K"; }

# Cleanup on exit
_SPIN_PID=0
_cleanup() {
  [[ $_SPIN_PID -ne 0 ]] && kill "$_SPIN_PID" 2>/dev/null; wait "$_SPIN_PID" 2>/dev/null || true
  cur_show
  printf '\n'
}
trap '_cleanup' EXIT INT TERM

# ─── Utility: repeat a char N times ──────────────────────────────────────────
rep() {
  local char="$1" n="$2" out=''
  local i=0; while (( i < n )); do out+="$char"; (( i++ )); done
  printf '%s' "$out"
}

# ─── Utility: pad string to width ────────────────────────────────────────────
pad_right() { printf "%-${2}s" "$1"; }
pad_left()  { printf "%${2}s"  "$1"; }

# ─── Center text (no ANSI in string) ─────────────────────────────────────────
center() {
  local str="$1" color="${2:-$R}" width="${3:-$COLS}"
  local len=${#str}
  local left=$(( (width - len) / 2 ))
  (( left < 0 )) && left=0
  printf '%*s%s%s%s\n' "$left" '' "$color" "$str" "$R"
}

# ─── Horizontal rule ─────────────────────────────────────────────────────────
hline() {
  local char="${1:--}" color="${2:-${DIM}${CYN}}"
  printf '%s%s%s\n' "$color" "$(rep "$char" "$COLS")" "$R"
}

hline_thin() {
  printf '%s%s%s\n' "${DIM}" "$(rep '─' "$COLS")" "$R"
}

# ─── Status line helpers ──────────────────────────────────────────────────────
ok()    { printf "  ${BGRN}✔${R}  %s\n"        "$*"; }
warn()  { printf "  ${BYLW}⚠${R}  %s\n"        "$*"; }
err()   { printf "  ${BRED}✖${R}  %s\n"        "$*"; }
info()  { printf "  ${BBLU}ℹ${R}  %s\n"        "$*"; }
step()  { printf "\n  ${BCYN}▶${R}  ${B}%s${R}\n" "$*"; }
note()  { printf "  ${DIM}%s${R}\n"             "$*"; }

# ─── Section banner ───────────────────────────────────────────────────────────
section() {
  printf '\n'
  hline '═' "${BBLU}"
  center "  $1  " "${B}${BWHT}"
  hline '═' "${BBLU}"
  printf '\n'
}

# ─── Sub-section ─────────────────────────────────────────────────────────────
subsection() {
  printf '\n'
  hline_thin
  printf "  ${B}${BCYN}%s${R}\n" "$1"
  hline_thin
  printf '\n'
}

# ─── Spinner ─────────────────────────────────────────────────────────────────
spin_start() {
  local msg="${1:-Working...}"
  cur_hide
  (
    local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
    local i=0
    while true; do
      local f="${frames[$((i % ${#frames[@]}))]}"
      printf '\r  %s%s%s  %s%s%s' "$BCYN" "$f" "$R" "$DIM" "$msg" "$R"
      sleep 0.08
      (( i++ ))
    done
  ) &
  _SPIN_PID=$!
}

spin_stop() {
  if [[ $_SPIN_PID -ne 0 ]]; then
    kill "$_SPIN_PID" 2>/dev/null
    wait "$_SPIN_PID" 2>/dev/null || true
    _SPIN_PID=0
  fi
  printf '\r%*s\r' "$COLS" ''
  cur_show
}

spin_ok()   { spin_stop; ok   "$*"; }
spin_warn() { spin_stop; warn "$*"; }
spin_err()  { spin_stop; err  "$*"; }

# ─── Progress bar ─────────────────────────────────────────────────────────────
progress_bar() {
  local current="$1" total="$2" label="${3:-}" width=$(( COLS - 20 ))
  (( width < 10 )) && width=10
  local filled=$(( current * width / total ))
  local empty=$(( width - filled ))
  local pct=$(( current * 100 / total ))
  local bar="${BGRN}$(rep '█' "$filled")${DIM}$(rep '░' "$empty")${R}"
  printf '\r  [%s] %s%3d%%%s  %s' "$bar" "$BYLW" "$pct" "$R" "$label"
}

# ─── Typewriter effect ────────────────────────────────────────────────────────
typewrite() {
  local str="$1" color="${2:-$R}" delay="${3:-0.012}"
  local i=0 len=${#str}
  while (( i < len )); do
    printf '%s%s%s' "$color" "${str:$i:1}" "$R"
    read -rt "$delay" _ </dev/null 2>/dev/null || true
    (( i++ ))
  done
}

# ─── ASCII Logo ───────────────────────────────────────────────────────────────
LOGO=(
  " _   _  ___  _    _____  _    ___  _____"
  "| | | |/ _ \| |  |_   _|/ \  / _ \| ____|"
  "| | | | | | | |    | | / _ \| | | |  _|"
  "| |_| | |_| | |___ | |/ ___ \ |_| | |___"
  " \___/ \___/|_____|_/_/   \_\___/|_____|"
)
LOGO_COLS=("$BBLU" "$BBLU" "$BCYN" "$BMAG" "$BMAG")

animate_logo() {
  printf '\n'
  local ri=0
  for row in "${LOGO[@]}"; do
    local col="${LOGO_COLS[$ri]:-$BMAG}"
    local len=${#row}
    local left=$(( (COLS - len) / 2 ))
    (( left < 0 )) && left=0
    printf '%*s' "$left" ''
    local i=0
    while (( i < len )); do
      printf '%s%s%s' "$col" "${row:$i:1}" "$R"
      read -rt 0.003 _ </dev/null 2>/dev/null || true
      (( i++ ))
    done
    printf '\n'
    (( ri++ ))
  done
  printf '\n'
  local sub="⚡  The Decentralized Chat Platform  ⚡"
  local sl=${#sub}
  local sleft=$(( (COLS - sl) / 2 ))
  (( sleft < 0 )) && sleft=0
  printf '%*s' "$sleft" ''
  typewrite "$sub" "${B}${BYLW}" 0.018
  printf '\n\n'
}

# ─── Boot sequence ────────────────────────────────────────────────────────────
boot_sequence() {
  clear
  animate_logo

  # Initialising dots
  cur_hide
  local i=0
  while (( i < 18 )); do
    local dots=''
    case $(( i % 4 )) in 1) dots='.' ;; 2) dots='..' ;; 3) dots='...' ;; esac
    local msg="  Initialising Voltage Setup${dots}"
    local mlen=${#msg}
    local left=$(( (COLS - mlen) / 2 ))
    (( left < 0 )) && left=0
    printf '\r%*s%s%s%s%s%s' "$left" '' "$CYN" "  Initialising Voltage Setup" "$BYLW" "$dots" "$R"
    sleep 0.11
    (( i++ ))
  done
  printf '\r%*s\r\n' "$COLS" ''
  cur_show

  # Charging bar
  local label="  ⚡ Charging the Volt..."
  center "$label" "$DIM"
  printf '\n'
  local bw=$(( COLS - 8 ))
  (( bw < 10 )) && bw=10
  local bleft=$(( (COLS - bw - 2) / 2 ))
  (( bleft < 0 )) && bleft=0
  printf '%*s%s[%s' "$bleft" '' "$BBLU" "$R"
  local bi=0
  while (( bi < bw )); do
    printf '%s█%s' "$BBLU" "$R"
    read -rt 0.012 _ </dev/null 2>/dev/null || true
    (( bi++ ))
  done
  printf '%s]%s\n\n' "$BBLU" "$R"
  sleep 0.2
}

# ─── Input helpers ────────────────────────────────────────────────────────────
ask() {
  local _var="$1" _prompt="$2" _def="${3:-}" _val=''
  if [[ -n "$_def" ]]; then
    printf '  %s?%s  %s%-36s%s %s(%s)%s: ' "$BCYN" "$R" "$B" "$_prompt" "$R" "$DIM" "$_def" "$R"
  else
    printf '  %s?%s  %s%-36s%s: ' "$BCYN" "$R" "$B" "$_prompt" "$R"
  fi
  IFS= read -r _val || true
  [[ -z "$_val" ]] && _val="$_def"
  printf -v "$_var" '%s' "$_val"
}

ask_secret() {
  local _var="$1" _prompt="$2" _val=''
  printf '  %s🔑%s  %s%-36s%s: ' "$BMAG" "$R" "$B" "$_prompt" "$R"
  IFS= read -rs _val || true
  printf '\n'
  printf -v "$_var" '%s' "$_val"
}

ask_yn() {
  local _var="$1" _prompt="$2" _def="${3:-y}" _ans=''
  local _d
  [[ "$_def" == "y" ]] && _d="${BGRN}Y${R}${DIM}/n${R}" || _d="${DIM}y/${R}${BGRN}N${R}"
  printf '  %s?%s  %s%-36s%s [%s]: ' "$BCYN" "$R" "$B" "$_prompt" "$R" "$_d"
  IFS= read -r _ans || true
  [[ -z "$_ans" ]] && _ans="$_def"
  if [[ "${_ans,,}" =~ ^y ]]; then printf -v "$_var" 'true'
  else printf -v "$_var" 'false'; fi
}

ask_int() {
  local _var="$1" _prompt="$2" _def="${3:-}" _val=''
  while true; do
    if [[ -n "$_def" ]]; then
      printf '  %s?%s  %s%-36s%s %s(%s)%s: ' "$BCYN" "$R" "$B" "$_prompt" "$R" "$DIM" "$_def" "$R"
    else
      printf '  %s?%s  %s%-36s%s: ' "$BCYN" "$R" "$B" "$_prompt" "$R"
    fi
    IFS= read -r _val || true
    [[ -z "$_val" ]] && _val="$_def"
    if [[ "$_val" =~ ^[0-9]+$ ]]; then
      printf -v "$_var" '%s' "$_val"
      return
    fi
    warn "Please enter a valid number."
  done
}

# Numbered menu — sets _var to the KEY (first word) of the chosen option
ask_menu() {
  local _var="$1" _prompt="$2"; shift 2
  local _opts=("$@") _i=1 _ch=''
  printf '\n'
  hline_thin
  printf '  %s%s%s\n\n' "${B}${BCYN}" "$_prompt" "$R"
  for _o in "${_opts[@]}"; do
    local _key="${_o%%|*}"
    local _desc="${_o#*|}"
    printf '    %s%2d)%s  %s%-18s%s  %s%s%s\n' \
      "$BYLW" "$_i" "$R" \
      "$B" "$_key" "$R" \
      "$DIM" "$_desc" "$R"
    (( _i++ ))
  done
  printf '\n'
  hline_thin
  while true; do
    printf '  %s▶%s  Enter number %s[1-%d]%s: ' "$BCYN" "$R" "$DIM" "${#_opts[@]}" "$R"
    IFS= read -r _ch || true
    [[ -z "$_ch" ]] && _ch=1
    if [[ "$_ch" =~ ^[0-9]+$ ]] && (( _ch >= 1 && _ch <= ${#_opts[@]} )); then
      local _sel="${_opts[$((_ch-1))]}"
      printf -v "$_var" '%s' "${_sel%%|*}"
      printf '\n'
      return
    fi
    warn "Invalid choice. Enter a number between 1 and ${#_opts[@]}."
  done
}

# ─── JWT generator ────────────────────────────────────────────────────────────
gen_jwt() {
  if command -v openssl &>/dev/null; then
    openssl rand -base64 48 2>/dev/null
  else
    node -e "process.stdout.write(require('crypto').randomBytes(48).toString('base64'))"
  fi
}

gen_secret() {
  if command -v openssl &>/dev/null; then
    openssl rand -base64 24 2>/dev/null | tr -d '=+/' | head -c 24
  else
    node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex').slice(0,24))"
  fi
}

# ─── Root / sudo helpers ──────────────────────────────────────────────────────
IS_ROOT=false
[[ $EUID -eq 0 ]] && IS_ROOT=true

need_root() {
  # Call this before any operation that needs root.
  # If already root, returns immediately.
  # Otherwise prompts the user and re-execs with sudo.
  if $IS_ROOT; then return 0; fi
  printf '\n'
  hline '─' "${BYLW}"
  printf '  %s%s⚠  Root / sudo required%s\n' "$B" "$BYLW" "$R"
  printf '  %sThe next step needs elevated privileges:%s\n' "$DIM" "$R"
  printf '  %s%s%s\n' "$IT" "$1" "$R"
  hline '─' "${BYLW}"
  printf '\n  %sRe-launching with sudo...%s\n\n' "$DIM" "$R"
  exec sudo bash "$0" "$@"
}

run_as_root() {
  # Run a command as root (sudo if not already root)
  if $IS_ROOT; then
    "$@"
  else
    sudo "$@"
  fi
}

# ─── Connection testers ───────────────────────────────────────────────────────
test_mariadb() {
  local host="$1" port="$2" db="$3" user="$4" pass="$5"
  if command -v mysql &>/dev/null; then
    mysql -h"$host" -P"$port" -u"$user" -p"$pass" -e "SELECT 1;" "$db" &>/dev/null
    return $?
  elif command -v node &>/dev/null; then
    node -e "
const m=require('mariadb');
m.createConnection({host:'$host',port:$port,database:'$db',user:'$user',password:'$pass'})
 .then(c=>{c.end();process.exit(0)}).catch(()=>process.exit(1))
" 2>/dev/null
    return $?
  fi
  return 2  # can't test
}

test_mysql() {
  local host="$1" port="$2" db="$3" user="$4" pass="$5"
  if command -v mysql &>/dev/null; then
    mysql -h"$host" -P"$port" -u"$user" -p"$pass" -e "SELECT 1;" "$db" &>/dev/null
    return $?
  fi
  return 2
}

test_postgres() {
  local host="$1" port="$2" db="$3" user="$4" pass="$5"
  if command -v psql &>/dev/null; then
    PGPASSWORD="$pass" psql -h "$host" -p "$port" -U "$user" -d "$db" -c "SELECT 1;" &>/dev/null
    return $?
  fi
  return 2
}

test_redis() {
  local host="$1" port="$2" pass="$3"
  if command -v redis-cli &>/dev/null; then
    if [[ -n "$pass" ]]; then
      redis-cli -h "$host" -p "$port" -a "$pass" PING 2>/dev/null | grep -q PONG
    else
      redis-cli -h "$host" -p "$port" PING 2>/dev/null | grep -q PONG
    fi
    return $?
  fi
  return 2
}

test_mongodb() {
  local host="$1" port="$2" db="$3" user="$4" pass="$5"
  if command -v mongosh &>/dev/null; then
    local uri="mongodb://"
    [[ -n "$user" ]] && uri+="${user}:${pass}@"
    uri+="${host}:${port}/${db}"
    mongosh --quiet --eval "db.runCommand({ping:1})" "$uri" &>/dev/null
    return $?
  fi
  return 2
}

test_http() {
  local url="$1"
  if command -v curl &>/dev/null; then
    curl -sf --max-time 5 "$url" &>/dev/null
    return $?
  elif command -v wget &>/dev/null; then
    wget -q --timeout=5 -O /dev/null "$url" &>/dev/null
    return $?
  fi
  return 2
}

test_smtp() {
  local host="$1" port="$2"
  if command -v curl &>/dev/null; then
    curl -sf --max-time 5 "smtp://${host}:${port}" &>/dev/null
    return $?
  fi
  # fallback: just check TCP
  if command -v nc &>/dev/null; then
    nc -z -w5 "$host" "$port" &>/dev/null
    return $?
  fi
  return 2
}

# ─── Dependency check ─────────────────────────────────────────────────────────
check_deps() {
  section "Checking Dependencies"
  local missing=()

  for cmd in node npm; do
    if command -v "$cmd" &>/dev/null; then
      local ver; ver=$("$cmd" --version 2>/dev/null | head -1)
      ok "${B}${cmd}${R}  ${DIM}${ver}${R}"
    else
      err "${B}${cmd}${R} not found"
      missing+=("$cmd")
    fi
  done

  if command -v node &>/dev/null; then
    local nmaj
    nmaj=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))" 2>/dev/null || echo 0)
    if (( nmaj < 18 )); then
      err "Node.js v${nmaj} detected — Voltage requires v18+"
      missing+=("node>=18")
    else
      ok "${B}Node.js${R} version ${DIM}v${nmaj}${R} ✓"
    fi
  fi

  for cmd in git openssl curl jq; do
    if command -v "$cmd" &>/dev/null; then
      ok "${B}${cmd}${R}  ${DIM}(available)${R}"
    else
      warn "${B}${cmd}${R}  ${DIM}(optional — not found)${R}"
    fi
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    printf '\n'
    err "Missing required tools: ${missing[*]}"
    err "Please install them and re-run setup."
    exit 1
  fi
  printf '\n'
  ok "All required dependencies satisfied"
}

# ─── npm install ─────────────────────────────────────────────────────────────
install_npm_deps() {
  section "Installing Node.js Packages"
  spin_start "Running npm install..."
  if npm install --silent 2>/dev/null; then
    spin_ok "npm packages installed successfully"
  else
    spin_warn "Silent install failed — retrying with output..."
    npm install || { err "npm install failed. Fix errors above and re-run."; exit 1; }
    ok "npm packages installed"
  fi
}

# ─── Filesystem setup ─────────────────────────────────────────────────────────
create_dirs() {
  section "Preparing Filesystem"
  spin_start "Creating required directories..."
  mkdir -p data uploads logs
  spin_ok "Directories ready  ${DIM}(data/  uploads/  logs/)${R}"

  # Fix permissions if running as root
  if $IS_ROOT; then
    spin_start "Setting directory permissions..."
    chmod 750 data uploads logs 2>/dev/null || true
    spin_ok "Permissions set"
  fi
}

# ─── Systemd service installer ────────────────────────────────────────────────
install_systemd() {
  local svc_dir="/etc/systemd/system"
  local install_svc=false

  if [[ -d "$svc_dir" ]] && command -v systemctl &>/dev/null; then
    printf '\n'
    ask_yn _INSTALL_SVC "Install systemd service units?" "y"
    install_svc="$_INSTALL_SVC"
  fi

  if [[ "$install_svc" == "true" ]]; then
    need_root "Installing systemd service units to ${svc_dir}"
    subsection "Installing Systemd Services"
    local svcs=(voltage-api voltage-cdn voltage-federation voltage-websocket voltage-worker)
    for svc in "${svcs[@]}"; do
      local src="${svc}.service"
      if [[ -f "$src" ]]; then
        spin_start "Installing ${svc}.service..."
        run_as_root cp "$src" "${svc_dir}/${svc}.service"
        spin_ok "${svc}.service installed"
      else
        warn "${src} not found — skipping"
      fi
    done
    spin_start "Reloading systemd daemon..."
    run_as_root systemctl daemon-reload
    spin_ok "systemd daemon reloaded"
    printf '\n'
    info "Enable services with:  ${B}sudo systemctl enable voltage-api${R}"
    info "Start services with:   ${B}sudo systemctl start  voltage-api${R}"
  fi
}

# ─── Nginx config helper ──────────────────────────────────────────────────────
setup_nginx() {
  if ! command -v nginx &>/dev/null; then return; fi
  printf '\n'
  ask_yn _SETUP_NGINX "Configure nginx reverse proxy?" "n"
  if [[ "$_SETUP_NGINX" != "true" ]]; then return; fi

  need_root "Writing nginx configuration"
  subsection "Nginx Configuration"

  local nginx_conf="/etc/nginx/sites-available/voltage"
  local nginx_en="/etc/nginx/sites-enabled/voltage"

  spin_start "Writing nginx config..."
  run_as_root tee "$nginx_conf" >/dev/null <<NGINXEOF
# Voltage — generated by setup.sh $(date -u '+%Y-%m-%d %H:%M UTC')
server {
    listen 80;
    server_name ${CFG_SERVER_URL_HOST:-localhost};

    client_max_body_size ${CFG_MAX_UPLOAD_MB:-100}m;

    location / {
        proxy_pass http://127.0.0.1:${CFG_PORT:-5000};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
    }
}
NGINXEOF
  spin_ok "nginx config written to ${nginx_conf}"

  if [[ ! -L "$nginx_en" ]]; then
    spin_start "Enabling nginx site..."
    run_as_root ln -sf "$nginx_conf" "$nginx_en"
    spin_ok "nginx site enabled"
  fi

  spin_start "Testing nginx config..."
  if run_as_root nginx -t &>/dev/null; then
    spin_ok "nginx config valid"
    spin_start "Reloading nginx..."
    run_as_root systemctl reload nginx 2>/dev/null || run_as_root nginx -s reload 2>/dev/null || true
    spin_ok "nginx reloaded"
  else
    spin_warn "nginx config test failed — check manually with: sudo nginx -t"
  fi
}

# ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ──
#  WIZARD SECTIONS
# ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ──

# ── 1. Server Identity ────────────────────────────────────────────────────────
wizard_server() {
  subsection "Server Identity"

  ask CFG_NAME        "Server name"                    "Volt"
  ask CFG_VERSION     "Server version"                 "1.0.0"
  ask CFG_URL         "Public URL (with https://)"     "https://volt.voltagechat.app"
  ask CFG_HOST        "Bind host"                      "localhost"
  ask_int CFG_PORT    "Bind port"                      "5000"
  ask CFG_IMG_URL     "Image server URL"               "https://api.enclicainteractive.com"
  ask CFG_DESCRIPTION "Server description"             "Volt - Decentralized Chat Platform"

  ask_menu CFG_MODE "Server mode" \
    "mainline|Connect to the main Volt network (recommended)" \
    "self-volt|Standalone / private instance" \
    "federated|Federate with other Volt servers"

  # Derive hostname from URL for nginx / federation
  CFG_SERVER_URL_HOST=$(node -e "try{process.stdout.write(new URL('$CFG_URL').hostname)}catch(e){process.stdout.write('localhost')}" 2>/dev/null || echo "localhost")
}

# ── 2. Branding ───────────────────────────────────────────────────────────────
wizard_branding() {
  subsection "Branding"
  ask CFG_PRIMARY_COLOR "Primary colour (hex)"   "#ffb900"
  ask CFG_ACCENT_COLOR  "Accent colour (hex)"    "#ffce4d"
  ask CFG_LOGO          "Logo URL (or leave blank for none)" ""
  [[ -z "$CFG_LOGO" ]] && CFG_LOGO="null" || CFG_LOGO="\"${CFG_LOGO}\""
}

# ── 3. Storage ────────────────────────────────────────────────────────────────
wizard_storage() {
  subsection "Storage Backend"

  ask_menu CFG_STORAGE "Primary database engine" \
    "json|Flat JSON files — zero config, for testing only" \
    "sqlite|SQLite — single file, no server needed (recommended for small)" \
    "mariadb|MariaDB — recommended for production" \
    "mysql|MySQL" \
    "postgres|PostgreSQL" \
    "cockroachdb|CockroachDB" \
    "mssql|Microsoft SQL Server" \
    "mongodb|MongoDB" \
    "redis|Redis (as primary store)"

  # Defaults per engine
  CFG_DB_HOST='localhost'; CFG_DB_PORT=''; CFG_DB_NAME='voltchat'
  CFG_DB_USER=''; CFG_DB_PASS=''; CFG_DB_CHARSET='utf8mb4'
  CFG_DB_SSL='false'; CFG_DB_CONN_LIMIT=10
  CFG_SQLITE_PATH='./data/voltage.db'
  CFG_JSON_DIR='/app/data'

  case "$CFG_STORAGE" in
    json)
      ask CFG_JSON_DIR "JSON data directory" "/app/data"
      ;;
    sqlite)
      ask CFG_SQLITE_PATH "SQLite database path" "./data/voltage.db"
      ;;
    mariadb)
      ask     CFG_DB_HOST  "MariaDB host"     "199.192.21.113"
      ask_int CFG_DB_PORT  "MariaDB port"     "5502"
      ask     CFG_DB_NAME  "Database name"    "voltchat"
      ask     CFG_DB_USER  "Database user"    "voltchat"
      ask_secret CFG_DB_PASS "Database password"
      ask_int CFG_DB_CONN_LIMIT "Connection pool limit" "10"
      _test_db_connection "mariadb"
      ;;
    mysql)
      ask     CFG_DB_HOST  "MySQL host"       "localhost"
      ask_int CFG_DB_PORT  "MySQL port"       "3306"
      ask     CFG_DB_NAME  "Database name"    "voltchat"
      ask     CFG_DB_USER  "Database user"    "root"
      ask_secret CFG_DB_PASS "Database password"
      ask_int CFG_DB_CONN_LIMIT "Connection pool limit" "10"
      _test_db_connection "mysql"
      ;;
    postgres)
      ask     CFG_DB_HOST  "PostgreSQL host"  "localhost"
      ask_int CFG_DB_PORT  "PostgreSQL port"  "5432"
      ask     CFG_DB_NAME  "Database name"    "voltchat"
      ask     CFG_DB_USER  "Database user"    "postgres"
      ask_secret CFG_DB_PASS "Database password"
      ask_yn  CFG_DB_SSL   "Use SSL?"         "n"
      _test_db_connection "postgres"
      ;;
    cockroachdb)
      ask     CFG_DB_HOST  "CockroachDB host" "localhost"
      ask_int CFG_DB_PORT  "CockroachDB port" "26257"
      ask     CFG_DB_NAME  "Database name"    "voltchat"
      ask     CFG_DB_USER  "Database user"    "root"
      ask_secret CFG_DB_PASS "Database password"
      CFG_DB_SSL='true'
      _test_db_connection "postgres"  # uses psql
      ;;
    mssql)
      ask     CFG_DB_HOST  "SQL Server host"  "localhost"
      ask_int CFG_DB_PORT  "SQL Server port"  "1433"
      ask     CFG_DB_NAME  "Database name"    "voltchat"
      ask     CFG_DB_USER  "Database user"    "sa"
      ask_secret CFG_DB_PASS "Database password"
      ;;
    mongodb)
      ask     CFG_DB_HOST  "MongoDB host"     "localhost"
      ask_int CFG_DB_PORT  "MongoDB port"     "27017"
      ask     CFG_DB_NAME  "Database name"    "voltchat"
      ask     CFG_DB_USER  "MongoDB user (blank if none)" ""
      [[ -n "$CFG_DB_USER" ]] && ask_secret CFG_DB_PASS "MongoDB password"
      _test_db_connection "mongodb"
      ;;
    redis)
      ask     CFG_DB_HOST  "Redis host"       "localhost"
      ask_int CFG_DB_PORT  "Redis port"       "6379"
      ask_secret CFG_DB_PASS "Redis password (blank if none)"
      ask_int CFG_DB_NAME  "Redis DB number"  "0"
      _test_db_connection "redis"
      ;;
  esac
}

_test_db_connection() {
  local engine="$1"
  printf '\n'
  spin_start "Testing ${engine} connection..."
  local rc=2
  case "$engine" in
    mariadb) test_mariadb "$CFG_DB_HOST" "$CFG_DB_PORT" "$CFG_DB_NAME" "$CFG_DB_USER" "$CFG_DB_PASS"; rc=$? ;;
    mysql)   test_mysql   "$CFG_DB_HOST" "$CFG_DB_PORT" "$CFG_DB_NAME" "$CFG_DB_USER" "$CFG_DB_PASS"; rc=$? ;;
    postgres) test_postgres "$CFG_DB_HOST" "$CFG_DB_PORT" "$CFG_DB_NAME" "$CFG_DB_USER" "$CFG_DB_PASS"; rc=$? ;;
    mongodb) test_mongodb  "$CFG_DB_HOST" "$CFG_DB_PORT" "$CFG_DB_NAME" "$CFG_DB_USER" "$CFG_DB_PASS"; rc=$? ;;
    redis)   test_redis    "$CFG_DB_HOST" "$CFG_DB_PORT" "$CFG_DB_PASS"; rc=$? ;;
  esac
  case $rc in
    0) spin_ok  "Database connection ${BGRN}successful${R}" ;;
    2) spin_warn "Cannot test ${engine} connection — client tool not found. Continuing anyway." ;;
    *) spin_warn "Database connection ${BRED}failed${R} — check credentials. Continuing anyway." ;;
  esac
}

# ── 4. CDN ────────────────────────────────────────────────────────────────────
wizard_cdn() {
  subsection "CDN / File Storage"

  ask_yn CFG_CDN_ENABLED "Enable CDN?" "y"

  if [[ "$CFG_CDN_ENABLED" == "true" ]]; then
    ask_menu CFG_CDN_PROVIDER "CDN provider" \
      "local|Local disk (default)" \
      "nfs|NFS shared mount (multi-node)" \
      "s3|AWS S3 or S3-compatible" \
      "cloudflare|Cloudflare R2"

    CFG_CDN_LOCAL_DIR='./uploads'; CFG_CDN_LOCAL_URL='null'
    CFG_CDN_NFS_DIR='null'; CFG_CDN_NFS_URL='null'
    CFG_S3_BUCKET='my-volt-media'; CFG_S3_REGION='us-east-1'
    CFG_S3_KEY=''; CFG_S3_SECRET=''; CFG_S3_ENDPOINT='null'
    CFG_S3_PUBLIC_URL='https://cdn.mydomain.com'
    CFG_CF_ACCOUNT='null'; CFG_CF_BUCKET='null'
    CFG_CF_KEY='null'; CFG_CF_SECRET='null'; CFG_CF_URL='null'

    case "$CFG_CDN_PROVIDER" in
      local)
        ask CFG_CDN_LOCAL_DIR "Upload directory"  "./uploads"
        ask CFG_CDN_LOCAL_URL "Base URL (blank=auto)" ""
        [[ -z "$CFG_CDN_LOCAL_URL" ]] && CFG_CDN_LOCAL_URL='null' || CFG_CDN_LOCAL_URL="\"${CFG_CDN_LOCAL_URL}\""
        ;;
      nfs)
        ask CFG_CDN_NFS_DIR "NFS mount path"    "/www/shared_uploads"
        ask CFG_CDN_NFS_URL "Base URL (blank=auto)" ""
        [[ -z "$CFG_CDN_NFS_URL" ]] && CFG_CDN_NFS_URL='null' || CFG_CDN_NFS_URL="\"${CFG_CDN_NFS_URL}\""
        ;;
      s3)
        ask        CFG_S3_BUCKET   "S3 bucket name"          "my-volt-media"
        ask        CFG_S3_REGION   "S3 region"               "us-east-1"
        ask        CFG_S3_KEY      "S3 access key ID"        ""
        ask_secret CFG_S3_SECRET   "S3 secret access key"
        ask        CFG_S3_ENDPOINT "S3 endpoint (blank=AWS)" ""
        ask        CFG_S3_PUBLIC_URL "Public CDN URL"        "https://cdn.mydomain.com"
        [[ -z "$CFG_S3_ENDPOINT" ]] && CFG_S3_ENDPOINT='null' || CFG_S3_ENDPOINT="\"${CFG_S3_ENDPOINT}\""
        ;;
      cloudflare)
        ask        CFG_CF_ACCOUNT  "Cloudflare account ID"   ""
        ask        CFG_CF_BUCKET   "R2 bucket name"          ""
        ask        CFG_CF_KEY      "R2 access key ID"        ""
        ask_secret CFG_CF_SECRET   "R2 secret access key"
        ask        CFG_CF_URL      "R2 public URL"           ""
        for v in CFG_CF_ACCOUNT CFG_CF_BUCKET CFG_CF_KEY CFG_CF_SECRET CFG_CF_URL; do
          [[ -z "${!v}" ]] && printf -v "$v" 'null' || printf -v "$v" '"%s"' "${!v}"
        done
        ;;
    esac
  else
    CFG_CDN_PROVIDER='local'
    CFG_CDN_LOCAL_DIR='./uploads'; CFG_CDN_LOCAL_URL='null'
    CFG_CDN_NFS_DIR='null'; CFG_CDN_NFS_URL='null'
    CFG_S3_BUCKET='my-volt-media'; CFG_S3_REGION='us-east-1'
    CFG_S3_KEY=''; CFG_S3_SECRET=''; CFG_S3_ENDPOINT='null'
    CFG_S3_PUBLIC_URL='https://cdn.mydomain.com'
    CFG_CF_ACCOUNT='null'; CFG_CF_BUCKET='null'
    CFG_CF_KEY='null'; CFG_CF_SECRET='null'; CFG_CF_URL='null'
  fi
}

# ── 5. Cache ──────────────────────────────────────────────────────────────────
wizard_cache() {
  subsection "Cache"

  ask_yn CFG_CACHE_ENABLED "Enable caching?" "y"
  CFG_CACHE_PROVIDER='memory'
  CFG_CACHE_REDIS_HOST='localhost'; CFG_CACHE_REDIS_PORT='6379'
  CFG_CACHE_REDIS_PASS=''; CFG_CACHE_REDIS_DB='1'

  if [[ "$CFG_CACHE_ENABLED" == "true" ]]; then
    ask_menu CFG_CACHE_PROVIDER "Cache provider" \
      "memory|In-process memory (single node only)" \
      "redis|Redis (recommended for multi-node)"

    if [[ "$CFG_CACHE_PROVIDER" == "redis" ]]; then
      ask     CFG_CACHE_REDIS_HOST "Redis host"     "199.192.21.113"
      ask_int CFG_CACHE_REDIS_PORT "Redis port"     "6379"
      ask_secret CFG_CACHE_REDIS_PASS "Redis password"
      ask_int CFG_CACHE_REDIS_DB   "Redis DB index" "1"

      printf '\n'
      spin_start "Testing cache Redis connection..."
      local rc=2
      test_redis "$CFG_CACHE_REDIS_HOST" "$CFG_CACHE_REDIS_PORT" "$CFG_CACHE_REDIS_PASS"; rc=$?
      case $rc in
        0) spin_ok  "Cache Redis connection ${BGRN}successful${R}" ;;
        2) spin_warn "Cannot test Redis — redis-cli not found. Continuing." ;;
        *) spin_warn "Cache Redis connection ${BRED}failed${R} — check credentials." ;;
      esac
    fi
  fi
}

# ── 6. Queue ──────────────────────────────────────────────────────────────────
wizard_queue() {
  subsection "Message Queue"

  ask_yn CFG_QUEUE_ENABLED "Enable message queue?" "y"
  CFG_QUEUE_PROVIDER='memory'
  CFG_QUEUE_REDIS_HOST='localhost'; CFG_QUEUE_REDIS_PORT='6379'
  CFG_QUEUE_REDIS_PASS=''; CFG_QUEUE_REDIS_DB='1'

  if [[ "$CFG_QUEUE_ENABLED" == "true" ]]; then
    ask_menu CFG_QUEUE_PROVIDER "Queue provider" \
      "memory|In-process memory (single node only)" \
      "redis|Redis (recommended for multi-node)"

    if [[ "$CFG_QUEUE_PROVIDER" == "redis" ]]; then
      ask     CFG_QUEUE_REDIS_HOST "Redis host"     "199.192.21.113"
      ask_int CFG_QUEUE_REDIS_PORT "Redis port"     "6379"
      ask_secret CFG_QUEUE_REDIS_PASS "Redis password"
      ask_int CFG_QUEUE_REDIS_DB   "Redis DB index" "1"

      printf '\n'
      spin_start "Testing queue Redis connection..."
      local rc=2
      test_redis "$CFG_QUEUE_REDIS_HOST" "$CFG_QUEUE_REDIS_PORT" "$CFG_QUEUE_REDIS_PASS"; rc=$?
      case $rc in
        0) spin_ok  "Queue Redis connection ${BGRN}successful${R}" ;;
        2) spin_warn "Cannot test Redis — redis-cli not found. Continuing." ;;
        *) spin_warn "Queue Redis connection ${BRED}failed${R} — check credentials." ;;
      esac
    fi
  fi
}

# ── 7. Authentication ─────────────────────────────────────────────────────────
wizard_auth() {
  subsection "Authentication"

  # Local auth
  step "Local Authentication"
  ask_yn CFG_LOCAL_AUTH_ENABLED "Enable local (username/password) auth?" "y"
  ask_yn CFG_ALLOW_REG          "Allow new user registration?"           "y"
  ask_yn CFG_REQUIRE_EMAIL_VER  "Require email verification?"            "n"
  ask_int CFG_MIN_PASS_LEN      "Minimum password length"                "8"
  ask_int CFG_MAX_PASS_LEN      "Maximum password length"                "128"
  ask_yn CFG_PASS_UPPER         "Require uppercase letters?"             "n"
  ask_yn CFG_PASS_NUMBERS       "Require numbers?"                       "y"
  ask_yn CFG_PASS_SYMBOLS       "Require symbols?"                       "n"

  # OAuth
  printf '\n'
  step "OAuth / SSO"
  ask_yn CFG_OAUTH_ENABLED "Enable OAuth login?" "y"
  CFG_OAUTH_PROVIDER='enclica'
  CFG_ENCLICA_CLIENT_ID=''
  CFG_ENCLICA_AUTH_URL='https://api.enclicainteractive.com/oauth/authorize'
  CFG_ENCLICA_TOKEN_URL='https://api.enclicainteractive.com/api/oauth/token'
  CFG_ENCLICA_USERINFO_URL='https://api.enclicainteractive.com/api/user/me'
  CFG_ENCLICA_REVOKE_URL='https://api.enclicainteractive.com/api/oauth/revoke'

  if [[ "$CFG_OAUTH_ENABLED" == "true" ]]; then
    ask_menu CFG_OAUTH_PROVIDER "OAuth provider" \
      "enclica|Enclica Interactive (default)"

    if [[ "$CFG_OAUTH_PROVIDER" == "enclica" ]]; then
      ask CFG_ENCLICA_CLIENT_ID    "Enclica client ID"       ""
      ask CFG_ENCLICA_AUTH_URL     "Auth URL"                "https://api.enclicainteractive.com/oauth/authorize"
      ask CFG_ENCLICA_TOKEN_URL    "Token URL"               "https://api.enclicainteractive.com/api/oauth/token"
      ask CFG_ENCLICA_USERINFO_URL "User info URL"           "https://api.enclicainteractive.com/api/user/me"
      ask CFG_ENCLICA_REVOKE_URL   "Revoke URL"              "https://api.enclicainteractive.com/api/oauth/revoke"
    fi
  fi

  # Email
  printf '\n'
  step "Email / SMTP"
  ask_yn CFG_EMAIL_ENABLED "Enable email sending?" "y"
  CFG_EMAIL_PROVIDER='smtp'
  CFG_SMTP_HOST='mail.enclicainteractive.com'; CFG_SMTP_PORT='587'
  CFG_SMTP_SECURE='true'; CFG_SMTP_USER=''; CFG_SMTP_PASS=''
  CFG_SMTP_FROM='noreply@voltagechat.app'; CFG_SMTP_FROM_NAME='VoltChat'
  CFG_SG_KEY='null'; CFG_SG_FROM='noreply@voltagechat.app'; CFG_SG_FROM_NAME='VoltChat'
  CFG_MG_KEY='null'; CFG_MG_DOMAIN=''; CFG_MG_FROM='noreply@voltagechat.app'; CFG_MG_FROM_NAME='VoltChat'

  if [[ "$CFG_EMAIL_ENABLED" == "true" ]]; then
    ask_menu CFG_EMAIL_PROVIDER "Email provider" \
      "smtp|SMTP (recommended)" \
      "sendgrid|SendGrid" \
      "mailgun|Mailgun"

    case "$CFG_EMAIL_PROVIDER" in
      smtp)
        ask     CFG_SMTP_HOST      "SMTP host"              "mail.enclicainteractive.com"
        ask_int CFG_SMTP_PORT      "SMTP port"              "587"
        ask_yn  CFG_SMTP_SECURE    "Use TLS/SSL?"           "y"
        ask     CFG_SMTP_USER      "SMTP username"          "volt@enclicainteractive.com"
        ask_secret CFG_SMTP_PASS   "SMTP password"
        ask     CFG_SMTP_FROM      "From address"           "noreply@voltagechat.app"
        ask     CFG_SMTP_FROM_NAME "From name"              "VoltChat"

        printf '\n'
        spin_start "Testing SMTP connection to ${CFG_SMTP_HOST}:${CFG_SMTP_PORT}..."
        local rc=2
        test_smtp "$CFG_SMTP_HOST" "$CFG_SMTP_PORT"; rc=$?
        case $rc in
          0) spin_ok  "SMTP connection ${BGRN}reachable${R}" ;;
          2) spin_warn "Cannot test SMTP — curl/nc not available. Continuing." ;;
          *) spin_warn "SMTP host ${BRED}unreachable${R} — check host/port." ;;
        esac
        ;;
      sendgrid)
        ask_secret CFG_SG_KEY      "SendGrid API key"
        ask        CFG_SG_FROM     "From address"           "noreply@voltagechat.app"
        ask        CFG_SG_FROM_NAME "From name"             "VoltChat"
        [[ -n "$CFG_SG_KEY" ]] && CFG_SG_KEY="\"${CFG_SG_KEY}\"" || CFG_SG_KEY='null'
        ;;
      mailgun)
        ask_secret CFG_MG_KEY      "Mailgun API key"
        ask        CFG_MG_DOMAIN   "Mailgun domain"         ""
        ask        CFG_MG_FROM     "From address"           "noreply@voltagechat.app"
        ask        CFG_MG_FROM_NAME "From name"             "VoltChat"
        [[ -n "$CFG_MG_KEY" ]] && CFG_MG_KEY="\"${CFG_MG_KEY}\"" || CFG_MG_KEY='null'
        ;;
    esac
  fi

  # Password reset
  printf '\n'
  step "Password Reset"
  ask_yn  CFG_PWRESET_ENABLED  "Enable password reset?"       "y"
  ask_int CFG_PWRESET_EXPIRY   "Token expiry (seconds)"       "3600"
  ask_int CFG_PWRESET_MAX_ATT  "Max attempts before lockout"  "3"
  ask_int CFG_PWRESET_LOCKOUT  "Lockout duration (seconds)"   "900"
}

# ── 8. Security ───────────────────────────────────────────────────────────────
wizard_security() {
  subsection "Security"

  spin_start "Generating JWT secret..."
  CFG_JWT_SECRET=$(gen_jwt)
  spin_ok "JWT secret generated  ${DIM}(${CFG_JWT_SECRET:0:20}...)${R}"

  ask CFG_JWT_EXPIRY    "JWT token expiry"          "17d"
  ask_int CFG_BCRYPT    "bcrypt rounds (10-14)"     "12"
  ask_int CFG_RL_WINDOW "Rate limit window (ms)"    "60000"
  ask_int CFG_RL_MAX    "Rate limit max requests"   "100"
}

# ── 9. Federation ─────────────────────────────────────────────────────────────
wizard_federation() {
  subsection "Federation"

  ask_yn CFG_FED_ENABLED "Enable federation?" "y"
  CFG_FED_SERVER_NAME="${CFG_SERVER_URL_HOST:-volt.voltagechat.app}"
  CFG_FED_MAX_HOPS=10

  if [[ "$CFG_FED_ENABLED" == "true" ]]; then
    ask     CFG_FED_SERVER_NAME "Federation server name (domain)" "${CFG_SERVER_URL_HOST:-volt.voltagechat.app}"
    ask_int CFG_FED_MAX_HOPS    "Max federation hops"             "10"
  fi
}

# ── 10. Features ──────────────────────────────────────────────────────────────
wizard_features() {
  subsection "Feature Flags"

  ask_yn CFG_FEAT_DISCOVERY    "Enable server discovery?"          "y"
  ask_yn CFG_FEAT_SELF_VOLT    "Enable self-volt mode?"            "y"
  ask_yn CFG_FEAT_AGE_VER      "Enable age verification?"          "n"
  ask_yn CFG_FEAT_VOICE        "Enable voice channels?"            "y"
  ask_yn CFG_FEAT_VIDEO        "Enable video channels?"            "y"
  ask_yn CFG_FEAT_E2E          "Enable E2E encryption?"            "y"
  ask_yn CFG_FEAT_E2E_TRUE     "Enable true E2E encryption?"       "y"
  ask_yn CFG_FEAT_COMMUNITIES  "Enable communities?"               "y"
  ask_yn CFG_FEAT_THREADS      "Enable threads?"                   "y"
  ask_yn CFG_FEAT_BOTS         "Enable bot API?"                   "y"
  ask_yn CFG_FEAT_FEDERATION   "Enable federation feature?"        "y"
}

# ── 11. Limits ────────────────────────────────────────────────────────────────
wizard_limits() {
  subsection "Limits"

  ask_int CFG_MAX_UPLOAD      "Max upload size (bytes)"           "1048576000"
  ask_int CFG_MAX_SERVERS     "Max servers per user"              "10000"
  ask_int CFG_MAX_CHANNELS    "Max channels per server"           "500"
  ask_int CFG_MAX_MEMBERS     "Max members per server"            "100000"
  ask_int CFG_MAX_MSG_LEN     "Max message length (chars)"        "3829"
  ask_int CFG_MAX_DM_PART     "Max DM participants"               "10"

  # Compute MB for nginx
  CFG_MAX_UPLOAD_MB=$(( CFG_MAX_UPLOAD / 1048576 ))
  (( CFG_MAX_UPLOAD_MB < 1 )) && CFG_MAX_UPLOAD_MB=1
}

# ── 12. Logging ───────────────────────────────────────────────────────────────
wizard_logging() {
  subsection "Logging"

  ask_menu CFG_LOG_LEVEL "Log level" \
    "info|Standard info (recommended)" \
    "debug|Verbose debug output" \
    "warn|Warnings and errors only" \
    "error|Errors only"

  ask_menu CFG_LOG_FORMAT "Log format" \
    "json|JSON (machine-readable)" \
    "text|Plain text"
}

# ── 13. Monitoring ────────────────────────────────────────────────────────────
wizard_monitoring() {
  subsection "Monitoring"

  ask_yn CFG_MON_ENABLED    "Enable monitoring?"          "n"
  ask_yn CFG_MON_PROMETHEUS "Enable Prometheus metrics?"  "n"
  ask    CFG_MON_HEALTH     "Health check path"           "/health"
}

# ── 14. Scaling ───────────────────────────────────────────────────────────────
wizard_scaling() {
  subsection "Horizontal Scaling (Multi-Node)"

  info "Scaling = same Voltage instance across multiple VPS nodes."
  info "This is NOT federation. All nodes share the same database."
  printf '\n'

  ask_yn CFG_SCALE_ENABLED "Enable multi-node scaling?" "y"
  CFG_SCALE_SECRET=''; CFG_SCALE_NODE_URL=''; CFG_SCALE_NODE_ID='node-1'
  CFG_SCALE_HEARTBEAT_INT=30000; CFG_SCALE_HEARTBEAT_TO=90000
  CFG_SCALE_FILE_MODE='proxy'
  CFG_SCALE_NODES_JSON='[{"id":"","url":""}]'

  if [[ "$CFG_SCALE_ENABLED" == "true" ]]; then
    spin_start "Generating node secret..."
    CFG_SCALE_SECRET=$(gen_secret)
    spin_ok "Node secret generated  ${DIM}(${CFG_SCALE_SECRET:0:12}...)${R}"

    ask     CFG_SCALE_NODE_ID  "This node's ID"                  "node-1"
    ask     CFG_SCALE_NODE_URL "This node's public URL"          "http://199.192.21.113:5001"
    ask_int CFG_SCALE_HEARTBEAT_INT "Heartbeat interval (ms)"    "30000"
    ask_int CFG_SCALE_HEARTBEAT_TO  "Heartbeat timeout (ms)"     "90000"

    ask_menu CFG_SCALE_FILE_MODE "File resolution mode" \
      "proxy|Proxy files through this node (hides peer topology)" \
      "redirect|302 redirect to peer (faster, exposes peer URL)"

    printf '\n'
    info "You can add peer nodes now (leave ID blank to finish)."
    local nodes_arr=()
    local idx=1
    while true; do
      local nid='' nurl=''
      ask nid "Peer node ${idx} ID (blank to finish)" ""
      [[ -z "$nid" ]] && break
      ask nurl "Peer node ${idx} URL" ""
      nodes_arr+=("{\"id\":\"${nid}\",\"url\":\"${nurl}\"}")
      (( idx++ ))
    done

    if [[ ${#nodes_arr[@]} -gt 0 ]]; then
      CFG_SCALE_NODES_JSON="[$(IFS=','; echo "${nodes_arr[*]}")]"
    else
      CFG_SCALE_NODES_JSON='[{"id":"","url":""}]'
    fi
  fi
}

# ─── Write config.json ────────────────────────────────────────────────────────
write_config() {
  section "Writing Configuration"
  spin_start "Writing config.json..."

  # Escape strings for JSON
  _j() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

  # Build JSON safely
  cat > config.json <<JSONEOF
{
  "server": {
    "name": "$(_j "$CFG_NAME")",
    "version": "$(_j "$CFG_VERSION")",
    "mode": "$(_j "$CFG_MODE")",
    "host": "$(_j "$CFG_HOST")",
    "port": ${CFG_PORT},
    "url": "$(_j "$CFG_URL")",
    "imageServerUrl": "$(_j "$CFG_IMG_URL")",
    "description": "$(_j "$CFG_DESCRIPTION")"
  },
  "branding": {
    "logo": ${CFG_LOGO},
    "primaryColor": "$(_j "$CFG_PRIMARY_COLOR")",
    "accentColor": "$(_j "$CFG_ACCENT_COLOR")"
  },
  "storage": {
    "type": "$(_j "$CFG_STORAGE")",
    "json": {
      "dataDir": "$(_j "$CFG_JSON_DIR")"
    },
    "sqlite": {
      "dbPath": "$(_j "$CFG_SQLITE_PATH")"
    },
    "mysql": {
      "host": "$(_j "$CFG_DB_HOST")",
      "port": ${CFG_DB_PORT:-3306},
      "database": "$(_j "$CFG_DB_NAME")",
      "user": "$(_j "$CFG_DB_USER")",
      "password": "$(_j "$CFG_DB_PASS")",
      "connectionLimit": ${CFG_DB_CONN_LIMIT:-10},
      "charset": "utf8mb4"
    },
    "mariadb": {
      "host": "$(_j "$CFG_DB_HOST")",
      "port": ${CFG_DB_PORT:-3306},
      "database": "$(_j "$CFG_DB_NAME")",
      "user": "$(_j "$CFG_DB_USER")",
      "password": "$(_j "$CFG_DB_PASS")",
      "connectionLimit": ${CFG_DB_CONN_LIMIT:-10},
      "charset": "utf8mb4"
    },
    "postgres": {
      "host": "$(_j "$CFG_DB_HOST")",
      "port": ${CFG_DB_PORT:-5432},
      "database": "$(_j "$CFG_DB_NAME")",
      "user": "$(_j "$CFG_DB_USER")",
      "password": "$(_j "$CFG_DB_PASS")",
      "ssl": ${CFG_DB_SSL:-false},
      "connectionString": null
    },
    "cockroachdb": {
      "host": "$(_j "$CFG_DB_HOST")",
      "port": ${CFG_DB_PORT:-26257},
      "database": "$(_j "$CFG_DB_NAME")",
      "user": "$(_j "$CFG_DB_USER")",
      "password": "$(_j "$CFG_DB_PASS")",
      "ssl": true,
      "connectionString": null
    },
    "mssql": {
      "host": "$(_j "$CFG_DB_HOST")",
      "port": ${CFG_DB_PORT:-1433},
      "database": "$(_j "$CFG_DB_NAME")",
      "user": "$(_j "$CFG_DB_USER")",
      "password": "$(_j "$CFG_DB_PASS")",
      "encrypt": false,
      "trustServerCertificate": true
    },
    "mongodb": {
      "host": "$(_j "$CFG_DB_HOST")",
      "port": ${CFG_DB_PORT:-27017},
      "database": "$(_j "$CFG_DB_NAME")",
      "user": "$(_j "$CFG_DB_USER")",
      "password": "$(_j "$CFG_DB_PASS")",
      "connectionString": null,
      "authSource": "admin"
    },
    "redis": {
      "host": "$(_j "$CFG_DB_HOST")",
      "port": ${CFG_DB_PORT:-6379},
      "password": "$(_j "$CFG_DB_PASS")",
      "db": ${CFG_DB_NAME:-0},
      "keyPrefix": "voltchat:"
    }
  },
  "cdn": {
    "enabled": ${CFG_CDN_ENABLED},
    "provider": "$(_j "$CFG_CDN_PROVIDER")",
    "local": {
      "uploadDir": "$(_j "$CFG_CDN_LOCAL_DIR")",
      "baseUrl": ${CFG_CDN_LOCAL_URL}
    },
    "nfs": {
      "uploadDir": ${CFG_CDN_NFS_DIR},
      "baseUrl": ${CFG_CDN_NFS_URL}
    },
    "s3": {
      "bucket": "$(_j "$CFG_S3_BUCKET")",
      "region": "$(_j "$CFG_S3_REGION")",
      "accessKeyId": "$(_j "$CFG_S3_KEY")",
      "secretAccessKey": "$(_j "$CFG_S3_SECRET")",
      "endpoint": ${CFG_S3_ENDPOINT},
      "publicUrl": "$(_j "$CFG_S3_PUBLIC_URL")"
    },
    "cloudflare": {
      "accountId": ${CFG_CF_ACCOUNT},
      "bucket": ${CFG_CF_BUCKET},
      "accessKeyId": ${CFG_CF_KEY},
      "secretAccessKey": ${CFG_CF_SECRET},
      "publicUrl": ${CFG_CF_URL}
    }
  },
  "cache": {
    "enabled": ${CFG_CACHE_ENABLED},
    "provider": "$(_j "$CFG_CACHE_PROVIDER")",
    "redis": {
      "host": "$(_j "$CFG_CACHE_REDIS_HOST")",
      "port": ${CFG_CACHE_REDIS_PORT},
      "password": "$(_j "$CFG_CACHE_REDIS_PASS")",
      "db": ${CFG_CACHE_REDIS_DB}
    }
  },
  "queue": {
    "enabled": ${CFG_QUEUE_ENABLED},
    "provider": "$(_j "$CFG_QUEUE_PROVIDER")",
    "redis": {
      "host": "$(_j "$CFG_QUEUE_REDIS_HOST")",
      "port": ${CFG_QUEUE_REDIS_PORT},
      "password": "$(_j "$CFG_QUEUE_REDIS_PASS")",
      "db": ${CFG_QUEUE_REDIS_DB}
    }
  },
  "auth": {
    "type": "all",
    "local": {
      "enabled": ${CFG_LOCAL_AUTH_ENABLED},
      "allowRegistration": ${CFG_ALLOW_REG},
      "requireEmailVerification": ${CFG_REQUIRE_EMAIL_VER},
      "minPasswordLength": ${CFG_MIN_PASS_LEN},
      "maxPasswordLength": ${CFG_MAX_PASS_LEN},
      "passwordRequirements": {
        "requireUppercase": ${CFG_PASS_UPPER},
        "requireNumbers": ${CFG_PASS_NUMBERS},
        "requireSymbols": ${CFG_PASS_SYMBOLS}
      }
    },
    "oauth": {
      "enabled": ${CFG_OAUTH_ENABLED},
      "provider": "$(_j "$CFG_OAUTH_PROVIDER")",
      "enclica": {
        "clientId": "$(_j "$CFG_ENCLICA_CLIENT_ID")",
        "authUrl": "$(_j "$CFG_ENCLICA_AUTH_URL")",
        "tokenUrl": "$(_j "$CFG_ENCLICA_TOKEN_URL")",
        "userInfoUrl": "$(_j "$CFG_ENCLICA_USERINFO_URL")",
        "revokeUrl": "$(_j "$CFG_ENCLICA_REVOKE_URL")"
      }
    },
    "email": {
      "enabled": ${CFG_EMAIL_ENABLED},
      "provider": "$(_j "$CFG_EMAIL_PROVIDER")",
      "smtp": {
        "host": "$(_j "$CFG_SMTP_HOST")",
        "port": ${CFG_SMTP_PORT},
        "secure": ${CFG_SMTP_SECURE},
        "user": "$(_j "$CFG_SMTP_USER")",
        "pass": "$(_j "$CFG_SMTP_PASS")",
        "from": "$(_j "$CFG_SMTP_FROM")",
        "fromName": "$(_j "$CFG_SMTP_FROM_NAME")"
      },
      "sendgrid": {
        "apiKey": ${CFG_SG_KEY},
        "from": "$(_j "$CFG_SG_FROM")",
        "fromName": "$(_j "$CFG_SG_FROM_NAME")"
      },
      "mailgun": {
        "apiKey": ${CFG_MG_KEY},
        "domain": "$(_j "$CFG_MG_DOMAIN")",
        "from": "$(_j "$CFG_MG_FROM")",
        "fromName": "$(_j "$CFG_MG_FROM_NAME")"
      }
    },
    "passwordReset": {
      "enabled": ${CFG_PWRESET_ENABLED},
      "tokenExpiry": ${CFG_PWRESET_EXPIRY},
      "maxAttempts": ${CFG_PWRESET_MAX_ATT},
      "lockoutDuration": ${CFG_PWRESET_LOCKOUT}
    }
  },
  "security": {
    "jwtSecret": "$(_j "$CFG_JWT_SECRET")",
    "jwtExpiry": "$(_j "$CFG_JWT_EXPIRY")",
    "bcryptRounds": ${CFG_BCRYPT},
    "rateLimit": {
      "windowMs": ${CFG_RL_WINDOW},
      "maxRequests": ${CFG_RL_MAX}
    },
    "adminUsers": []
  },
  "federation": {
    "enabled": ${CFG_FED_ENABLED},
    "serverName": "$(_j "$CFG_FED_SERVER_NAME")",
    "allowedServers": [],
    "maxHops": ${CFG_FED_MAX_HOPS}
  },
  "features": {
    "discovery":         ${CFG_FEAT_DISCOVERY},
    "selfVolt":          ${CFG_FEAT_SELF_VOLT},
    "ageVerification":   ${CFG_FEAT_AGE_VER},
    "voiceChannels":     ${CFG_FEAT_VOICE},
    "videoChannels":     ${CFG_FEAT_VIDEO},
    "e2eEncryption":     ${CFG_FEAT_E2E},
    "e2eTrueEncryption": ${CFG_FEAT_E2E_TRUE},
    "communities":       ${CFG_FEAT_COMMUNITIES},
    "threads":           ${CFG_FEAT_THREADS},
    "bots":              ${CFG_FEAT_BOTS},
    "federation":        ${CFG_FEAT_FEDERATION}
  },
  "limits": {
    "maxUploadSize":       ${CFG_MAX_UPLOAD},
    "maxServersPerUser":   ${CFG_MAX_SERVERS},
    "maxChannelsPerServer":${CFG_MAX_CHANNELS},
    "maxMembersPerServer": ${CFG_MAX_MEMBERS},
    "maxMessageLength":    ${CFG_MAX_MSG_LEN},
    "maxDmParticipants":   ${CFG_MAX_DM_PART}
  },
  "logging": {
    "level": "$(_j "$CFG_LOG_LEVEL")",
    "format": "$(_j "$CFG_LOG_FORMAT")",
    "outputs": ["console"]
  },
  "monitoring": {
    "enabled": ${CFG_MON_ENABLED},
    "prometheus": ${CFG_MON_PROMETHEUS},
    "healthCheckPath": "$(_j "$CFG_MON_HEALTH")"
  },
  "scaling": {
    "enabled": ${CFG_SCALE_ENABLED},
    "nodeSecret": "$(_j "$CFG_SCALE_SECRET")",
    "nodeUrl": "$(_j "$CFG_SCALE_NODE_URL")",
    "nodeId": "$(_j "$CFG_SCALE_NODE_ID")",
    "nodes": ${CFG_SCALE_NODES_JSON},
    "heartbeatInterval": ${CFG_SCALE_HEARTBEAT_INT},
    "heartbeatTimeout": ${CFG_SCALE_HEARTBEAT_TO},
    "fileResolutionMode": "$(_j "$CFG_SCALE_FILE_MODE")"
  }
}
JSONEOF

  spin_ok "config.json written"

  # Validate JSON if jq is available
  if command -v jq &>/dev/null; then
    spin_start "Validating JSON syntax..."
    if jq empty config.json &>/dev/null; then
      spin_ok "config.json is valid JSON"
    else
      spin_warn "config.json may have syntax errors — run: jq . config.json"
    fi
  fi
}

# ─── Write .env ───────────────────────────────────────────────────────────────
write_env() {
  spin_start "Writing .env..."
  cat > .env <<ENVEOF
# Voltage — generated by setup.sh $(date -u '+%Y-%m-%d %H:%M UTC')
# This file is a convenience override. config.json is the primary config.

PORT=${CFG_PORT}
NODE_ENV=production
SERVER_NAME="${CFG_NAME}"
SERVER_URL="${CFG_URL}"
IMAGE_SERVER_URL="${CFG_IMG_URL}"
VOLTAGE_MODE="${CFG_MODE}"

JWT_SECRET="${CFG_JWT_SECRET}"
JWT_EXPIRY="${CFG_JWT_EXPIRY}"
BCRYPT_ROUNDS=${CFG_BCRYPT}

STORAGE_TYPE="${CFG_STORAGE}"

ALLOW_REGISTRATION=${CFG_ALLOW_REG}
ENABLE_OAUTH=${CFG_OAUTH_ENABLED}
ENCLICA_CLIENT_ID="${CFG_ENCLICA_CLIENT_ID}"

FEAT_DISCOVERY=${CFG_FEAT_DISCOVERY}
FEAT_VOICE=${CFG_FEAT_VOICE}
FEAT_E2E=${CFG_FEAT_E2E}
FEAT_BOTS=${CFG_FEAT_BOTS}
FEAT_FEDERATION=${CFG_FEAT_FEDERATION}
ENVEOF
  spin_ok ".env written"
}

# ─── Run database migration ───────────────────────────────────────────────────
run_migration() {
  printf '\n'
  ask_yn _RUN_MIGRATE "Run database migration now?" "y"
  if [[ "$_RUN_MIGRATE" == "true" ]]; then
    subsection "Database Migration"
    spin_start "Running npm run migrate..."
    if npm run migrate 2>&1 | tail -20; then
      spin_ok "Migration complete"
    else
      spin_warn "Migration may have encountered issues — check output above"
    fi
  fi
}

# ─── Health check ─────────────────────────────────────────────────────────────
run_health_check() {
  printf '\n'
  ask_yn _RUN_HEALTH "Start server briefly to verify health endpoint?" "n"
  if [[ "$_RUN_HEALTH" != "true" ]]; then return; fi

  subsection "Health Check"
  info "Starting Voltage in background for health check..."
  node server.js &>/tmp/voltage_health_check.log &
  local srv_pid=$!
  spin_start "Waiting for server to start (port ${CFG_PORT})..."
  local attempts=0
  while (( attempts < 20 )); do
    sleep 0.5
    if test_http "http://localhost:${CFG_PORT}${CFG_MON_HEALTH}"; then
      spin_ok "Health endpoint ${BGRN}responded${R} at http://localhost:${CFG_PORT}${CFG_MON_HEALTH}"
      kill "$srv_pid" 2>/dev/null; wait "$srv_pid" 2>/dev/null || true
      return
    fi
    (( attempts++ ))
  done
  spin_warn "Server did not respond in time — check logs at /tmp/voltage_health_check.log"
  kill "$srv_pid" 2>/dev/null; wait "$srv_pid" 2>/dev/null || true
}

# ─── Summary ──────────────────────────────────────────────────────────────────
print_summary() {
  section "Setup Complete"

  printf '\n'
  center "⚡  Voltage is ready to launch!  ⚡" "${B}${BYLW}"
  printf '\n'

  local bw=56
  local bl=$(( (COLS - bw - 2) / 2 ))
  (( bl < 0 )) && bl=0
  local p; p=$(printf '%*s' "$bl" '')
  local bar; bar=$(rep '─' "$bw")

  _row() {
    local label="$1" val="$2"
    printf '%s%s│%s  %-14s%s  %s%-35s%s  %s│%s\n' \
      "$p" "${DIM}${BBLU}" "$R" \
      "${B}${label}" "$R" \
      "" "$val" "$R" \
      "${DIM}${BBLU}" "$R"
  }

  printf '%s%s┌%s┐%s\n' "$p" "${DIM}${BBLU}" "$bar" "$R"
  _row "Server:"    "${CFG_NAME}"
  _row "URL:"       "${CFG_URL}"
  _row "Port:"      "${CFG_PORT}"
  _row "Mode:"      "${CFG_MODE}"
  _row "Storage:"   "${CFG_STORAGE}"
  _row "Cache:"     "${CFG_CACHE_PROVIDER} (enabled=${CFG_CACHE_ENABLED})"
  _row "Queue:"     "${CFG_QUEUE_PROVIDER} (enabled=${CFG_QUEUE_ENABLED})"
  _row "CDN:"       "${CFG_CDN_PROVIDER} (enabled=${CFG_CDN_ENABLED})"
  _row "OAuth:"     "${CFG_OAUTH_PROVIDER} (enabled=${CFG_OAUTH_ENABLED})"
  _row "Email:"     "${CFG_EMAIL_PROVIDER} (enabled=${CFG_EMAIL_ENABLED})"
  _row "Federation:""${CFG_FED_ENABLED}"
  _row "Scaling:"   "${CFG_SCALE_ENABLED}"
  printf '%s%s└%s┘%s\n' "$p" "${DIM}${BBLU}" "$bar" "$R"

  printf '\n'
  hline_thin
  printf '  %s%sTo start Voltage:%s\n\n' "$B" "$BYLW" "$R"
  printf '    %s$%s  %snpm start%s          %s# production%s\n'    "$BGRN" "$R" "$B" "$R" "$DIM" "$R"
  printf '    %s$%s  %snpm run dev%s        %s# development (watch)%s\n' "$BGRN" "$R" "$B" "$R" "$DIM" "$R"
  printf '    %s$%s  %snpm run pm2:start%s  %s# PM2 process manager%s\n' "$BGRN" "$R" "$B" "$R" "$DIM" "$R"
  printf '\n'
  printf '  %s%sConfig file:%s  %sconfig.json%s\n' "$B" "$BCYN" "$R" "$DIM" "$R"
  printf '  %s%sEnv file:%s     %s.env%s\n'        "$B" "$BCYN" "$R" "$DIM" "$R"
  printf '  %s%sLogs:%s         %slogs/%s\n'       "$B" "$BCYN" "$R" "$DIM" "$R"
  printf '\n'
  hline '═' "${BBLU}"
  center "Thank you for choosing Voltage ⚡" "${DIM}"
  hline '═' "${BBLU}"
  printf '\n'
}

# ─── Main ─────────────────────────────────────────────────────────────────────
main() {
  # Sanity check — must be run from the Voltage directory
  if [[ ! -f "server.js" || ! -f "package.json" ]]; then
    printf '\n%sERROR:%s Run this script from inside the Voltage project directory.\n\n' "$BRED" "$R"
    exit 1
  fi

  boot_sequence

  # ── Phase 1: Environment ──────────────────────────────────────────────────
  check_deps
  install_npm_deps
  create_dirs

  # ── Phase 2: Configuration Wizard ────────────────────────────────────────
  section "Configuration Wizard"
  printf '  %sAnswer each question — press Enter to accept the default value.%s\n' "$DIM" "$R"
  printf '  %sSecrets are hidden as you type.%s\n\n' "$DIM" "$R"

  wizard_server
  wizard_branding
  wizard_storage
  wizard_cdn
  wizard_cache
  wizard_queue
  wizard_auth
  wizard_security
  wizard_federation
  wizard_features
  wizard_limits
  wizard_logging
  wizard_monitoring
  wizard_scaling

  # ── Phase 3: Write files ──────────────────────────────────────────────────
  write_config
  write_env

  # ── Phase 4: System integration ──────────────────────────────────────────
  install_systemd
  setup_nginx

  # ── Phase 5: Post-setup ───────────────────────────────────────────────────
  run_migration
  run_health_check

  # ── Done ──────────────────────────────────────────────────────────────────
  print_summary
}

main "$@"
