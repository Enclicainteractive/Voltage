#!/usr/bin/env bash
# =============================================================
#  Voltage — Setup Script
#  Fully interactive TUI with animated logo and wizard
# =============================================================
set -euo pipefail

# ── Force ANSI support ────────────────────────────────────────
export TERM="${TERM:-xterm-256color}"

# ── Colour constants (use printf, never echo -e) ──────────────
R='\033[0m'        # reset
B='\033[1m'        # bold
DM='\033[2m'       # dim

BLK='\033[30m' ; RED='\033[31m'  ; GRN='\033[32m' ; YLW='\033[33m'
BLU='\033[34m' ; MAG='\033[35m'  ; CYN='\033[36m' ; WHT='\033[37m'

BRED='\033[91m' ; BGRN='\033[92m' ; BYLW='\033[93m'
BBLU='\033[94m' ; BMAG='\033[95m' ; BCYN='\033[96m' ; BWHT='\033[97m'

# ── Terminal width (safe fallback) ────────────────────────────
COLS=80
_tc=$(tput cols 2>/dev/null) && [[ "$_tc" -gt 0 ]] 2>/dev/null && COLS=$_tc

# ── Cursor helpers ────────────────────────────────────────────
cur_hide() { printf '\033[?25l'; }
cur_show() { printf '\033[?25h'; }
cur_up()   { printf '\033[%dA' "${1:-1}"; }
cur_bol()  { printf '\r'; }

# Always restore cursor on exit
trap 'cur_show; echo' EXIT INT TERM

# ── Padding helper (no bc/awk needed) ────────────────────────
pad() {
  # pad N spaces
  local n=$1
  local s=''
  while [[ $n -gt 0 ]]; do s="$s "; n=$((n-1)); done
  printf '%s' "$s"
}

# strip ANSI from a string and return its visible length
vis_len() {
  local s
  s=$(printf '%s' "$1" | sed 's/\x1b\[[0-9;]*m//g')
  printf '%d' "${#s}"
}

center() {
  # center a pre-coloured string
  local str="$1"
  local vl
  vl=$(vis_len "$str")
  local left=$(( (COLS - vl) / 2 ))
  [[ $left -lt 0 ]] && left=0
  pad "$left"
  printf '%s\n' "$str"
}

hline() {
  # print a full-width line in dim-cyan
  local ch="${1:─}"
  local i=0
  printf '%s' "${DM}${CYN}"
  while [[ $i -lt $COLS ]]; do printf '%s' "$ch"; i=$((i+1)); done
  printf '%s\n' "$R"
}

# ── Status icons ──────────────────────────────────────────────
ok()   { printf "  ${BGRN}✔${R}  %s\n" "$1"; }
info() { printf "  ${BCYN}ℹ${R}  %s\n" "$1"; }
warn() { printf "  ${BYLW}⚠${R}  %s\n" "$1"; }
err()  { printf "  ${BRED}✖${R}  %s\n" "$1"; }
step() { printf "\n  ${BBLU}▶${R}  ${B}%s${R}\n" "$1"; }

section() {
  printf '\n'
  hline '─'
  center "${B}${BWHT}$1${R}"
  hline '─'
  printf '\n'
}

# ── Spinner ───────────────────────────────────────────────────
_spin_pid=0
_spin_msg=''

spin_start() {
  _spin_msg="${1:-Please wait...}"
  cur_hide
  (
    local frames='⣾⣽⣻⢿⡿⣟⣯⣷'
    local i=0
    while true; do
      local ch="${frames:$((i % 8)):1}"
      printf '\r  %s%s%s  %s%s%s   ' \
        "$BBLU" "$ch" "$R" \
        "$CYN" "$_spin_msg" "$R"
      sleep 0.07
      i=$((i+1))
    done
  ) &
  _spin_pid=$!
}

spin_stop() {
  [[ $_spin_pid -ne 0 ]] && { kill "$_spin_pid" 2>/dev/null; wait "$_spin_pid" 2>/dev/null; }
  _spin_pid=0
  printf '\r%*s\r' "$COLS" ''
  cur_show
}

# ── Logo colours: each row gets a gradient colour ─────────────
#    rows: deep-blue → cyan → magenta
LOGO_COLOURS=(
  "$BBLU" "$BBLU"
  "$BCYN" "$BCYN"
  "$BMAG" "$BMAG"
  "$BMAG"
)

