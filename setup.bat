@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
title Voltage Setup

:: ── Enable ANSI (Win10 1511+) ─────────────────────────────────
reg add "HKCU\Console" /v VirtualTerminalLevel /t REG_DWORD /d 1 /f >nul 2>&1

:: ── Build ESC character via a macro ──────────────────────────
:: We write a tiny helper and capture its output so we get a
:: real ESC (0x1B) byte that cmd.exe will pass through.
for /f %%a in ('echo prompt $E ^| cmd /q') do set "ESC=%%a"

:: ── Colour shortcuts (use !ESC! at runtime) ───────────────────
set "R=!ESC![0m"
set "B=!ESC![1m"
set "DM=!ESC![2m"

set "RED=!ESC![31m"  & set "GRN=!ESC![32m"  & set "YLW=!ESC![33m"
set "BLU=!ESC![34m"  & set "MAG=!ESC![35m"  & set "CYN=!ESC![36m"

set "BRED=!ESC![91m" & set "BGRN=!ESC![92m" & set "BYLW=!ESC![93m"
set "BBLU=!ESC![94m" & set "BMAG=!ESC![95m" & set "BCYN=!ESC![96m"
set "BWHT=!ESC![97m"

:: ── Defaults ──────────────────────────────────────────────────
set "CFG_SERVER_NAME=Volt"
set "CFG_SERVER_URL=http://localhost:3000"
set "CFG_PORT=3000"
set "CFG_MODE=mainline"
set "CFG_STORAGE=sqlite"
set "CFG_DB_HOST=localhost"
set "CFG_DB_PORT="
set "CFG_DB_NAME=voltchat"
set "CFG_DB_USER="
set "CFG_DB_PASS="
set "CFG_JWT_EXPIRY=7d"
set "CFG_JWT_SECRET="
set "CFG_ALLOW_REG=true"
set "CFG_OAUTH=true"
set "CFG_DISCOVERY=true"
set "CFG_VOICE=true"
set "CFG_E2E=true"
set "CFG_BOTS=true"
set "CFG_FED=false"
set "CFG_ADMIN_USER=admin"
set "CFG_ADMIN_PASS="
set "CFG_ADMIN_EMAIL="

:: ── Main flow ─────────────────────────────────────────────────
call :BOOT_ANIMATION
call :CHECK_DEPS       || goto :ABORT
call :INSTALL_DEPS     || goto :ABORT
call :RUN_WIZARD
call :CREATE_DIRS
call :WRITE_FILES
call :PRINT_SUMMARY
goto :EOF

:: ════════════════════════════════════════════════════════════
:BOOT_ANIMATION
cls
call :PRINT_LOGO_ANIMATED
call :CHARGING_BAR
exit /b 0

:: ── Logo rows ─────────────────────────────────────────────────
:PRINT_LOGO_ANIMATED
echo.
:: Row 1 — blue
call :TYPEROW "  !BBLU!" "%%++++++++++  ++++++++   ++     +++++++++  ++++++++  ++++++++  ++++++++"
echo !BBLU!  !!+++++++  ++++++++   ++     +++++++++  ++++++++  ++++++++  ++++++++!R!
:: We can't do true per-character animation in pure batch without
:: external tools, so we use a fast line-by-line reveal with a small delay
:: between each row — this gives a "drawing" effect that works cross-terminal.

set "L1=!BBLU!  ##  ## ##  ## ##  ## ##  ## ##  ## ##  ## ##  ## ##"
set "L2=!BBLU!  ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ##"
set "L3=!BCYN!  ##   ## ##   ## ##   ## ##   ## ##   ## ##   ## ##  ##"
set "L4=!BCYN!   ## ##   ## ##   ## ##   ## ##   ## ##   ##  ## ##"
set "L5=!BMAG!    ###    ###   ####### ##   ## ##   ## ####### #######"
set "L6=!BMAG!     #      #    #######  #####   #####  #######  ######"

:: Reveal each row with a brief pause (ping = ~100ms sleep)
cls
echo.
echo   !BBLU!-=[ VOLTAGE Setup ]=-!R!
echo.

