#!/usr/bin/env bash
# =============================================================
#  Voltage — Setup Script  (animated TUI)
# =============================================================
set -euo pipefail

# ── Real ESC byte via $'...' ANSI-C quoting ──────────────────
ESC=$'\033'

R="${ESC}[0m"
B="${ESC}[1m"
DM="${ESC}[2m"

BRED="${ESC}[91m"
BGRN="${ESC}[92m"
BYLW="${ESC}[93m"
BBLU="${ESC}[94m"
BMAG="${ESC}[95m"
BCYN="${ESC}[96m"
BWHT="${ESC}[97m"
CYN="${ESC}[36m"
WHT="${ESC}[37m"
MAG="${ESC}[35m"

# ── Terminal width ────────────────────────────────────────────
COLS=80
_c=$(tput cols 2>/dev/null || true)
[[ "${_c:-0}" -gt 0 ]] 2>/dev/null && COLS=$_c

# ── Cursor helpers ────────────────────────────────────────────
cur_hide() { printf "${ESC}[?25l"; }
cur_show() { printf "${ESC}[?25h"; }
cur_up()   { printf "${ESC}[%dA" "${1:-1}"; }

# Restore cursor on exit
trap 'cur_show; printf "\n"' EXIT INT TERM

# ── Padding (pure bash, no bc) ────────────────────────────────
rpad() { local n=$1 s=''; while (( n-- > 0 )); do s+=' '; done; printf '%s' "$s"; }

