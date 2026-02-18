#!/usr/bin/env bash
# =============================================================
#  Voltage Setup Script — animated TUI
# =============================================================
# Use bash explicitly; avoid set -e so animations never abort
# on non-zero subshell exits
set -uo pipefail

# ── Real ESC byte ─────────────────────────────────────────────
ESC=$'\033'
R="${ESC}[0m"   B="${ESC}[1m"   DM="${ESC}[2m"
BRED="${ESC}[91m"  BGRN="${ESC}[92m"  BYLW="${ESC}[93m"
BBLU="${ESC}[94m"  BMAG="${ESC}[95m"  BCYN="${ESC}[96m"
BWHT="${ESC}[97m"  CYN="${ESC}[36m"   WHT="${ESC}[37m"

# ── Terminal width (safe) ─────────────────────────────────────
COLS=80
if command -v tput &>/dev/null; then
  _c=$(tput cols 2>/dev/null) && [[ "$_c" =~ ^[0-9]+$ ]] && COLS=$(( _c > 0 ? _c : 80 ))
fi

# ── Cursor helpers ────────────────────────────────────────────
cur_hide() { printf '%s' "${ESC}[?25l"; }
cur_show() { printf '%s' "${ESC}[?25h"; }
trap 'cur_show; printf "\n"' EXIT INT TERM

# ── Helpers ───────────────────────────────────────────────────
# Print N spaces
spaces() { local n=$1 s=''; while [[ $n -gt 0 ]]; do s="$s "; n=$((n-1)); done; printf '%s' "$s"; }