:: Actual ASCII art rows
echo   !BBLU!+--+   +--+ +------+ +--+  +--------+ +-----+ +------+ +-------+!R!
ping -n 1 -w 80 127.0.0.1 >nul 2>&1
echo   !BBLU!+--+   +--+ +--+  +-+ +--+  +---+----+ +--+-+ +--+     +--+!R!
ping -n 1 -w 80 127.0.0.1 >nul 2>&1
echo   !BCYN!+--+   +--+ +--+  +--++--+     +--+   +-----+ +--+ +-+ +----+!R!
ping -n 1 -w 80 127.0.0.1 >nul 2>&1
echo    !BCYN!+-+--+-+  +--+  +--++--+     +--+   +--+--+ +--+  +--++--+!R!
ping -n 1 -w 80 127.0.0.1 >nul 2>&1
echo     !BMAG!+----+   +------+ +------+ +--+   +--+  +-+ +-+-----++-------+!R!
ping -n 1 -w 80 127.0.0.1 >nul 2>&1
echo      !BMAG!+--+     +-----+  +------+  +-+    +-+  +-+  +-----+ +------+!R!
ping -n 1 -w 200 127.0.0.1 >nul 2>&1

echo.
echo              !BYLW!^<^<  The Decentralized Chat Platform  ^>^>!R!
echo.
exit /b 0

:: ── Charging bar (grows on one line using ^<nul set /p) ───────
:CHARGING_BAR
echo.
echo   !DM!Charging the Volt...!R!
echo.
<nul set /p "=  !BBLU!["
for /L %%i in (1,1,50) do (
    <nul set /p "=!BBLU!#!R!"
    ping -n 1 -w 20 127.0.0.1 >nul 2>&1
)
echo !BBLU!]!R!
echo.
ping -n 1 -w 300 127.0.0.1 >nul 2>&1
exit /b 0

:: ════════════════════════════════════════════════════════════
:HLINE
echo   !DM!!CYN!------------------------------------------------------------!R!
exit /b 0

:SECTION
echo.
call :HLINE
echo              !B!!BWHT!%~1!R!
call :HLINE
echo.
exit /b 0

:: ════════════════════════════════════════════════════════════
:CHECK_DEPS
call :SECTION "Checking Dependencies"

where node >nul 2>&1
if errorlevel 1 (
    echo   !BRED!X!R!  node.exe not found
    echo     Install Node.js v18+ from https://nodejs.org
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version 2^>nul') do (
    echo   !BGRN!v!R!  !B!node!R! found  !DM!%%v!R!
)

:: Version check
for /f %%M in ('node -e "process.stdout.write(String(process.versions.node.split(\".\")[0]))" 2^>nul') do (
    if %%M LSS 18 (
        echo   !BRED!X!R!  Node.js %%M is too old ^(need v18+^)
        exit /b 1
    )
)

where npm >nul 2>&1
if errorlevel 1 (
    echo   !BRED!X!R!  npm not found
    exit /b 1
)
for /f "tokens=*" %%v in ('npm --version 2^>nul') do (
    echo   !BGRN!v!R!  !B!npm!R! found  !DM!v%%v!R!
)

where git >nul 2>&1
if errorlevel 1 (
    echo   !BYLW!?!R!  git not found !DM!(optional)!R!
) else (
    echo   !BGRN!v!R!  !B!git!R! found
)

echo.
echo   !BGRN!v!R!  All required dependencies satisfied
exit /b 0

:: ════════════════════════════════════════════════════════════
:INSTALL_DEPS
call :SECTION "Installing Node Packages"
echo   !BCYN!i!R!  Running npm install...
npm install --silent
if errorlevel 1 (
    echo   !BRED!X!R!  npm install failed
    exit /b 1
)
echo   !BGRN!v!R!  Packages installed
exit /b 0

:: ════════════════════════════════════════════════════════════
:RUN_WIZARD
call :SECTION "Configuration Wizard"
echo   !DM!Answer each question and press Enter to keep the default.!R!
echo.

:: ── Server identity ───────────────────────────────────────────
echo   !BBLU!>>!R!  !B!Server Identity!R!
echo.
set "_i="
set /p "_i=  !BCYN!?!R!  !B!Server name!R! !DM!(Volt)!R!: "
if not "!_i!"=="" set "CFG_SERVER_NAME=!_i!"