# Strip ANSI codes, return visible length in $VIS_LEN
vis_len() {
  local stripped
  stripped=$(printf '%s' "$1" | sed $'s/\033\\[[0-9;]*m//g')
  VIS_LEN=${#stripped}
}

center_print() {
  local str="$1"
  vis_len "$str"
  local left=$(( (COLS - VIS_LEN) / 2 ))
  (( left < 0 )) && left=0
  rpad "$left"
  printf '%s\n' "$str"
}

hline() {
  local i=0; printf "${DM}${CYN}"
  while (( i++ < COLS )); do printf '─'; done
  printf "${R}\n"
}

# ── Status helpers ────────────────────────────────────────────
ok()   { printf "  ${BGRN}✔${R}  %s\n" "$1"; }
info() { printf "  ${BCYN}ℹ${R}  %s\n" "$1"; }
warn() { printf "  ${BYLW}⚠${R}  %s\n" "$1"; }
err()  { printf "  ${BRED}✖${R}  %s\n" "$1"; }
step() { printf "\n  ${BBLU}▶${R}  ${B}%s${R}\n" "$1"; }

section() {
  printf '\n'
  hline
  center_print "${B}${BWHT}$1${R}"
  hline
  printf '\n'
}

# ── Spinner ───────────────────────────────────────────────────
_spin_pid=0

spin_start() {
  local msg="${1:-Please wait...}"
  cur_hide
  ( local f='⣾⣽⣻⢿⡿⣟⣯⣷' i=0
    while true; do
      printf "\r  ${BBLU}${f:$((i%8)):1}${R}  ${CYN}${msg}${R}   "
      sleep 0.07; (( i++ ))
    done ) &
  _spin_pid=$!
}

spin_stop() {
  [[ $_spin_pid -ne 0 ]] && { kill "$_spin_pid" 2>/dev/null; wait "$_spin_pid" 2>/dev/null || true; }
  _spin_pid=0
  printf "\r%${COLS}s\r"
  cur_show
}

# ── Animated logo — character by character ────────────────────
LOGO=(
  "${BBLU}██╗   ██╗ ██████╗ ██╗  ████████╗ █████╗  ██████╗ ███████╗${R}"
  "${BBLU}██║   ██║██╔═══██╗██║  ╚══██╔══╝██╔══██╗██╔════╝ ██╔════╝${R}"
  "${BCYN}██║   ██║██║   ██║██║     ██║   ███████║██║  ███╗█████╗  ${R}"
  "${BCYN}╚██╗ ██╔╝██║   ██║██║     ██║   ██╔══██║██║   ██║██╔══╝  ${R}"
  "${BMAG} ╚████╔╝ ╚██████╔╝███████╗██║   ██║  ██║╚██████╔╝███████╗${R}"
  "${BMAG}  ╚═══╝   ╚═════╝ ╚══════╝╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚══════╝${R}"
)

# Plain versions for width calculation
LOGO_PLAIN=(
  "██╗   ██╗ ██████╗ ██╗  ████████╗ █████╗  ██████╗ ███████╗"
  "██║   ██║██╔═══██╗██║  ╚══██╔══╝██╔══██╗██╔════╝ ██╔════╝"
  "██║   ██║██║   ██║██║     ██║   ███████║██║  ███╗█████╗  "
  "╚██╗ ██╔╝██║   ██║██║     ██║   ██╔══██║██║   ██║██╔══╝  "
  " ╚████╔╝ ╚██████╔╝███████╗██║   ██║  ██║╚██████╔╝███████╗"
  "  ╚═══╝   ╚═════╝ ╚══════╝╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚══════╝"
)

LOGO_COLOURS=("$BBLU" "$BBLU" "$BCYN" "$BCYN" "$BMAG" "$BMAG")

animate_logo() {
  cur_hide
  printf '\n'
  local ri=0
  for plain in "${LOGO_PLAIN[@]}"; do
    local col="${LOGO_COLOURS[$ri]}"
    local vl=${#plain}
    local left=$(( (COLS - vl) / 2 ))
    (( left < 0 )) && left=0
    rpad "$left"
    # Print character by character
    local ci=0
    while (( ci < ${#plain} )); do
      printf "${col}%s${R}" "${plain:$ci:1}"
      sleep 0.003
      (( ci++ ))
    done
    printf '\n'
    (( ri++ ))
  done
  printf '\n'

  # Subtitle — character by character
  local sub="⚡  The Decentralized Chat Platform  ⚡"
  local sl=${#sub}
  local sleft=$(( (COLS - sl) / 2 ))
  (( sleft < 0 )) && sleft=0
  rpad "$sleft"
  local si=0
  while (( si < ${#sub} )); do
    printf "${BYLW}%s${R}" "${sub:$si:1}"
    sleep 0.022
    (( si++ ))
  done
  printf '\n\n'
  cur_show
}

# ── Boot sequence ─────────────────────────────────────────────
boot_sequence() {
  clear
  animate_logo

  # "Initialising…" — single overwriting line
  cur_hide
  local i=0
  while (( i < 16 )); do
    local dots=''
    case $(( i % 4 )) in 1) dots='.' ;; 2) dots='..' ;; 3) dots='...' ;; esac
    local msg="${CYN}Initialising subsystems${BYLW}${dots}${R}"
    # print on current line, pad right to clear leftovers
    vis_len "Initialising subsystems${dots}"
    local left=$(( (COLS - VIS_LEN) / 2 ))
    (( left < 0 )) && left=0
    printf "\r"
    rpad "$left"
    printf "${CYN}Initialising subsystems${BYLW}${dots}${R}     "
    sleep 0.13
    (( i++ ))
  done
  printf "\n\n"
  cur_show

  # Charging bar — grows on ONE line
  local label="Charging the Volt..."
  local ll=${#label}
  local lleft=$(( (COLS - ll) / 2 ))
  (( lleft < 0 )) && lleft=0
  rpad "$lleft"; printf "${DM}${label}${R}\n\n"

  local bw=$(( COLS - 4 ))
  (( bw < 20 )) && bw=20
  local bleft=$(( (COLS - bw - 2) / 2 ))
  (( bleft < 0 )) && bleft=0

  rpad "$bleft"; printf "${BBLU}[${R}"
  local bi=0
  while (( bi < bw )); do
    printf "${BBLU}⚡${R}"
    sleep 0.012
    (( bi++ ))
  done
  printf "${BBLU}]${R}\n\n"
  sleep 0.3
}

# ── Input helpers ─────────────────────────────────────────────
ask() {
  local _var="$1" _prompt="$2" _def="${3:-}" _val=''
  if [[ -n "$_def" ]]; then
    printf "  ${BCYN}?${R}  ${B}%s${R} ${DM}(%s)${R}: " "$_prompt" "$_def"
  else
    printf "  ${BCYN}?${R}  ${B}%s${R}: " "$_prompt"
  fi
  IFS= read -r _val
  [[ -z "$_val" ]] && _val="$_def"
  printf -v "$_var" '%s' "$_val"
}

ask_secret() {
  local _var="$1" _prompt="$2" _val=''
  printf "  ${BMAG}🔒${R}  ${B}%s${R}: " "$_prompt"
  IFS= read -rs _val; printf '\n'
  printf -v "$_var" '%s' "$_val"
}

ask_yn() {
  local _var="$1" _prompt="$2" _def="${3:-y}" _ans=''
  local _d
  [[ "$_def" == "y" ]] && _d="${BGRN}Y${R}${DM}/n${R}" || _d="${DM}y/${R}${BGRN}N${R}"
  printf "  ${BCYN}?${R}  ${B}%s${R} [%s]: " "$_prompt" "$_d"
  IFS= read -r _ans
  [[ -z "$_ans" ]] && _ans="$_def"
  if [[ "${_ans,,}" == y* ]]; then printf -v "$_var" 'true'
  else printf -v "$_var" 'false'; fi
}

ask_choice() {
  local _var="$1" _prompt="$2"; shift 2
  local _opts=("$@") _i=1 _ch=1
  printf "\n  ${BCYN}?${R}  ${B}%s${R}\n" "$_prompt"
  for _o in "${_opts[@]}"; do
    printf "     ${DM}%d)${R} %s\n" "$_i" "$_o"
    (( _i++ ))
  done
  printf "\n  ${BCYN}→${R} Enter number ${DM}[1-%d]${R}: " "${#_opts[@]}"
  IFS= read -r _ch
  [[ -z "$_ch" || ! "$_ch" =~ ^[0-9]+$ ]] && _ch=1
  (( _ch < 1 )) && _ch=1
  (( _ch > ${#_opts[@]} )) && _ch=${#_opts[@]}
  local _sel="${_opts[$(( _ch - 1 ))]}"
  printf -v "$_var" '%s' "${_sel%% *}"
}

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
    if (( nmaj < 18 )); then
      err "Node.js v${nmaj} is too old — Voltage requires v18+"
      missing+=("node>=18")
    fi
  fi
  for cmd in git openssl; do
    command -v "$cmd" &>/dev/null \
      && ok "${B}${cmd}${R} found" \
      || warn "${B}${cmd}${R} not found ${DM}(optional)${R}"
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    printf '\n'; err "Missing: ${missing[*]}"
    err "Install the above then re-run this script."
    exit 1
  fi
  printf '\n'; ok "All required dependencies satisfied"
}

install_deps() {
  section "Installing Node Packages"
  spin_start "Running npm install..."
  npm install --silent 2>/dev/null && spin_stop && ok "Packages installed" \
    || { spin_stop; warn "Retrying verbosely..."; npm install || { err "npm install failed"; exit 1; }; ok "Packages installed"; }
}

# ── Wizard ────────────────────────────────────────────────────
run_wizard() {
  section "Configuration Wizard"
  printf "  ${DM}${WHT}Answer each question — press Enter to keep the default.${R}\n\n"

  step "Server Identity"; printf '\n'
  ask  CFG_NAME  "Server name"              "Volt"
  ask  CFG_URL   "Public URL"               "http://localhost:3000"
  ask  CFG_PORT  "Port"                     "3000"
  ask_choice CFG_MODE "Server mode" \
    "mainline   (connect to the main Volt network)" \
    "self-volt  (standalone / private)" \
    "federated  (federate with other Volt servers)"

  step "Storage Backend"; printf '\n'
  ask_choice CFG_STORAGE "Database engine" \
    "json      (flat files — zero config, good for testing)" \
    "sqlite    (recommended — no server needed)" \
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
  ok "JWT secret generated  ${DM}(${CFG_JWT:0:16}…)${R}"
  ask CFG_JWT_EXP "Token expiry" "7d"

  step "Features"; printf '\n'
  ask_yn CFG_DISC  "Enable server discovery?"       "y"
  ask_yn CFG_VOICE "Enable voice & video channels?" "y"
  ask_yn CFG_E2E   "Enable end-to-end encryption?"  "y"
  ask_yn CFG_BOTS  "Enable bot API?"                "y"
  ask_yn CFG_FED   "Enable federation?"             "n"

  step "Initial Admin Account"; printf '\n'
  ask        CFG_ADMIN     "Admin username"          "admin"
  ask_secret CFG_ADMINPASS "Admin password"
  ask        CFG_ADMINEMAIL "Admin e-mail (optional)" ""
}

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
SERVER_NAME="${CFG_NAME:-Volt}"
SERVER_URL="${CFG_URL:-http://localhost:3000}"
SERVER_MODE="${CFG_MODE:-mainline}"

JWT_SECRET="${CFG_JWT}"
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
    "jwtSecret": "${CFG_JWT}",
    "jwtExpiry": "${CFG_JWT_EXP:-7d}",
    "bcryptRounds": 12,
    "rateLimit": { "windowMs": 60000, "maxRequests": 100 },
    "adminUsers": ["${CFG_ADMIN:-admin}"]
  },
  "features": {
    "discovery": ${CFG_DISC:-true},
    "selfVolt": true,
    "voiceChannels": ${CFG_VOICE:-true},
    "videoChannels": ${CFG_VOICE:-true},
    "e2eEncryption": ${CFG_E2E:-true},
    "e2eTrueEncryption": ${CFG_E2E:-true},
    "communities": true,
    "bots": ${CFG_BOTS:-true},
    "federation": ${CFG_FED:-false}
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
  center_print "${BBLU}${B}⚡  Voltage is ready!  ⚡${R}"
  printf '\n'

  local bw=47
  local bl=$(( (COLS - bw - 2) / 2 )); (( bl < 0 )) && bl=0
  local p; p=$(rpad "$bl")

  _br() { printf '%s'"${DM}${CYN}│${R}  %-42s  ${DM}${CYN}│${R}"'\n' "$p" "$1"; }
  local line; line=$(rpad 0); local lc="$p${DM}${CYN}"
  local hbar=''; local i=0; while (( i++ < bw )); do hbar+='─'; done
  printf '%s┌%s┐\n' "$lc" "$hbar${R}"
  _br "${B}Server:${R}   ${CFG_NAME:-Volt}"
  _br "${B}URL:${R}      ${CFG_URL:-http://localhost:3000}"
  _br "${B}Mode:${R}     ${CFG_MODE:-mainline}"
  _br "${B}Storage:${R}  ${CFG_STORAGE:-sqlite}"
  _br "${B}Admin:${R}    @${CFG_ADMIN:-admin}"
  printf '%s└%s┘\n' "$lc" "$hbar${R}"

  printf '\n'
  printf "  ${BYLW}To start Voltage:${R}\n\n"
  printf "    ${BGRN}\$${R} ${B}npm start${R}      ${DM}# production${R}\n"
  printf "    ${BGRN}\$${R} ${B}npm run dev${R}    ${DM}# development (auto-reload)${R}\n"
  printf '\n'
  hline
  center_print "${DM}Thank you for running Voltage ⚡${R}"
  hline
  printf '\n'
}

# ── Main ──────────────────────────────────────────────────────
main() {
  [[ ! -f "server.js" && ! -f "package.json" ]] && {
    printf '\nERROR: Run this script from inside the Voltage directory.\n\n'; exit 1
  }
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