# Center a plain string (no ANSI)
center_plain() {
  local str="$1" color="${2:-$R}"
  local len=${#str}
  local left=$(( (COLS - len) / 2 ))
  [[ $left -lt 0 ]] && left=0
  spaces "$left"; printf '%s%s%s\n' "$color" "$str" "$R"
}

hline() {
  local line='' i=0
  while [[ $i -lt $COLS ]]; do line="${line}-"; i=$((i+1)); done
  printf '%s%s%s\n' "${DM}${CYN}" "$line" "$R"
}

ok()   { printf "  ${BGRN}OK${R}  %s\n"   "$1"; }
warn() { printf "  ${BYLW}!!${R}  %s\n"   "$1"; }
err()  { printf "  ${BRED}ERR${R} %s\n"   "$1"; }
step() { printf "\n  ${BBLU}>>${R}  ${B}%s${R}\n" "$1"; }

section() {
  printf '\n'; hline
  center_plain "$1" "${B}${BWHT}"
  hline; printf '\n'
}

# ── Spinner (background process) ─────────────────────────────
_spin_pid=0
spin_start() {
  local msg="${1:-Working...}"
  cur_hide
  (
    local chars='-\|/' i=0
    while true; do
      ch="${chars:$((i%4)):1}"
      printf '\r  %s%s%s  %s%s%s   ' "$BBLU" "$ch" "$R" "$CYN" "$msg" "$R"
      sleep 0.1
      i=$((i+1))
    done
  ) &
  _spin_pid=$!
}
spin_stop() {
  if [[ $_spin_pid -ne 0 ]]; then
    kill "$_spin_pid" 2>/dev/null
    wait "$_spin_pid" 2>/dev/null || true
    _spin_pid=0
  fi
  printf '\r%*s\r' "$COLS" ''
  cur_show
}

# ── ASCII logo (pure ASCII — no multi-byte chars) ─────────────
# Row-by-row reveal with colour cycling: blue->cyan->magenta
LOGO_ROWS=(
  " _   _  ___  _    _____  _    ___  _____"
  "| | | |/ _ \| |  |_   _|/ \  / _ \| ____|"
  "| | | | | | | |    | | / _ \| | | |  _|"
  "| |_| | |_| | |___ | |/ ___ \ |_| | |___"
  " \___/ \___/|_____|_/_/   \_\___/|_____|"
)

LOGO_COLOURS=("$BBLU" "$BBLU" "$BCYN" "$BMAG" "$BMAG")

animate_logo() {
  printf '\n'
  local ri=0
  for row in "${LOGO_ROWS[@]}"; do
    local col="${LOGO_COLOURS[$ri]:-$BMAG}"
    local len=${#row}
    local left=$(( (COLS - len) / 2 ))
    [[ $left -lt 0 ]] && left=0
    spaces "$left"
    # Print row char by char for the animation effect
    local i=0
    while [[ $i -lt $len ]]; do
      printf '%s%s%s' "$col" "${row:$i:1}" "$R"
      i=$((i+1))
      # tiny delay — use printf timing trick without sleep subprocess overhead
      read -rt 0.004 _ </dev/null 2>/dev/null || true
    done
    printf '\n'
    ri=$((ri+1))
  done

  # Subtitle
  printf '\n'
  local sub="<<  The Decentralized Chat Platform  >>"
  local sl=${#sub}
  local sleft=$(( (COLS - sl) / 2 ))
  [[ $sleft -lt 0 ]] && sleft=0
  spaces "$sleft"
  local si=0
  while [[ $si -lt $sl ]]; do
    printf '%s%s%s' "$BYLW" "${sub:$si:1}" "$R"
    read -rt 0.018 _ </dev/null 2>/dev/null || true
    si=$((si+1))
  done
  printf '\n\n'
}

# ── Initialising animation (single overwriting line) ──────────
init_animation() {
  cur_hide
  local i=0
  while [[ $i -lt 16 ]]; do
    local dots=''
    case $((i % 4)) in
      1) dots='.'   ;;
      2) dots='..'  ;;
      3) dots='...' ;;
    esac
    local msg="Initialising subsystems${dots}"
    local mlen=${#msg}
    local left=$(( (COLS - mlen) / 2 ))
    [[ $left -lt 0 ]] && left=0
    printf '\r'; spaces "$left"
    printf '%s%s%s%s%s     ' "$CYN" "Initialising subsystems" "$BYLW" "$dots" "$R"
    sleep 0.13
    i=$((i+1))
  done
  printf '\r%*s\r\n' "$COLS" ''
  cur_show
}

# ── Charging bar (single growing line) ────────────────────────
charging_bar() {
  local label="  Charging the Volt..."
  local ll=${#label}
  local lleft=$(( (COLS - ll) / 2 ))
  [[ $lleft -lt 0 ]] && lleft=0
  spaces "$lleft"; printf '%s%s%s\n\n' "$DM" "$label" "$R"

  # bar width = terminal width minus margins
  local bw=$(( COLS - 8 ))
  [[ $bw -lt 10 ]] && bw=10
  local bleft=$(( (COLS - bw - 2) / 2 ))
  [[ $bleft -lt 0 ]] && bleft=0

  spaces "$bleft"; printf '%s[%s' "$BBLU" "$R"
  local bi=0
  while [[ $bi -lt $bw ]]; do
    printf '%s#%s' "$BBLU" "$R"
    read -rt 0.015 _ </dev/null 2>/dev/null || true
    bi=$((bi+1))
  done
  printf '%s]%s\n\n' "$BBLU" "$R"
}

boot_sequence() {
  clear
  animate_logo
  init_animation
  charging_bar
  sleep 0.3
}

# ── Input helpers ─────────────────────────────────────────────
ask() {
  local _var="$1" _prompt="$2" _def="${3:-}" _val=''
  if [[ -n "$_def" ]]; then
    printf '  %s?%s  %s%s%s %s(%s)%s: ' "$BCYN" "$R" "$B" "$_prompt" "$R" "$DM" "$_def" "$R"
  else
    printf '  %s?%s  %s%s%s: ' "$BCYN" "$R" "$B" "$_prompt" "$R"
  fi
  IFS= read -r _val || true
  [[ -z "$_val" ]] && _val="$_def"
  printf -v "$_var" '%s' "$_val"
}

ask_secret() {
  local _var="$1" _prompt="$2" _val=''
  printf '  %s*%s  %s%s%s: ' "$BMAG" "$R" "$B" "$_prompt" "$R"
  IFS= read -rs _val || true; printf '\n'
  printf -v "$_var" '%s' "$_val"
}

ask_yn() {
  local _var="$1" _prompt="$2" _def="${3:-y}" _ans=''
  local _d
  [[ "$_def" == "y" ]] && _d="${BGRN}Y${R}${DM}/n${R}" || _d="${DM}y/${R}${BGRN}N${R}"
  printf '  %s?%s  %s%s%s [%s]: ' "$BCYN" "$R" "$B" "$_prompt" "$R" "$_d"
  IFS= read -r _ans || true
  [[ -z "$_ans" ]] && _ans="$_def"
  if [[ "${_ans}" =~ ^[Yy] ]]; then printf -v "$_var" 'true'
  else printf -v "$_var" 'false'; fi
}

ask_choice() {
  local _var="$1" _prompt="$2"; shift 2
  local _opts=("$@") _i=1 _ch=1
  printf '\n  %s?%s  %s%s%s\n' "$BCYN" "$R" "$B" "$_prompt" "$R"
  for _o in "${_opts[@]}"; do
    printf '     %s%d)%s %s\n' "$DM" "$_i" "$R" "$_o"
    _i=$((_i+1))
  done
  printf '\n  %s>%s Enter number %s[1-%d]%s: ' "$BCYN" "$R" "$DM" "${#_opts[@]}" "$R"
  IFS= read -r _ch || true
  [[ -z "$_ch" || ! "$_ch" =~ ^[0-9]+$ ]] && _ch=1
  [[ $_ch -lt 1 ]] && _ch=1
  [[ $_ch -gt ${#_opts[@]} ]] && _ch=${#_opts[@]}
  local _sel="${_opts[$((_ch-1))]}"
  printf -v "$_var" '%s' "${_sel%% *}"
}

gen_jwt() {
  if command -v openssl &>/dev/null; then
    openssl rand -hex 64 2>/dev/null
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
    local nmaj
    nmaj=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))" 2>/dev/null || echo 0)
    if [[ $nmaj -lt 18 ]]; then
      err "Node.js v${nmaj} detected — Voltage needs v18+"
      missing+=("node>=18")
    fi
  fi

  for cmd in git openssl; do
    if command -v "$cmd" &>/dev/null; then
      ok "${B}${cmd}${R} found"
    else
      warn "${B}${cmd}${R} not found ${DM}(optional)${R}"
    fi
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    printf '\n'; err "Missing required: ${missing[*]}"
    err "Please install them and re-run setup."
    exit 1
  fi
  printf '\n'; ok "All required dependencies satisfied"
}

install_deps() {
  section "Installing Node Packages"
  spin_start "Running npm install..."
  if npm install --silent 2>/dev/null; then
    spin_stop; ok "Packages installed"
  else
    spin_stop; warn "Retrying with full output..."
    npm install || { err "npm install failed"; exit 1; }
    ok "Packages installed"
  fi
}

run_wizard() {
  section "Configuration Wizard"
  printf '  %s%s%s\n\n' "$DM" "Answer each question and press Enter to accept the default." "$R"

  step "Server Identity"; printf '\n'
  ask  CFG_NAME   "Server name"              "Volt"
  ask  CFG_URL    "Public URL"               "http://localhost:3000"
  ask  CFG_PORT   "Port"                     "3000"
  ask_choice CFG_MODE "Server mode" \
    "mainline   (connect to the main Volt network)" \
    "self-volt  (standalone / private instance)" \
    "federated  (federate with other Volt servers)"

  step "Storage Backend"; printf '\n'
  ask_choice CFG_STORAGE "Database engine" \
    "json      (flat files, zero config)" \
    "sqlite    (recommended, no server needed)" \
    "postgres  (PostgreSQL)" \
    "mysql     (MySQL / MariaDB)"

  CFG_DB_HOST='' CFG_DB_PORT='' CFG_DB_NAME='' CFG_DB_USER='' CFG_DB_PASS=''
  if [[ "$CFG_STORAGE" == "postgres" || "$CFG_STORAGE" == "mysql" ]]; then
    printf '\n'
    ask CFG_DB_HOST "Database host" "localhost"
    [[ "$CFG_STORAGE" == "postgres" ]] \
      && ask CFG_DB_PORT "Database port" "5432" \
      || ask CFG_DB_PORT "Database port" "3306"
    ask CFG_DB_NAME "Database name" "voltchat"
    ask CFG_DB_USER "Database user" "volt"
    ask_secret CFG_DB_PASS "Database password"
  fi

  step "Authentication"; printf '\n'
  ask_yn CFG_ALLOW_REG "Allow new user registration?" "y"
  ask_yn CFG_OAUTH     "Enable OAuth / SSO login?"    "y"

  step "Security"; printf '\n'
  spin_start "Generating JWT secret..."
  CFG_JWT=$(gen_jwt)
  spin_stop
  ok "JWT secret generated  ${DM}(${CFG_JWT:0:16}...)${R}"
  ask CFG_JWT_EXP "Token expiry" "7d"

  step "Features"; printf '\n'
  ask_yn CFG_DISC  "Enable server discovery?"       "y"
  ask_yn CFG_VOICE "Enable voice & video channels?" "y"
  ask_yn CFG_E2E   "Enable end-to-end encryption?"  "y"
  ask_yn CFG_BOTS  "Enable bot API?"                "y"
  ask_yn CFG_FED   "Enable federation?"             "n"

  step "Admin Account"; printf '\n'
  ask        CFG_ADMIN      "Admin username"          "admin"
  ask_secret CFG_ADMINPASS  "Admin password"
  ask        CFG_ADMINEMAIL "Admin e-mail (optional)" ""
}

create_dirs() {
  section "Preparing Filesystem"
  spin_start "Creating directories..."
  mkdir -p data uploads logs
  spin_stop
  ok "Directories created  ${DM}(data/  uploads/  logs/)${R}"
}

write_env() {
  spin_start "Writing .env..."
  cat > .env <<EOF
# Voltage -- generated by setup.sh $(date -u '+%Y-%m-%d %H:%M UTC')

PORT=${CFG_PORT:-3000}
NODE_ENV=production
SERVER_NAME="${CFG_NAME:-Volt}"
SERVER_URL="${CFG_URL:-http://localhost:3000}"
SERVER_MODE="${CFG_MODE:-mainline}"

JWT_SECRET="${CFG_JWT:-}"
JWT_EXPIRY="${CFG_JWT_EXP:-7d}"
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
FEAT_DISCOVERY=${CFG_DISC:-true}
FEAT_VOICE=${CFG_VOICE:-true}
FEAT_E2E=${CFG_E2E:-true}
FEAT_BOTS=${CFG_BOTS:-true}
FEAT_FEDERATION=${CFG_FED:-false}

ADMIN_USERNAME="${CFG_ADMIN:-admin}"
ADMIN_PASSWORD="${CFG_ADMINPASS:-}"
ADMIN_EMAIL="${CFG_ADMINEMAIL:-}"
EOF
  spin_stop; ok ".env written"
}

write_config() {
  spin_start "Writing config.json..."
  cat > config.json <<EOF
{
  "server": {
    "name": "${CFG_NAME:-Volt}",
    "version": "1.0.0",
    "mode": "${CFG_MODE:-mainline}",
    "url": "${CFG_URL:-http://localhost:3000}",
    "port": ${CFG_PORT:-3000}
  },
  "storage": {
    "type": "${CFG_STORAGE:-sqlite}",
    "sqlite": { "dbPath": "./data/voltage.db" },
    "postgres": { "host": "${CFG_DB_HOST:-localhost}", "port": ${CFG_DB_PORT:-5432}, "database": "${CFG_DB_NAME:-voltchat}", "user": "${CFG_DB_USER:-}", "password": "${CFG_DB_PASS:-}" },
    "mysql":    { "host": "${CFG_DB_HOST:-localhost}", "port": ${CFG_DB_PORT:-3306}, "database": "${CFG_DB_NAME:-voltchat}", "user": "${CFG_DB_USER:-}", "password": "${CFG_DB_PASS:-}" }
  },
  "auth": {
    "type": "all",
    "local": { "enabled": true, "allowRegistration": ${CFG_ALLOW_REG:-true} },
    "oauth": { "enabled": ${CFG_OAUTH:-true}, "provider": "enclica" }
  },
  "security": {
    "jwtSecret": "${CFG_JWT:-}",
    "jwtExpiry": "${CFG_JWT_EXP:-7d}",
    "bcryptRounds": 12,
    "rateLimit": { "windowMs": 60000, "maxRequests": 100 },
    "adminUsers": ["${CFG_ADMIN:-admin}"]
  },
  "features": {
    "discovery":         ${CFG_DISC:-true},
    "selfVolt":          true,
    "voiceChannels":     ${CFG_VOICE:-true},
    "videoChannels":     ${CFG_VOICE:-true},
    "e2eEncryption":     ${CFG_E2E:-true},
    "e2eTrueEncryption": ${CFG_E2E:-true},
    "communities":       true,
    "bots":              ${CFG_BOTS:-true},
    "federation":        ${CFG_FED:-false}
  },
  "limits": { "maxUploadSize": 10485760, "maxServersPerUser": 100, "maxMessageLength": 4000 },
  "cdn": { "enabled": false, "provider": "local", "local": { "uploadDir": "./uploads", "baseUrl": null } },
  "federation": { "enabled": ${CFG_FED:-false}, "serverName": null, "maxHops": 3 },
  "monitoring": { "enabled": false }
}
EOF
  spin_stop; ok "config.json written"
}

print_summary() {
  section "Setup Complete"
  printf '\n'
  center_plain "<< Voltage is ready! >>" "${BBLU}${B}"
  printf '\n'

  local bw=46
  local bl=$(( (COLS - bw - 2) / 2 ))
  [[ $bl -lt 0 ]] && bl=0
  local p; p=$(spaces "$bl")

  local bar=''
  local bi=0; while [[ $bi -lt $bw ]]; do bar="${bar}-"; bi=$((bi+1)); done

  printf '%s%s+%s+%s\n' "$p" "${DM}${CYN}" "$bar" "$R"
  _row() { printf '%s%s|%s  %-41s  %s|%s\n' "$p" "${DM}${CYN}" "$R" "$1" "${DM}${CYN}" "$R"; }
  _row "${B}Server:${R}   ${CFG_NAME:-Volt}"
  _row "${B}URL:${R}      ${CFG_URL:-http://localhost:3000}"
  _row "${B}Mode:${R}     ${CFG_MODE:-mainline}"
  _row "${B}Storage:${R}  ${CFG_STORAGE:-sqlite}"
  _row "${B}Admin:${R}    @${CFG_ADMIN:-admin}"
  printf '%s%s+%s+%s\n' "$p" "${DM}${CYN}" "$bar" "$R"

  printf '\n  %sTo start Voltage:%s\n\n' "$BYLW" "$R"
  printf '    %s$%s %snpm start%s      %s# production%s\n'    "$BGRN" "$R" "$B" "$R" "$DM" "$R"
  printf '    %s$%s %snpm run dev%s    %s# development%s\n'   "$BGRN" "$R" "$B" "$R" "$DM" "$R"
  printf '\n'; hline
  center_plain "Thank you for running Voltage!" "$DM"
  hline; printf '\n'
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