set "_i="
set /p "_i=  !BCYN!?!R!  !B!Public URL!R! !DM!(http://localhost:3000)!R!: "
if not "!_i!"=="" set "CFG_SERVER_URL=!_i!"

set "_i="
set /p "_i=  !BCYN!?!R!  !B!Port!R! !DM!(3000)!R!: "
if not "!_i!"=="" set "CFG_PORT=!_i!"

echo.
echo   !BCYN!?!R!  !B!Server mode!R!
echo     !DM!1)!R! mainline   ^(connect to the main Volt network^)
echo     !DM!2)!R! self-volt  ^(standalone / private^)
echo     !DM!3)!R! federated  ^(federate with other servers^)
echo.
set "_i=1"
set /p "_i=  !BCYN!>>!R! Enter number !DM![1-3]!R!: "
if "!_i!"=="2" set "CFG_MODE=self-volt"
if "!_i!"=="3" set "CFG_MODE=federated"

:: ── Storage ───────────────────────────────────────────────────
echo.
echo   !BBLU!>>!R!  !B!Storage Backend!R!
echo.
echo   !BCYN!?!R!  !B!Database engine!R!
echo     !DM!1)!R! json     ^(flat files — zero config^)
echo     !DM!2)!R! sqlite   ^(recommended — no DB server needed^)
echo     !DM!3)!R! postgres ^(PostgreSQL^)
echo     !DM!4)!R! mysql    ^(MySQL / MariaDB^)
echo.
set "_i=2"
set /p "_i=  !BCYN!>>!R! Enter number !DM![1-4]!R!: "
if "!_i!"=="1" set "CFG_STORAGE=json"
if "!_i!"=="2" set "CFG_STORAGE=sqlite"
if "!_i!"=="3" set "CFG_STORAGE=postgres"
if "!_i!"=="4" set "CFG_STORAGE=mysql"

if "!CFG_STORAGE!"=="postgres" goto :DB_PROMPT
if "!CFG_STORAGE!"=="mysql"    goto :DB_PROMPT
goto :AFTER_DB

:DB_PROMPT
echo.
set "_i=localhost"
set /p "_i=  !BCYN!?!R!  !B!DB host!R! !DM!(localhost)!R!: "
set "CFG_DB_HOST=!_i!"

if "!CFG_STORAGE!"=="postgres" ( set "_def=5432" ) else ( set "_def=3306" )
set "_i=!_def!"
set /p "_i=  !BCYN!?!R!  !B!DB port!R! !DM!(!_def!)!R!: "
set "CFG_DB_PORT=!_i!"

set "_i=voltchat"
set /p "_i=  !BCYN!?!R!  !B!DB name!R! !DM!(voltchat)!R!: "
set "CFG_DB_NAME=!_i!"

set "_i=volt"
set /p "_i=  !BCYN!?!R!  !B!DB user!R! !DM!(volt)!R!: "
set "CFG_DB_USER=!_i!"

set "_i="
set /p "_i=  !BMAG!*!R!  !B!DB password!R!: "
set "CFG_DB_PASS=!_i!"

:AFTER_DB

:: ── Auth ──────────────────────────────────────────────────────
echo.
echo   !BBLU!>>!R!  !B!Authentication!R!
echo.
set "_i=y"
set /p "_i=  !BCYN!?!R!  !B!Allow new user registration?!R! !DM![Y/n]!R!: "
if /i "!_i!"=="n"  set "CFG_ALLOW_REG=false"
if /i "!_i!"=="no" set "CFG_ALLOW_REG=false"

set "_i=y"
set /p "_i=  !BCYN!?!R!  !B!Enable OAuth / SSO login?!R! !DM![Y/n]!R!: "
if /i "!_i!"=="n"  set "CFG_OAUTH=false"
if /i "!_i!"=="no" set "CFG_OAUTH=false"

:: ── Security ──────────────────────────────────────────────────
echo.
echo   !BBLU!>>!R!  !B!Security!R!
echo.
echo   !BCYN!i!R!  Generating JWT secret...
for /f "tokens=*" %%s in ('node -e "process.stdout.write(require(\"crypto\").randomBytes(64).toString(\"hex\"))" 2^>nul') do (
    set "CFG_JWT_SECRET=%%s"
)
echo   !BGRN!v!R!  JWT secret generated