LOGO_ROWS=(
  '██╗   ██╗ ██████╗ ██╗  ████████╗ █████╗  ██████╗ ███████╗'
  '██║   ██║██╔═══██╗██║  ╚══██╔══╝██╔══██╗██╔════╝ ██╔════╝'
  '██║   ██║██║   ██║██║     ██║   ███████║██║  ███╗█████╗  '
  '╚██╗ ██╔╝██║   ██║██║     ██║   ██╔══██║██║   ██║██╔══╝  '
  ' ╚████╔╝ ╚██████╔╝███████╗██║   ██║  ██║╚██████╔╝███████╗'
  '  ╚═══╝   ╚═════╝ ╚══════╝╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚══════╝'
)

# ── Animated logo reveal ──────────────────────────────────────
#    Reveals each logo row character-by-character, left to right
animate_logo() {
  cur_hide
  printf '\n'

  local ri=0
  for row in "${LOGO_ROWS[@]}"; do
    local col="${LOGO_COLOURS[$ri]:-$BMAG}"
    local vl=${#row}
    local left=$(( (COLS - vl) / 2 ))
    [[ $left -lt 0 ]] && left=0

    # print leading padding once
    pad "$left"

    # reveal each character
    local ci=0
    while [[ $ci -lt ${#row} ]]; do
      printf '%s%s%s' "$col" "${row:$ci:1}" "$R"
      sleep 0.004
      ci=$((ci+1))
    done
    printf '\n'
    ri=$((ri+1))
  done

  printf '\n'
  # subtitle fade-in word by word
  local subtitle="⚡  The Decentralized Chat Platform  ⚡"
  local sl=${#subtitle}
  local sleft=$(( (COLS - sl) / 2 ))
  [[ $sleft -lt 0 ]] && sleft=0
  pad "$sleft"
  local si=0
  while [[ $si -lt ${#subtitle} ]]; do
    printf '%s%s%s' "$BYLW" "${subtitle:$si:1}" "$R"
    sleep 0.025
    si=$((si+1))
  done
  printf '\n\n'
  cur_show
}

# ── Boot sequence ─────────────────────────────────────────────
boot_sequence() {
  clear
  animate_logo

  # "Initialising subsystems..." — single line, overwriting
  cur_hide
  local dots=''
  local i=0
  while [[ $i -lt 16 ]]; do
    case $((i % 4)) in
      0) dots=''   ;;
      1) dots='.'  ;;
      2) dots='..' ;;
      3) dots='...';;
    esac
    printf '\r'
    center "${CYN}Initialising subsystems${BYLW}${dots}${R}     "
    # overwrite the newline from center with a CR so we stay on the same line
    # center prints \n — we have to move up after it
    cur_up 1
    sleep 0.12
    i=$((i+1))
  done
  printf '\n\n'

  # charging bar — single line, grows in place
  local bar_label
  bar_label=$(printf '%s%s%s' "$DM" "Charging the Volt..." "$R")
  center "$bar_label"
  printf '\n'

  local bar_w=$(( COLS - 6 ))
  [[ $bar_w -lt 20 ]] && bar_w=20
  local left=$(( (COLS - bar_w - 2) / 2 ))
  [[ $left -lt 0 ]] && left=0

  pad "$left"; printf '%s[%s' "$BBLU" "$R"
  local bi=0
  while [[ $bi -lt $bar_w ]]; do
    printf '%s⚡%s' "$BBLU" "$R"
    sleep 0.018
    bi=$((bi+1))
  done
  printf '%s]%s\n\n' "$BBLU" "$R"

  cur_show
  sleep 0.3
}

# ── Input helpers ─────────────────────────────────────────────
ask() {
  # ask VARNAME "Prompt" "default"
  local _var="$1" _prompt="$2" _default="${3:-}" _val=''
  if [[ -n "$_default" ]]; then
    printf '  %s?%s  %s%s%s %s(%s)%s: ' \
      "$BCYN" "$R" "$B" "$_prompt" "$R" "$DM" "$_default" "$R"
  else
    printf '  %s?%s  %s%s%s: ' "$BCYN" "$R" "$B" "$_prompt" "$R"
  fi
  IFS= read -r _val
  [[ -z "$_val" ]] && _val="$_default"
  printf -v "$_var" '%s' "$_val"
}

ask_secret() {
  local _var="$1" _prompt="$2" _val=''
  printf '  %s🔒%s  %s%s%s: ' "$BMAG" "$R" "$B" "$_prompt" "$R"
  IFS= read -rs _val; printf '\n'
  printf -v "$_var" '%s' "$_val"
}

ask_yn() {
  # ask_yn VARNAME "Prompt" y|n
  local _var="$1" _prompt="$2" _def="${3:-y}" _ans=''
  local _disp
  if [[ "$_def" == "y" ]]; then
    _disp="${BGRN}Y${R}${DM}/n${R}"
  else
    _disp="${DM}y/${R}${BGRN}N${R}"
  fi
  printf '  %s?%s  %s%s%s [%s]: ' "$BCYN" "$R" "$B" "$_prompt" "$R" "$_disp"
  IFS= read -r _ans
  [[ -z "$_ans" ]] && _ans="$_def"
  if [[ "${_ans,,}" == "y" || "${_ans,,}" == "yes" ]]; then
    printf -v "$_var" 'true'
  else
    printf -v "$_var" 'false'
  fi
}

ask_choice() {
  # ask_choice VARNAME "Prompt" opt1 opt2 ...
  local _var="$1" _prompt="$2"; shift 2
  local _opts=("$@") _i=1 _ch=1
  printf '\n  %s?%s  %s%s%s\n' "$BCYN" "$R" "$B" "$_prompt" "$R"
  for _o in "${_opts[@]}"; do
    printf '     %s%d)%s %s\n' "$DM" "$_i" "$R" "$_o"
    _i=$((_i+1))
  done
  printf '\n  %s→%s Enter number %s[1-%d]%s: ' "$BCYN" "$R" "$DM" "${#_opts[@]}" "$R"
  IFS= read -r _ch
  [[ -z "$_ch" || ! "$_ch" =~ ^[0-9]+$ ]] && _ch=1
  [[ "$_ch" -lt 1 ]] && _ch=1
  [[ "$_ch" -gt "${#_opts[@]}" ]] && _ch="${#_opts[@]}"
  # extract first word as the key
  local _selected="${_opts[$((_ch-1))]}"
  _selected="${_selected%% *}"
  printf -v "$_var" '%s' "$_selected"
}

# ── Generate JWT secret ───────────────────────────────────────
gen_jwt() {
  if command -v openssl &>/dev/null; then
    openssl rand -hex 64
  else
    node -e "process.stdout.write(require('crypto').randomBytes(64).toString('hex'))"
  fi
}

# ── Check deps ────────────────────────────────────────────────
check_deps() {
  section "Checking Dependencies"
  local missing=()

  for cmd in node npm; do
    if command -v "$cmd" &>/dev/null; then
      local ver; ver=$("$cmd" --version 2>/dev/null | head -1)
      ok "${B}${cmd}${R} found  ${DM}${ver}${R}"
    else
      err "${B}${cmd}${R} not found"
      missing+=("$cmd")
    fi
  done

  if command -v node &>/dev/null; then
    local nmaj; nmaj=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
    if [[ "$nmaj" -lt 18 ]]; then
      err "Node.js v${nmaj} is too old — Voltage needs v18+"
      missing+=("node>=18")
    fi
  fi

  for cmd in git openssl; do
    if command -v "$cmd" &>/dev/null; then
      ok "${B}${cmd}${R} found"
    else
      warn "${B}${cmd}${R} not found ${DM}(optional but recommended)${R}"
    fi
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    printf '\n'
    err "Missing: ${missing[*]}"
    err "Install the above then re-run this script."
    exit 1
  fi
  printf '\n'
  ok "All required dependencies satisfied"
}

# ── Install npm packages ──────────────────────────────────────
install_deps() {
  section "Installing Node Packages"
  spin_start "Running npm install..."
  if npm install --silent 2>/dev/null; then
    spin_stop; ok "Packages installed"
  else
    spin_stop; warn "Silent install failed — retrying"
    npm install || { err "npm install failed"; exit 1; }
    ok "Packages installed"
  fi
}

# ── Wizard ────────────────────────────────────────────────────
run_wizard() {
  section "Configuration Wizard"
  printf '  %s%s%s\n\n' \
    "$DM$WHT" \
    "Answer each question — press Enter to keep the default." \
    "$R"

  # Server identity
  step "Server Identity"
  printf '\n'
  ask  CFG_SERVER_NAME  "Server name"             "Volt"
  ask  CFG_SERVER_URL   "Public URL (with scheme)" "http://localhost:3000"
  ask  CFG_PORT         "Port"                     "3000"
  ask_choice CFG_MODE   "Server mode" \
    "mainline   (join the main Volt network)" \
    "self-volt  (standalone / private)" \
    "federated  (federate with other Volt servers)"

  # Storage
  step "Storage Backend"
  printf '\n'
  ask_choice CFG_STORAGE "Database engine" \
    "json      (flat files — zero config)" \
    "sqlite    (recommended for small/medium — no DB server needed)" \
    "postgres  (PostgreSQL)" \
    "mysql     (MySQL / MariaDB)"

  CFG_DB_HOST='' CFG_DB_PORT='' CFG_DB_NAME='' CFG_DB_USER='' CFG_DB_PASS=''
  if [[ "$CFG_STORAGE" == "postgres" || "$CFG_STORAGE" == "mysql" ]]; then
    printf '\n'
    ask CFG_DB_HOST "Database host"   "localhost"
    [[ "$CFG_STORAGE" == "postgres" ]] && ask CFG_DB_PORT "Database port" "5432" \
                                       || ask CFG_DB_PORT "Database port" "3306"
    ask CFG_DB_NAME "Database name"   "voltchat"
    ask CFG_DB_USER "Database user"   "volt"
    ask_secret CFG_DB_PASS "Database password"
  fi

  # Auth
  step "Authentication"
  printf '\n'
  ask_yn CFG_ALLOW_REG  "Allow new user registration?" "y"
  ask_yn CFG_OAUTH      "Enable OAuth / SSO login?"    "y"

  # Security
  step "Security"
  printf '\n'
  spin_start "Generating JWT secret..."
  CFG_JWT_SECRET=$(gen_jwt)
  spin_stop
  ok "JWT secret generated  ${DM}(${CFG_JWT_SECRET:0:16}…)${R}"
  ask CFG_JWT_EXPIRY "Token expiry" "7d"

  # Features
  step "Features"
  printf '\n'
  ask_yn CFG_DISCOVERY  "Enable server discovery?"       "y"
  ask_yn CFG_VOICE      "Enable voice & video channels?" "y"
  ask_yn CFG_E2E        "Enable end-to-end encryption?"  "y"
  ask_yn CFG_BOTS       "Enable bot API?"                "y"
  ask_yn CFG_FED        "Enable federation?"             "n"

  # Admin account
  step "Initial Admin Account"
  printf '\n'
  ask        CFG_ADMIN_USER  "Admin username"          "admin"
  ask_secret CFG_ADMIN_PASS  "Admin password"
  ask        CFG_ADMIN_EMAIL "Admin e-mail (optional)" ""
}

# ── Write files ───────────────────────────────────────────────
create_dirs() {
  section "Preparing Filesystem"
  spin_start "Creating directories..."
  mkdir -p data uploads logs
  spin_stop
  ok "Directories ready  ${DM}(data/  uploads/  logs/)${R}"
}

write_env() {
  spin_start "Writing .env..."
  cat > .env <<EOF
# Voltage — generated by setup.sh  $(date -u '+%Y-%m-%d %H:%M UTC')

PORT=${CFG_PORT:-3000}
NODE_ENV=production

SERVER_NAME="${CFG_SERVER_NAME:-Volt}"
SERVER_URL="${CFG_SERVER_URL:-http://localhost:3000}"
SERVER_MODE="${CFG_MODE:-mainline}"

JWT_SECRET="${CFG_JWT_SECRET}"
JWT_EXPIRY="${CFG_JWT_EXPIRY:-7d}"
BCRYPT_ROUNDS=12

STORAGE_TYPE="${CFG_STORAGE:-sqlite}"
DB_HOST="${CFG_DB_HOST:-localhost}"
DB_PORT="${CFG_DB_PORT:-}"
DB_NAME="${CFG_DB_NAME:-voltchat}"
DB_USER="${CFG_DB_USER:-}"
DB_PASS="${CFG_DB_PASS:-}"
SQLITE_PATH="./data/voltage.db"

ALLOW_REGISTRATION=${CFG_ALLOW_REG:-true}
ENABLE_OAUTH=${CFG_OAUTH:-true}

FEAT_DISCOVERY=${CFG_DISCOVERY:-true}
FEAT_VOICE=${CFG_VOICE:-true}
FEAT_E2E=${CFG_E2E:-true}
FEAT_BOTS=${CFG_BOTS:-true}
FEAT_FEDERATION=${CFG_FED:-false}

ADMIN_USERNAME="${CFG_ADMIN_USER:-admin}"
ADMIN_PASSWORD="${CFG_ADMIN_PASS:-}"
ADMIN_EMAIL="${CFG_ADMIN_EMAIL:-}"
EOF
  spin_stop
  ok ".env written"
}

write_config() {
  spin_start "Writing config.json..."
  cat > config.json <<EOF
{
  "server": {
    "name": "${CFG_SERVER_NAME:-Volt}",
    "version": "1.0.0",
    "mode": "${CFG_MODE:-mainline}",
    "url": "${CFG_SERVER_URL:-http://localhost:3000}",
    "port": ${CFG_PORT:-3000}
  },
  "storage": {
    "type": "${CFG_STORAGE:-sqlite}",
    "sqlite": { "dbPath": "./data/voltage.db" },
    "postgres": {
      "host": "${CFG_DB_HOST:-localhost}",
      "port": ${CFG_DB_PORT:-5432},
      "database": "${CFG_DB_NAME:-voltchat}",
      "user": "${CFG_DB_USER:-}",
      "password": "${CFG_DB_PASS:-}"
    },
    "mysql": {
      "host": "${CFG_DB_HOST:-localhost}",
      "port": ${CFG_DB_PORT:-3306},
      "database": "${CFG_DB_NAME:-voltchat}",
      "user": "${CFG_DB_USER:-}",
      "password": "${CFG_DB_PASS:-}"
    }
  },
  "auth": {
    "type": "all",
    "local": { "enabled": true, "allowRegistration": ${CFG_ALLOW_REG:-true} },
    "oauth": { "enabled": ${CFG_OAUTH:-true}, "provider": "enclica" }
  },
  "security": {
    "jwtSecret": "${CFG_JWT_SECRET}",
    "jwtExpiry": "${CFG_JWT_EXPIRY:-7d}",
    "bcryptRounds": 12,
    "rateLimit": { "windowMs": 60000, "maxRequests": 100 },
    "adminUsers": ["${CFG_ADMIN_USER:-admin}"]
  },
  "features": {
    "discovery":        ${CFG_DISCOVERY:-true},
    "selfVolt":         true,
    "voiceChannels":    ${CFG_VOICE:-true},
    "videoChannels":    ${CFG_VOICE:-true},
    "e2eEncryption":    ${CFG_E2E:-true},
    "e2eTrueEncryption":${CFG_E2E:-true},
    "communities":      true,
    "bots":             ${CFG_BOTS:-true},
    "federation":       ${CFG_FED:-false}
  },
  "limits": {
    "maxUploadSize": 10485760,
    "maxServersPerUser": 100,
    "maxMessageLength": 4000
  },
  "cdn": {
    "enabled": false,
    "provider": "local",
    "local": { "uploadDir": "./uploads", "baseUrl": null }
  },
  "federation": {
    "enabled": ${CFG_FED:-false},
    "serverName": null,
    "maxHops": 3
  },
  "monitoring": { "enabled": false }
}
EOF
  spin_stop
  ok "config.json written"
}

# ── Summary ───────────────────────────────────────────────────
print_summary() {
  section "Setup Complete"
  printf '\n'
  center "${BBLU}${B}  ⚡  Voltage is ready!  ⚡  ${R}"
  printf '\n'

  # box
  local bw=45
  local bl=$(( (COLS - bw - 2) / 2 )); [[ $bl -lt 0 ]] && bl=0
  local p; p=$(pad "$bl")

  printf '%s%s┌%s┐%s\n' "$p" "$DM$CYN" "$(printf '%0.s─' $(seq 1 $bw))" "$R"
  _brow() { printf '%s%s│%s  %-41s  %s│%s\n' "$p" "$DM$CYN" "$R" "$1" "$DM$CYN" "$R"; }
  _brow "${B}Server:${R}   ${CFG_SERVER_NAME:-Volt}"
  _brow "${B}URL:${R}      ${CFG_SERVER_URL:-http://localhost:3000}"
  _brow "${B}Mode:${R}     ${CFG_MODE:-mainline}"
  _brow "${B}Storage:${R}  ${CFG_STORAGE:-sqlite}"
  _brow "${B}Admin:${R}    @${CFG_ADMIN_USER:-admin}"
  printf '%s%s└%s┘%s\n' "$p" "$DM$CYN" "$(printf '%0.s─' $(seq 1 $bw))" "$R"

  printf '\n'
  printf '  %sTo start Voltage:%s\n\n' "$BYLW" "$R"
  printf '    %s$%s %snpm start%s       %s# production%s\n' \
    "$BGRN" "$R" "$B" "$R" "$DM" "$R"
  printf '    %s$%s %snpm run dev%s     %s# development (auto-reload)%s\n' \
    "$BGRN" "$R" "$B" "$R" "$DM" "$R"
  printf '\n'
  hline '─'
  center "${DM}Thank you for running Voltage ⚡${R}"
  hline '─'
  printf '\n'
}

# ── Main ──────────────────────────────────────────────────────
main() {
  if [[ ! -f "server.js" && ! -f "package.json" ]]; then
    printf '\nERROR: Run this script from inside the Voltage directory.\n\n'
    exit 1
  fi

  boot_sequence
  check_deps
  install_deps
  run_wizard
  create_dirs
  write_env
  write_config
  print_summary
}

main "$@"