set "_i=7d"
set /p "_i=  !BCYN!?!R!  !B!Token expiry!R! !DM!(7d)!R!: "
if not "!_i!"=="" set "CFG_JWT_EXPIRY=!_i!"

:: ── Features ──────────────────────────────────────────────────
echo.
echo   !BBLU!>>!R!  !B!Features!R!
echo.

set "_i=y"
set /p "_i=  !BCYN!?!R!  !B!Enable server discovery?!R! !DM![Y/n]!R!: "
if /i "!_i!"=="n"  set "CFG_DISCOVERY=false"
if /i "!_i!"=="no" set "CFG_DISCOVERY=false"

set "_i=y"
set /p "_i=  !BCYN!?!R!  !B!Enable voice ^& video channels?!R! !DM![Y/n]!R!: "
if /i "!_i!"=="n"  set "CFG_VOICE=false"
if /i "!_i!"=="no" set "CFG_VOICE=false"

set "_i=y"
set /p "_i=  !BCYN!?!R!  !B!Enable end-to-end encryption?!R! !DM![Y/n]!R!: "
if /i "!_i!"=="n"  set "CFG_E2E=false"
if /i "!_i!"=="no" set "CFG_E2E=false"

set "_i=y"
set /p "_i=  !BCYN!?!R!  !B!Enable bot API?!R! !DM![Y/n]!R!: "
if /i "!_i!"=="n"  set "CFG_BOTS=false"
if /i "!_i!"=="no" set "CFG_BOTS=false"

set "_i=n"
set /p "_i=  !BCYN!?!R!  !B!Enable federation?!R! !DM![y/N]!R!: "
if /i "!_i!"=="y"   set "CFG_FED=true"
if /i "!_i!"=="yes" set "CFG_FED=true"

:: ── Admin account ─────────────────────────────────────────────
echo.
echo   !BBLU!>>!R!  !B!Initial Admin Account!R!
echo.
set "_i=admin"
set /p "_i=  !BCYN!?!R!  !B!Admin username!R! !DM!(admin)!R!: "
if not "!_i!"=="" set "CFG_ADMIN_USER=!_i!"

set "_i="
set /p "_i=  !BMAG!*!R!  !B!Admin password!R!: "
set "CFG_ADMIN_PASS=!_i!"

set "_i="
set /p "_i=  !BCYN!?!R!  !B!Admin e-mail!R! !DM!(optional)!R!: "
set "CFG_ADMIN_EMAIL=!_i!"

exit /b 0

:: ════════════════════════════════════════════════════════════
:CREATE_DIRS
call :SECTION "Preparing Filesystem"
if not exist "data"    mkdir data    >nul 2>&1
if not exist "uploads" mkdir uploads >nul 2>&1
if not exist "logs"    mkdir logs    >nul 2>&1
echo   !BGRN!v!R!  Directories ready  !DM!(data\  uploads\  logs\)!R!
exit /b 0

:: ════════════════════════════════════════════════════════════
:WRITE_FILES
call :SECTION "Writing Configuration"
echo   !BCYN!i!R!  Writing .env...
(
echo # Voltage ^— generated by setup.bat
echo.
echo PORT=!CFG_PORT!
echo NODE_ENV=production
echo SERVER_NAME=!CFG_SERVER_NAME!
echo SERVER_URL=!CFG_SERVER_URL!
echo SERVER_MODE=!CFG_MODE!
echo JWT_SECRET=!CFG_JWT_SECRET!
echo JWT_EXPIRY=!CFG_JWT_EXPIRY!
echo BCRYPT_ROUNDS=12
echo STORAGE_TYPE=!CFG_STORAGE!
echo DB_HOST=!CFG_DB_HOST!
echo DB_PORT=!CFG_DB_PORT!
echo DB_NAME=!CFG_DB_NAME!
echo DB_USER=!CFG_DB_USER!
echo DB_PASS=!CFG_DB_PASS!
echo SQLITE_PATH=./data/voltage.db
echo ALLOW_REGISTRATION=!CFG_ALLOW_REG!
echo ENABLE_OAUTH=!CFG_OAUTH!
echo FEAT_DISCOVERY=!CFG_DISCOVERY!
echo FEAT_VOICE=!CFG_VOICE!
echo FEAT_E2E=!CFG_E2E!
echo FEAT_BOTS=!CFG_BOTS!
echo FEAT_FEDERATION=!CFG_FED!
echo ADMIN_USERNAME=!CFG_ADMIN_USER!
echo ADMIN_PASSWORD=!CFG_ADMIN_PASS!
echo ADMIN_EMAIL=!CFG_ADMIN_EMAIL!
) > .env
echo   !BGRN!v!R!  .env written

echo   !BCYN!i!R!  Writing config.json...
(
echo {
echo   "server": {
echo     "name": "!CFG_SERVER_NAME!",
echo     "version": "1.0.0",
echo     "mode": "!CFG_MODE!",
echo     "url": "!CFG_SERVER_URL!",
echo     "port": !CFG_PORT!
echo   },
echo   "storage": {
echo     "type": "!CFG_STORAGE!",
echo     "sqlite": { "dbPath": "./data/voltage.db" },
echo     "postgres": { "host": "!CFG_DB_HOST!", "port": !CFG_DB_PORT:~0,4!, "database": "!CFG_DB_NAME!", "user": "!CFG_DB_USER!", "password": "!CFG_DB_PASS!" },
echo     "mysql":    { "host": "!CFG_DB_HOST!", "port": !CFG_DB_PORT:~0,4!, "database": "!CFG_DB_NAME!", "user": "!CFG_DB_USER!", "password": "!CFG_DB_PASS!" }
echo   },
echo   "auth": {
echo     "type": "all",
echo     "local": { "enabled": true, "allowRegistration": !CFG_ALLOW_REG! },
echo     "oauth": { "enabled": !CFG_OAUTH!, "provider": "enclica" }
echo   },
echo   "security": {
echo     "jwtSecret": "!CFG_JWT_SECRET!",
echo     "jwtExpiry": "!CFG_JWT_EXPIRY!",
echo     "bcryptRounds": 12,
echo     "rateLimit": { "windowMs": 60000, "maxRequests": 100 },
echo     "adminUsers": ["!CFG_ADMIN_USER!"]
echo   },
echo   "features": {
echo     "discovery": !CFG_DISCOVERY!, "selfVolt": true,
echo     "voiceChannels": !CFG_VOICE!, "videoChannels": !CFG_VOICE!,
echo     "e2eEncryption": !CFG_E2E!, "e2eTrueEncryption": !CFG_E2E!,
echo     "communities": true, "bots": !CFG_BOTS!, "federation": !CFG_FED!
echo   },
echo   "limits": { "maxUploadSize": 10485760, "maxServersPerUser": 100, "maxMessageLength": 4000 },
echo   "cdn": { "enabled": false, "provider": "local", "local": { "uploadDir": "./uploads", "baseUrl": null } },
echo   "federation": { "enabled": !CFG_FED!, "serverName": null, "maxHops": 3 }
echo }
) > config.json
echo   !BGRN!v!R!  config.json written
exit /b 0

:: ════════════════════════════════════════════════════════════
:PRINT_SUMMARY
call :SECTION "Setup Complete"
echo.
echo   !BBLU!!B!  ^<^< Voltage is ready to run! ^>^>  !R!
echo.
echo   !DM!+-----------------------------------------------+!R!
echo   !DM!^|!R!  Server:   !CFG_SERVER_NAME!
echo   !DM!^|!R!  URL:      !CFG_SERVER_URL!
echo   !DM!^|!R!  Mode:     !CFG_MODE!
echo   !DM!^|!R!  Storage:  !CFG_STORAGE!
echo   !DM!^|!R!  Admin:    @!CFG_ADMIN_USER!
echo   !DM!+-----------------------------------------------+!R!
echo.
echo   !BYLW!To start Voltage:!R!
echo.
echo     !BGRN!^>!R!  !B!npm start!R!        !DM!# production!R!
echo     !BGRN!^>!R!  !B!npm run dev!R!      !DM!# development ^(auto-reload^)!R!
echo.
call :HLINE
echo            !DM!Thank you for running Voltage ^^!R!
call :HLINE
echo.
pause
exit /b 0

:: ════════════════════════════════════════════════════════════
:ABORT
echo.
echo   !BRED!X!R!  Setup failed. Fix the errors above and re-run.
echo.
pause
exit /b 1
