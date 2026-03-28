#!/usr/bin/env bash
# =============================================================================
# Callsheet — Interactive Setup
#
# A production-quality setup script that walks you through everything:
#   - System dependencies (Node.js, CUPS)
#   - Configuration (config.yaml, .env)
#   - Connector setup (API keys, OAuth flows)
#   - Printer discovery and configuration
#   - Scheduling (cron)
#
# Usage:
#   bash setup.sh              # Full interactive setup
#   bash setup.sh --headless   # Non-interactive (uses defaults, skips prompts)
#   bash setup.sh --skip-deps  # Skip system dependency installation
#   bash setup.sh --skip-print # Skip printer setup
#
# Requirements:
#   - bash 4+ (macOS ships bash 3 — the script handles this via zsh fallback)
#   - Internet connection (for npm install, nvm, API validation)
# =============================================================================
set -euo pipefail

# =============================================================================
# Constants
# =============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$SCRIPT_DIR"
LOG_FILE="$INSTALL_DIR/setup.log"
MIN_NODE_VERSION="20"
RECOMMENDED_NODE_VERSION="22"
NVM_VERSION="0.40.1"
CONFIG_FILE="$INSTALL_DIR/config.yaml"
ENV_FILE="$INSTALL_DIR/.env"
SECRETS_DIR="$INSTALL_DIR/secrets"

# =============================================================================
# Flags
# =============================================================================
HEADLESS=false
SKIP_DEPS=false
SKIP_PRINT=false

for arg in "$@"; do
  case "$arg" in
    --headless)   HEADLESS=true ;;
    --skip-deps)  SKIP_DEPS=true ;;
    --skip-print) SKIP_PRINT=true ;;
    --help|-h)
      echo "Usage: bash setup.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --headless    Non-interactive mode (uses defaults, skips prompts)"
      echo "  --skip-deps   Skip system dependency installation"
      echo "  --skip-print  Skip printer setup"
      echo "  -h, --help    Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (use --help for usage)"
      exit 1
      ;;
  esac
done

# =============================================================================
# Logging
# =============================================================================
: > "$LOG_FILE"  # Truncate log file
exec > >(tee -a "$LOG_FILE") 2>&1

# Colors (disabled if not a terminal)
if [[ -t 1 ]]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  BLUE='\033[0;34m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  DIM='\033[2m'
  RESET='\033[0m'
else
  RED='' GREEN='' YELLOW='' BLUE='' CYAN='' BOLD='' DIM='' RESET=''
fi

log()     { echo -e "[$(date '+%H:%M:%S')] $*"; }
step()    { echo ""; echo -e "${BOLD}${BLUE}━━━ $* ━━━${RESET}"; }
substep() { echo -e "  ${CYAN}▸${RESET} $*"; }
ok()      { echo -e "  ${GREEN}✓${RESET} $*"; }
warn()    { echo -e "  ${YELLOW}⚠${RESET} $*"; }
fail()    { echo -e "  ${RED}✗${RESET} $*"; }
info()    { echo -e "  ${DIM}$*${RESET}"; }
divider() { echo -e "${DIM}$(printf '%.0s─' {1..60})${RESET}"; }

die() {
  fail "$1"
  echo ""
  log "Setup failed. Full log: $LOG_FILE"
  exit 1
}

# =============================================================================
# Helpers
# =============================================================================
ask() {
  # ask "prompt" "default" -> sets REPLY
  local prompt="$1"
  local default="${2:-}"
  if $HEADLESS; then
    REPLY="$default"
    return
  fi
  if [[ -n "$default" ]]; then
    read -rp "  $prompt [$default]: " REPLY
    REPLY="${REPLY:-$default}"
  else
    read -rp "  $prompt: " REPLY
  fi
}

ask_yn() {
  # ask_yn "prompt" "Y" -> returns 0 for yes, 1 for no
  local prompt="$1"
  local default="${2:-Y}"
  if $HEADLESS; then
    [[ "$default" =~ ^[Yy] ]] && return 0 || return 1
  fi
  local hint="Y/n"
  [[ "$default" =~ ^[Nn] ]] && hint="y/N"
  read -rp "  $prompt [$hint]: " REPLY
  REPLY="${REPLY:-$default}"
  [[ "$REPLY" =~ ^[Yy] ]]
}

ask_secret() {
  # ask_secret "prompt" -> sets REPLY (no echo)
  local prompt="$1"
  if $HEADLESS; then
    REPLY=""
    return
  fi
  read -rsp "  $prompt: " REPLY
  echo ""
}

command_exists() { command -v "$1" &>/dev/null; }

version_gte() {
  # version_gte "20.11.0" "20" -> true if first >= second (major only)
  local major
  major=$(echo "$1" | cut -d. -f1)
  [[ "$major" -ge "$2" ]]
}

detect_platform() {
  case "$(uname -s)" in
    Linux*)  PLATFORM="linux" ;;
    Darwin*) PLATFORM="macos" ;;
    *)       PLATFORM="unknown" ;;
  esac

  if [[ "$PLATFORM" == "linux" ]]; then
    if command_exists apt-get; then
      PKG_MANAGER="apt"
    elif command_exists dnf; then
      PKG_MANAGER="dnf"
    elif command_exists pacman; then
      PKG_MANAGER="pacman"
    else
      PKG_MANAGER="unknown"
    fi
  elif [[ "$PLATFORM" == "macos" ]]; then
    PKG_MANAGER="brew"
  fi
}

write_yaml_line() {
  # Append a line to a file (used for building config.yaml)
  echo "$1" >> "$CONFIG_FILE"
}

# =============================================================================
# Banner
# =============================================================================
echo ""
echo -e "${BOLD}  ╔═══════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}  ║           Callsheet Setup                 ║${RESET}"
echo -e "${BOLD}  ║   AI-powered daily household briefing     ║${RESET}"
echo -e "${BOLD}  ╚═══════════════════════════════════════════╝${RESET}"
echo ""
info "Log file: $LOG_FILE"
echo ""

detect_platform
ok "Platform: $PLATFORM ($PKG_MANAGER)"

# =============================================================================
# Phase 1: System Dependencies
# =============================================================================
step "Phase 1: System Dependencies"

if $SKIP_DEPS; then
  info "Skipping (--skip-deps)"
else

  # --- Node.js ---
  substep "Checking Node.js..."

  if command_exists node; then
    NODE_VER="$(node --version | sed 's/^v//')"
    if version_gte "$NODE_VER" "$MIN_NODE_VERSION"; then
      ok "Node.js $NODE_VER (meets minimum v$MIN_NODE_VERSION)"
    else
      warn "Node.js $NODE_VER is below minimum v$MIN_NODE_VERSION"
      if ask_yn "Install Node.js v$RECOMMENDED_NODE_VERSION via nvm?"; then
        substep "Installing nvm + Node.js..."
        export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
        if [[ ! -d "$NVM_DIR" ]]; then
          curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/v${NVM_VERSION}/install.sh" | bash 2>&1
        fi
        # shellcheck source=/dev/null
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
        nvm install "$RECOMMENDED_NODE_VERSION" 2>&1
        nvm use "$RECOMMENDED_NODE_VERSION" 2>&1
        nvm alias default "$RECOMMENDED_NODE_VERSION" 2>&1
        ok "Node.js $(node --version) installed via nvm"
      fi
    fi
  else
    warn "Node.js not found"
    if ask_yn "Install Node.js v$RECOMMENDED_NODE_VERSION via nvm?"; then
      substep "Installing nvm..."
      export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
      curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/v${NVM_VERSION}/install.sh" | bash 2>&1
      # shellcheck source=/dev/null
      [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
      substep "Installing Node.js $RECOMMENDED_NODE_VERSION..."
      nvm install "$RECOMMENDED_NODE_VERSION" 2>&1
      nvm use "$RECOMMENDED_NODE_VERSION" 2>&1
      nvm alias default "$RECOMMENDED_NODE_VERSION" 2>&1
      ok "Node.js $(node --version) installed"
    else
      die "Node.js $MIN_NODE_VERSION+ is required. Install it and re-run setup."
    fi
  fi

  # --- yarn ---
  if command_exists yarn; then
    ok "yarn $(yarn --version)"
  else
    substep "Installing Yarn via corepack..."
    corepack enable 2>/dev/null || npm install -g corepack
    ok "yarn $(yarn --version)"
  fi

  # --- CUPS (printing, optional) ---
  if ! $SKIP_PRINT; then
    substep "Checking CUPS (printing support)..."
    if command_exists lp; then
      ok "CUPS available (lp: $(which lp))"
    else
      if [[ "$PLATFORM" == "macos" ]]; then
        ok "macOS has built-in CUPS support"
      elif [[ "$PLATFORM" == "linux" ]]; then
        if ask_yn "Install CUPS for printing support?"; then
          case "$PKG_MANAGER" in
            apt)
              sudo apt-get update -qq 2>&1 | tail -1
              sudo apt-get install -y cups cups-client 2>&1 | tail -3
              sudo systemctl enable --now cups 2>&1 || true
              ;;
            dnf)
              sudo dnf install -y cups 2>&1 | tail -3
              sudo systemctl enable --now cups 2>&1 || true
              ;;
            pacman)
              sudo pacman -S --noconfirm cups 2>&1 | tail -3
              sudo systemctl enable --now cups 2>&1 || true
              ;;
            *)
              warn "Unknown package manager — install CUPS manually"
              ;;
          esac
          # Add user to lpadmin group for printer management
          if getent group lpadmin &>/dev/null; then
            sudo usermod -aG lpadmin "$(whoami)" 2>/dev/null || true
            info "Added $(whoami) to lpadmin group (may need re-login)"
          fi
          ok "CUPS installed"
        else
          info "Skipping CUPS — you can use --preview mode without a printer"
        fi
      fi
    fi
  fi

  # --- Build tools (Linux only, for native npm packages) ---
  if [[ "$PLATFORM" == "linux" ]]; then
    substep "Checking build tools..."
    if command_exists gcc && command_exists make; then
      ok "Build tools available"
    else
      if ask_yn "Install build-essential (needed for some npm packages)?"; then
        case "$PKG_MANAGER" in
          apt)    sudo apt-get install -y build-essential 2>&1 | tail -3 ;;
          dnf)    sudo dnf groupinstall -y "Development Tools" 2>&1 | tail -3 ;;
          pacman) sudo pacman -S --noconfirm base-devel 2>&1 | tail -3 ;;
        esac
        ok "Build tools installed"
      fi
    fi
  fi
fi

# =============================================================================
# Phase 2: yarn install
# =============================================================================
step "Phase 2: Installing Dependencies"

cd "$INSTALL_DIR"

if [[ -d "node_modules" ]]; then
  substep "node_modules exists — running yarn install to sync..."
else
  substep "Running yarn install..."
fi

yarn install 2>&1 | tail -5
ok "Dependencies installed ($(ls node_modules 2>/dev/null | wc -l | xargs) packages)"

# =============================================================================
# Phase 3: Environment Variables (.env)
# =============================================================================
step "Phase 3: API Keys & Secrets (.env)"

if [[ -f "$ENV_FILE" ]]; then
  info "Found existing .env file"
  # Source it to check what's set
  set +u
  # shellcheck source=/dev/null
  source "$ENV_FILE" 2>/dev/null || true
  set -u

  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    MASKED="${ANTHROPIC_API_KEY:0:10}...${ANTHROPIC_API_KEY: -4}"
    ok "Anthropic API key: $MASKED"
  else
    warn "ANTHROPIC_API_KEY is empty in .env"
  fi
else
  info "No .env file found — creating from template"
  cp "$INSTALL_DIR/.env.example" "$ENV_FILE" 2>/dev/null || true
fi

# Ensure .env exists
if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" << 'ENVEOF'
# Required
ANTHROPIC_API_KEY=

# Todoist API tokens — one per person
# Get from: Todoist → Settings → Integrations → Developer
TODOIST_TOKEN_1=
TODOIST_TOKEN_2=

# Optional
# HA_TOKEN=                    # Home Assistant long-lived access token
# ACTUAL_BUDGET_PASSWORD=      # Actual Budget server password
ENVEOF
fi

# Re-source to get current values
set +u
# shellcheck source=/dev/null
source "$ENV_FILE" 2>/dev/null || true
set -u

# Prompt for Anthropic API key if missing
if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo ""
  info "You need an Anthropic API key to generate briefs."
  info "Get one at: https://console.anthropic.com/settings/keys"
  echo ""
  ask_secret "Paste your Anthropic API key (sk-ant-...)"
  if [[ -n "$REPLY" ]]; then
    # Update or add the key in .env
    if grep -q '^ANTHROPIC_API_KEY=' "$ENV_FILE" 2>/dev/null; then
      sed -i.bak "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=$REPLY|" "$ENV_FILE"
      rm -f "$ENV_FILE.bak"
    else
      echo "ANTHROPIC_API_KEY=$REPLY" >> "$ENV_FILE"
    fi
    ok "API key saved to .env"
  else
    warn "No API key entered — you'll need to add it to .env before generating briefs"
  fi
fi

# =============================================================================
# Phase 4: Configuration (config.yaml)
# =============================================================================
step "Phase 4: Configuration"

if [[ -f "$CONFIG_FILE" ]]; then
  info "Found existing config.yaml"
  if ask_yn "Reconfigure from scratch?" "N"; then
    cp "$CONFIG_FILE" "$CONFIG_FILE.backup.$(date +%s)"
    info "Backed up to config.yaml.backup.*"
  else
    ok "Keeping existing config.yaml"
    SKIP_CONFIG=true
  fi
fi

if [[ "${SKIP_CONFIG:-}" != "true" ]]; then
  substep "Building config.yaml..."
  echo ""

  # --- Model selection ---
  info "Claude model for brief generation:"
  info "  1) Sonnet — fast, cheap (~\$0.02-0.04/day) [recommended to start]"
  info "  2) Opus  — deeper analysis (~\$0.15-0.20/day)"
  ask "Choose model (1 or 2)" "1"
  case "$REPLY" in
    2) MODEL="claude-opus-4-6" ;;
    *) MODEL="claude-sonnet-4-20250514" ;;
  esac
  ok "Model: $MODEL"

  # --- Printer ---
  PRINTER_NAME=""
  if ! $SKIP_PRINT; then
    echo ""
    info "Printer setup (leave empty for preview-only mode):"
    if command_exists lpstat; then
      AVAILABLE_PRINTERS=$(lpstat -p 2>/dev/null | awk '{print $2}' || true)
      if [[ -n "$AVAILABLE_PRINTERS" ]]; then
        info "Detected printers:"
        echo "$AVAILABLE_PRINTERS" | while read -r p; do echo "    - $p"; done
        DEFAULT_PRINTER=$(lpstat -d 2>/dev/null | awk -F': ' '{print $2}' || true)
        ask "Printer name" "${DEFAULT_PRINTER:-}"
        PRINTER_NAME="$REPLY"
      else
        ask "Printer name (or empty to skip)" ""
        PRINTER_NAME="$REPLY"
      fi
    else
      ask "CUPS printer name (or empty for preview-only)" ""
      PRINTER_NAME="$REPLY"
    fi
    if [[ -n "$PRINTER_NAME" ]]; then
      ok "Printer: $PRINTER_NAME"
    else
      info "No printer — use 'yarn preview' to generate PDFs without printing"
    fi
  fi

  # --- Output dir ---
  OUTPUT_DIR="output"

  # --- Household context ---
  echo ""
  substep "Household context (helps Claude personalize your brief)"
  info "The more you share, the better Claude connects dots across your data."
  echo ""
  ask "Who lives in your household? (e.g., 'Alex and Jordan')" ""
  CONTEXT_PEOPLE="$REPLY"

  CONTEXT_LINES=""
  if [[ -n "$CONTEXT_PEOPLE" ]]; then
    CONTEXT_LINES="  people: \"$CONTEXT_PEOPLE\""

    ask "Work/schedule info? (e.g., 'Alex is a nurse, 3x12hr shifts')" ""
    [[ -n "$REPLY" ]] && CONTEXT_LINES="$CONTEXT_LINES
  work: \"$REPLY\""

    ask "Health/accessibility? (e.g., 'Jordan has ADHD — keep it scannable')" ""
    [[ -n "$REPLY" ]] && CONTEXT_LINES="$CONTEXT_LINES
  health: \"$REPLY\""

    ask "Upcoming travel? (e.g., 'Japan trip June 1-14, 2026')" ""
    [[ -n "$REPLY" ]] && CONTEXT_LINES="$CONTEXT_LINES
  travel: \"$REPLY\""

    ask "Key deadlines? (e.g., 'Thesis due April 30')" ""
    [[ -n "$REPLY" ]] && CONTEXT_LINES="$CONTEXT_LINES
  key_deadlines: \"$REPLY\""

    ask "Anything else Claude should know?" ""
    [[ -n "$REPLY" ]] && CONTEXT_LINES="$CONTEXT_LINES
  notes: \"$REPLY\""
  fi

  # =========================================================================
  # Build config.yaml
  # =========================================================================
  cat > "$CONFIG_FILE" << CFGEOF
# Callsheet configuration
# Generated by setup.sh on $(date '+%Y-%m-%d %H:%M:%S')

# Claude model for brief generation
model: $MODEL

# CUPS printer name. Leave empty for --preview only.
printer: "$PRINTER_NAME"

# Where to save generated PDFs and JSON files
output_dir: $OUTPUT_DIR

# Directory for Google OAuth credentials/tokens
credentials_dir: secrets

# ---------------------------------------------------------------------------
# Connectors — data sources for your daily brief
# ---------------------------------------------------------------------------
connectors:
CFGEOF

  # ==========================================================================
  # Connector wizard
  # ==========================================================================
  echo ""
  substep "Connector setup"
  info "Connectors pull data from your accounts into the daily brief."
  info "You can enable more later by editing config.yaml."
  echo ""

  # --- Weather ---
  divider
  substep "Weather (NWS — free, no API key, US only)"
  if ask_yn "Enable weather?"; then
    ask "City/state label (e.g., 'Denver, CO')" ""
    WEATHER_LOCATION="$REPLY"
    ask "Latitude (e.g., 39.7392)" ""
    WEATHER_LAT="$REPLY"
    ask "Longitude (e.g., -104.9903)" ""
    WEATHER_LON="$REPLY"
    cat >> "$CONFIG_FILE" << CFGEOF

  weather:
    enabled: true
    location: "$WEATHER_LOCATION"
    lat: $WEATHER_LAT
    lon: $WEATHER_LON
CFGEOF
    ok "Weather enabled"
  else
    cat >> "$CONFIG_FILE" << 'CFGEOF'

  weather:
    enabled: false
    location: "Your City, ST"
    lat: 0.0
    lon: 0.0
CFGEOF
    info "Weather disabled"
  fi

  # --- Todoist ---
  divider
  substep "Todoist (task management)"
  if ask_yn "Enable Todoist?"; then
    info "Get your API token from: Todoist → Settings → Integrations → Developer"
    TODOIST_ACCOUNTS=""
    ACCOUNT_NUM=1
    while true; do
      echo ""
      ask "Person $ACCOUNT_NUM name (e.g., 'Alex')" ""
      ACCT_NAME="$REPLY"
      [[ -z "$ACCT_NAME" ]] && break

      TOKEN_ENV="TODOIST_TOKEN_$ACCOUNT_NUM"
      ask_secret "Paste $ACCT_NAME's Todoist API token (or Enter to skip)"
      if [[ -n "$REPLY" ]]; then
        # Add to .env
        if grep -q "^${TOKEN_ENV}=" "$ENV_FILE" 2>/dev/null; then
          sed -i.bak "s|^${TOKEN_ENV}=.*|${TOKEN_ENV}=$REPLY|" "$ENV_FILE"
          rm -f "$ENV_FILE.bak"
        else
          echo "${TOKEN_ENV}=$REPLY" >> "$ENV_FILE"
        fi
        ok "Token saved as $TOKEN_ENV in .env"
      else
        warn "No token entered — add $TOKEN_ENV to .env later"
      fi

      TODOIST_ACCOUNTS="${TODOIST_ACCOUNTS}
      - name: $ACCT_NAME
        token_env: $TOKEN_ENV"

      if ! ask_yn "Add another Todoist account?" "N"; then
        break
      fi
      ACCOUNT_NUM=$((ACCOUNT_NUM + 1))
    done

    if [[ -n "$TODOIST_ACCOUNTS" ]]; then
      cat >> "$CONFIG_FILE" << CFGEOF

  todoist:
    enabled: true
    accounts:$TODOIST_ACCOUNTS
CFGEOF
      ok "Todoist enabled"
    else
      cat >> "$CONFIG_FILE" << 'CFGEOF'

  todoist:
    enabled: false
    accounts:
      - name: Person 1
        token_env: TODOIST_TOKEN_1
CFGEOF
      info "Todoist disabled (no accounts configured)"
    fi
  else
    cat >> "$CONFIG_FILE" << 'CFGEOF'

  todoist:
    enabled: false
    accounts:
      - name: Person 1
        token_env: TODOIST_TOKEN_1
CFGEOF
    info "Todoist disabled"
  fi

  # --- Google Calendar ---
  divider
  substep "Google Calendar (OAuth — requires Google Cloud project)"
  info "Requires a credentials.json from Google Cloud Console."
  info "See docs/SETUP_GUIDE.md for step-by-step instructions."
  if ask_yn "Enable Google Calendar?"; then
    GCAL_ACCOUNTS=""
    ACCOUNT_NUM=1
    CREDS_FILE="credentials.json"

    # Check for existing credentials
    mkdir -p "$SECRETS_DIR"
    if [[ -f "$SECRETS_DIR/credentials.json" ]]; then
      ok "Found secrets/credentials.json"
    else
      echo ""
      info "You need to create OAuth credentials in Google Cloud Console:"
      info "  1. Go to console.cloud.google.com"
      info "  2. Create a project (or use existing)"
      info "  3. Enable 'Google Calendar API'"
      info "  4. Create OAuth Client ID (Desktop app)"
      info "  5. Download JSON → save as secrets/credentials.json"
      echo ""
      ask "Path to your downloaded credentials JSON (or Enter to skip)" ""
      if [[ -n "$REPLY" && -f "$REPLY" ]]; then
        cp "$REPLY" "$SECRETS_DIR/credentials.json"
        ok "Copied to secrets/credentials.json"
      else
        warn "No credentials file — you'll need to add secrets/credentials.json before auth"
      fi
    fi

    while true; do
      echo ""
      ask "Person $ACCOUNT_NUM name" ""
      ACCT_NAME="$REPLY"
      [[ -z "$ACCT_NAME" ]] && break

      ask "Credentials file for $ACCT_NAME" "credentials.json"
      ACCT_CREDS="$REPLY"

      ask "Calendar IDs (comma-separated, or 'primary')" "primary"
      IFS=',' read -ra CAL_IDS <<< "$REPLY"
      CAL_YAML=""
      for cid in "${CAL_IDS[@]}"; do
        cid="$(echo "$cid" | xargs)"  # trim whitespace
        CAL_YAML="${CAL_YAML}
          - $cid"
      done

      GCAL_ACCOUNTS="${GCAL_ACCOUNTS}
      - name: $ACCT_NAME
        credentials_file: $ACCT_CREDS
        calendar_ids:$CAL_YAML"

      if ! ask_yn "Add another Google Calendar account?" "N"; then
        break
      fi
      ACCOUNT_NUM=$((ACCOUNT_NUM + 1))
    done

    if [[ -n "$GCAL_ACCOUNTS" ]]; then
      cat >> "$CONFIG_FILE" << CFGEOF

  google_calendar:
    enabled: true
    credentials_dir: secrets
    lookahead_days: 7
    accounts:$GCAL_ACCOUNTS
CFGEOF
      ok "Google Calendar enabled"
    else
      cat >> "$CONFIG_FILE" << 'CFGEOF'

  google_calendar:
    enabled: false
    credentials_dir: secrets
    lookahead_days: 7
    accounts:
      - name: Person 1
        credentials_file: credentials.json
        calendar_ids:
          - primary
CFGEOF
    fi
  else
    cat >> "$CONFIG_FILE" << 'CFGEOF'

  google_calendar:
    enabled: false
    credentials_dir: secrets
    lookahead_days: 7
    accounts:
      - name: Person 1
        credentials_file: credentials.json
        calendar_ids:
          - primary
CFGEOF
    info "Google Calendar disabled"
  fi

  # --- Gmail ---
  divider
  substep "Gmail (OAuth — uses same Google Cloud project as Calendar)"
  if ask_yn "Enable Gmail?" "N"; then
    info "Uses the same secrets/credentials.json as Google Calendar."
    ask "Gmail search query" "newer_than:2d -category:promotions -category:social"
    GMAIL_QUERY="$REPLY"
    ask "Max messages to fetch" "25"
    GMAIL_MAX="$REPLY"

    cat >> "$CONFIG_FILE" << CFGEOF

  gmail:
    enabled: true
    credentials_dir: secrets
    query: "$GMAIL_QUERY"
    max_messages: $GMAIL_MAX
CFGEOF
    ok "Gmail enabled"
  else
    cat >> "$CONFIG_FILE" << 'CFGEOF'

  gmail:
    enabled: false
    credentials_dir: secrets
    query: "newer_than:2d -category:promotions -category:social"
    max_messages: 25
CFGEOF
    info "Gmail disabled"
  fi

  # --- Market ---
  divider
  substep "Market data (free, no API key)"
  if ask_yn "Enable market data?" "N"; then
    ask "Ticker symbols (comma-separated, e.g., VTSAX,VTI,SPY)" "VTSAX"
    IFS=',' read -ra SYMBOLS <<< "$REPLY"
    SYMBOL_YAML=""
    for sym in "${SYMBOLS[@]}"; do
      sym="$(echo "$sym" | xargs)"
      SYMBOL_YAML="${SYMBOL_YAML}
      - $sym"
    done

    cat >> "$CONFIG_FILE" << CFGEOF

  market:
    enabled: true
    symbols:$SYMBOL_YAML
CFGEOF
    ok "Market enabled"
  else
    cat >> "$CONFIG_FILE" << 'CFGEOF'

  market:
    enabled: false
    symbols:
      - VTSAX
CFGEOF
    info "Market disabled"
  fi

  # --- Aviation Weather ---
  divider
  substep "Aviation weather (METAR/TAF — free, for pilots)"
  if ask_yn "Enable aviation weather?" "N"; then
    ask "ICAO station codes (comma-separated, e.g., KDEN,KBJC)" ""
    IFS=',' read -ra STATIONS <<< "$REPLY"
    STATION_YAML=""
    for st in "${STATIONS[@]}"; do
      st="$(echo "$st" | xargs)"
      STATION_YAML="${STATION_YAML}
      - $st"
    done

    cat >> "$CONFIG_FILE" << CFGEOF

  aviation_weather:
    enabled: true
    stations:$STATION_YAML
CFGEOF
    ok "Aviation weather enabled"
  else
    cat >> "$CONFIG_FILE" << 'CFGEOF'

  aviation_weather:
    enabled: false
    stations: []
CFGEOF
    info "Aviation weather disabled"
  fi

  # --- Home Assistant ---
  divider
  substep "Home Assistant (requires HA instance + token)"
  if ask_yn "Enable Home Assistant?" "N"; then
    ask "Home Assistant URL" "http://homeassistant.local:8123"
    HA_URL="$REPLY"
    ask "Token env var name" "HA_TOKEN"
    HA_TOKEN_ENV="$REPLY"
    ask_secret "Paste your HA long-lived access token (or Enter to skip)"
    if [[ -n "$REPLY" ]]; then
      if grep -q "^${HA_TOKEN_ENV}=" "$ENV_FILE" 2>/dev/null; then
        sed -i.bak "s|^${HA_TOKEN_ENV}=.*|${HA_TOKEN_ENV}=$REPLY|" "$ENV_FILE"
        rm -f "$ENV_FILE.bak"
      else
        echo "${HA_TOKEN_ENV}=$REPLY" >> "$ENV_FILE"
      fi
      ok "Token saved as $HA_TOKEN_ENV in .env"
    fi

    echo ""
    info "Entity filtering (empty = all sensors — can be a LOT of data):"
    ask "Specific entity IDs (comma-separated, or empty for all)" ""
    ENTITY_YAML=""
    if [[ -n "$REPLY" ]]; then
      IFS=',' read -ra ENTITIES <<< "$REPLY"
      for ent in "${ENTITIES[@]}"; do
        ent="$(echo "$ent" | xargs)"
        ENTITY_YAML="${ENTITY_YAML}
      - $ent"
      done
    fi

    cat >> "$CONFIG_FILE" << CFGEOF

  home_assistant:
    enabled: true
    url: $HA_URL
    token_env: $HA_TOKEN_ENV
    entities:${ENTITY_YAML:- []}
CFGEOF
    ok "Home Assistant enabled"
  else
    cat >> "$CONFIG_FILE" << 'CFGEOF'

  home_assistant:
    enabled: false
    url: http://homeassistant.local:8123
    token_env: HA_TOKEN
    entities: []
CFGEOF
    info "Home Assistant disabled"
  fi

  # --- Actual Budget ---
  divider
  substep "Actual Budget (self-hosted budget tracking)"
  if ask_yn "Enable Actual Budget?" "N"; then
    ask "Actual Budget server URL" "https://budget.example.com/budget"
    AB_URL="$REPLY"
    ask "Sync ID (Settings → Advanced → Sync ID)" ""
    AB_SYNC="$REPLY"
    ask "Password env var name" "ACTUAL_BUDGET_PASSWORD"
    AB_PASS_ENV="$REPLY"
    ask_secret "Server password (or Enter to skip)"
    if [[ -n "$REPLY" ]]; then
      if grep -q "^${AB_PASS_ENV}=" "$ENV_FILE" 2>/dev/null; then
        sed -i.bak "s|^${AB_PASS_ENV}=.*|${AB_PASS_ENV}=$REPLY|" "$ENV_FILE"
        rm -f "$ENV_FILE.bak"
      else
        echo "${AB_PASS_ENV}=$REPLY" >> "$ENV_FILE"
      fi
      ok "Password saved as $AB_PASS_ENV in .env"
    fi
    ask "Lookback days for transactions" "7"
    AB_LOOKBACK="$REPLY"

    if ask_yn "Do you use end-to-end encryption?" "N"; then
      ask "E2E password env var name" "ACTUAL_BUDGET_E2E_PASSWORD"
      AB_E2E_ENV="$REPLY"
      ask_secret "E2E password (or Enter to skip)"
      if [[ -n "$REPLY" ]]; then
        echo "${AB_E2E_ENV}=$REPLY" >> "$ENV_FILE"
        ok "E2E password saved"
      fi
      cat >> "$CONFIG_FILE" << CFGEOF

  actual_budget:
    enabled: true
    server_url: $AB_URL
    password_env: $AB_PASS_ENV
    sync_id: "$AB_SYNC"
    budget_password_env: $AB_E2E_ENV
    lookback_days: $AB_LOOKBACK
CFGEOF
    else
      cat >> "$CONFIG_FILE" << CFGEOF

  actual_budget:
    enabled: true
    server_url: $AB_URL
    password_env: $AB_PASS_ENV
    sync_id: "$AB_SYNC"
    lookback_days: $AB_LOOKBACK
CFGEOF
    fi
    ok "Actual Budget enabled"
  else
    cat >> "$CONFIG_FILE" << 'CFGEOF'

  actual_budget:
    enabled: false
    server_url: https://budget.example.com/budget
    password_env: ACTUAL_BUDGET_PASSWORD
    sync_id: "your-sync-id-here"
    lookback_days: 7
CFGEOF
    info "Actual Budget disabled"
  fi

  # --- Household context ---
  if [[ -n "${CONTEXT_LINES:-}" ]]; then
    cat >> "$CONFIG_FILE" << CFGEOF

# ---------------------------------------------------------------------------
# Household context — injected into Claude's prompt
# ---------------------------------------------------------------------------
context:
$CONTEXT_LINES
CFGEOF
  else
    cat >> "$CONFIG_FILE" << 'CFGEOF'

# ---------------------------------------------------------------------------
# Household context — injected into Claude's prompt
# The more specific, the better Claude connects dots across your data.
# ---------------------------------------------------------------------------
context:
  people: "Your names here"
  # work: "Software engineer, hybrid schedule"
  # health: "Partner has ADHD — keep brief scannable"
  # travel: "Japan trip June 1-14, 2026"
  # key_deadlines: "Thesis due April 30"
CFGEOF
  fi

  # --- Extras ---
  cat >> "$CONFIG_FILE" << 'CFGEOF'

# ---------------------------------------------------------------------------
# Extras — fun recurring items added to the Executive Brief
# ---------------------------------------------------------------------------
# extras:
#   - name: "Spanish Word of the Day"
#     instruction: >
#       Include a Spanish word or phrase as the last Executive Brief item.
#       Target A1-A2 level, practical and conversational.
#   - name: "Fun Fact"
#     instruction: >
#       Include a short, interesting fact related to today's date or events.
CFGEOF

  echo ""
  ok "config.yaml written"
fi

# =============================================================================
# Phase 5: OAuth Flows (Google Calendar / Gmail)
# =============================================================================
step "Phase 5: Authentication"

# Re-read config to check what's enabled
GCAL_ENABLED=$(grep -A1 'google_calendar:' "$CONFIG_FILE" 2>/dev/null | grep 'enabled: true' || true)
GMAIL_ENABLED=$(grep -A1 'gmail:' "$CONFIG_FILE" 2>/dev/null | grep 'enabled: true' || true)

RAN_AUTH=false

if [[ -n "$GCAL_ENABLED" ]]; then
  substep "Google Calendar OAuth"
  # Check for existing tokens
  EXISTING_TOKENS=$(find "$SECRETS_DIR" -name 'token_calendar*.json' 2>/dev/null | head -5 || true)
  if [[ -n "$EXISTING_TOKENS" ]]; then
    ok "Found existing calendar token(s)"
    echo "$EXISTING_TOKENS" | while read -r t; do info "  $(basename "$t")"; done
    if ask_yn "Re-authenticate?" "N"; then
      npx tsx src/cli.ts --auth google_calendar 2>&1
      RAN_AUTH=true
    fi
  elif [[ -f "$SECRETS_DIR/credentials.json" ]]; then
    if ask_yn "Run Google Calendar OAuth flow now?"; then
      npx tsx src/cli.ts --auth google_calendar 2>&1
      RAN_AUTH=true
    else
      warn "Run 'yarn auth:gcal' later to authenticate"
    fi
  else
    warn "No secrets/credentials.json — skipping OAuth"
    info "Add credentials.json then run: yarn auth:gcal"
  fi
fi

if [[ -n "$GMAIL_ENABLED" ]]; then
  substep "Gmail OAuth"
  EXISTING_TOKENS=$(find "$SECRETS_DIR" -name 'token_gmail*.json' 2>/dev/null | head -5 || true)
  if [[ -n "$EXISTING_TOKENS" ]]; then
    ok "Found existing Gmail token(s)"
    echo "$EXISTING_TOKENS" | while read -r t; do info "  $(basename "$t")"; done
    if ask_yn "Re-authenticate?" "N"; then
      npx tsx src/cli.ts --auth gmail 2>&1
      RAN_AUTH=true
    fi
  elif [[ -f "$SECRETS_DIR/credentials.json" ]]; then
    info "Make sure Gmail API is enabled in your Google Cloud project."
    if ask_yn "Run Gmail OAuth flow now?"; then
      npx tsx src/cli.ts --auth gmail 2>&1
      RAN_AUTH=true
    else
      warn "Run 'yarn auth:gmail' later to authenticate"
    fi
  else
    warn "No secrets/credentials.json — skipping OAuth"
    info "Add credentials.json then run: yarn auth:gmail"
  fi
fi

if [[ "$RAN_AUTH" == "false" ]] && [[ -z "$GCAL_ENABLED" ]] && [[ -z "$GMAIL_ENABLED" ]]; then
  info "No OAuth-based connectors enabled — nothing to authenticate"
fi

# =============================================================================
# Phase 6: Printer Setup
# =============================================================================
if ! $SKIP_PRINT; then
  step "Phase 6: Printer"

  # Read printer from config
  CFG_PRINTER=$(grep '^printer:' "$CONFIG_FILE" 2>/dev/null \
    | sed 's/^printer:[[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}/\1/' \
    | xargs) || true

  if [[ -z "$CFG_PRINTER" ]]; then
    info "No printer configured (preview-only mode)"
  elif command_exists lpstat; then
    if lpstat -p "$CFG_PRINTER" &>/dev/null; then
      ok "Printer '$CFG_PRINTER' is available in CUPS"
      info "Status: $(lpstat -p "$CFG_PRINTER" 2>/dev/null | head -1 || echo 'unknown')"
    else
      warn "Printer '$CFG_PRINTER' not found in CUPS"

      if [[ "$PLATFORM" == "linux" ]]; then
        info "Scanning for printers..."
        AVAILABLE=$(lpinfo -v 2>/dev/null | grep -v "^$" || true)
        if [[ -n "$AVAILABLE" ]]; then
          info "Available printer URIs:"
          echo "$AVAILABLE" | head -10 | while read -r line; do info "  $line"; done
          echo ""
          ask "Printer URI to add (or Enter to skip)" ""
          if [[ -n "$REPLY" ]]; then
            sudo lpadmin -p "$CFG_PRINTER" -E -v "$REPLY" -m everywhere 2>&1
            sudo lpoptions -d "$CFG_PRINTER" 2>&1
            ok "Printer '$CFG_PRINTER' added to CUPS"
          fi
        else
          warn "No printers discovered — check your network connection"
        fi
      else
        info "Add the printer via System Preferences → Printers & Scanners on macOS"
      fi
    fi
  else
    info "CUPS not available — printing won't work (preview mode is fine)"
  fi
else
  step "Phase 6: Printer (skipped)"
fi

# =============================================================================
# Phase 7: Verification
# =============================================================================
step "Phase 7: Verification"

ERRORS=0

# Config files
substep "Checking files..."
for f in config.yaml .env; do
  if [[ -f "$INSTALL_DIR/$f" ]]; then
    ok "$f"
  else
    fail "$f MISSING"
    ERRORS=$((ERRORS + 1))
  fi
done

# Secrets dir
if [[ -d "$SECRETS_DIR" ]]; then
  ok "secrets/ directory"
  CREDS_COUNT=$(find "$SECRETS_DIR" -name '*.json' 2>/dev/null | wc -l | xargs)
  info "  $CREDS_COUNT JSON file(s) in secrets/"
else
  info "secrets/ not created yet (needed for Google connectors)"
fi

# Node
substep "Checking runtime..."
if command_exists node; then
  ok "node $(node --version) at $(which node)"
else
  fail "node not in PATH"
  ERRORS=$((ERRORS + 1))
fi

# API key
set +u
# shellcheck source=/dev/null
source "$ENV_FILE" 2>/dev/null || true
set -u
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  ok "ANTHROPIC_API_KEY is set"
else
  warn "ANTHROPIC_API_KEY not set — add it to .env"
  ERRORS=$((ERRORS + 1))
fi

# Run connector tests
substep "Testing connectors..."
echo ""
if npx tsx src/cli.ts --test 2>&1; then
  ok "Connector tests passed"
else
  warn "Some connectors had issues (check output above)"
fi

# =============================================================================
# Phase 8: Scheduling (optional)
# =============================================================================
step "Phase 8: Scheduling"

if $HEADLESS; then
  info "Skipping scheduling in headless mode"
elif [[ "$PLATFORM" == "macos" ]]; then
  info "On macOS, you can schedule with cron or launchd."
  info "Example cron (runs at 6:30 AM daily):"
  echo ""
  info "  crontab -e"
  info "  30 6 * * * cd $INSTALL_DIR && /usr/local/bin/node dist/cli.js >> output/cron.log 2>&1"
  echo ""
  info "Or use 'yarn build' first, then schedule the built version."
  if ask_yn "Set up a cron job now?" "N"; then
    ask "What time? (HH:MM, 24h format)" "06:30"
    IFS=':' read -ra TIME_PARTS <<< "$REPLY"
    CRON_HOUR="${TIME_PARTS[0]}"
    CRON_MIN="${TIME_PARTS[1]}"

    # Build the cron command — handle nvm if needed
    NODE_PATH="$(which node)"
    if [[ "$NODE_PATH" == *".nvm"* ]]; then
      CRON_CMD="$CRON_MIN $CRON_HOUR * * * export NVM_DIR=\"\$HOME/.nvm\" && . \"\$NVM_DIR/nvm.sh\" && cd $INSTALL_DIR && git pull origin main --ff-only 2>/dev/null; yarn install --immutable 2>/dev/null; yarn print >> $INSTALL_DIR/output/cron.log 2>&1"
    else
      CRON_CMD="$CRON_MIN $CRON_HOUR * * * cd $INSTALL_DIR && git pull origin main --ff-only 2>/dev/null; yarn install --immutable 2>/dev/null; $NODE_PATH $(pwd)/dist/cli.js >> $INSTALL_DIR/output/cron.log 2>&1"
    fi

    if crontab -l 2>/dev/null | grep -qF "callsheet"; then
      info "Existing callsheet cron found:"
      crontab -l 2>/dev/null | grep "callsheet"
      if ask_yn "Replace it?"; then
        (crontab -l 2>/dev/null | grep -vF "callsheet"; echo "$CRON_CMD") | crontab -
        ok "Cron replaced"
      else
        info "Kept existing"
      fi
    else
      (crontab -l 2>/dev/null; echo "$CRON_CMD") | crontab -
      ok "Cron added: $CRON_HOUR:$CRON_MIN daily"
    fi
  fi
elif [[ "$PLATFORM" == "linux" ]]; then
  if ask_yn "Set up a daily cron job?"; then
    ask "What time? (HH:MM, 24h format)" "06:30"
    IFS=':' read -ra TIME_PARTS <<< "$REPLY"
    CRON_HOUR="${TIME_PARTS[0]}"
    CRON_MIN="${TIME_PARTS[1]}"

    NODE_PATH="$(which node)"
    if [[ "$NODE_PATH" == *".nvm"* ]]; then
      CRON_CMD="$CRON_MIN $CRON_HOUR * * * export NVM_DIR=\"\$HOME/.nvm\" && . \"\$NVM_DIR/nvm.sh\" && cd $INSTALL_DIR && git pull origin main --ff-only 2>/dev/null; yarn install --immutable 2>/dev/null; yarn print >> $INSTALL_DIR/output/cron.log 2>&1"
    else
      CRON_CMD="$CRON_MIN $CRON_HOUR * * * cd $INSTALL_DIR && git pull origin main --ff-only 2>/dev/null; yarn install --immutable 2>/dev/null; $NODE_PATH $(pwd)/dist/cli.js >> $INSTALL_DIR/output/cron.log 2>&1"
    fi

    if crontab -l 2>/dev/null | grep -qF "callsheet"; then
      info "Existing callsheet cron found:"
      crontab -l 2>/dev/null | grep "callsheet"
      if ask_yn "Replace it?"; then
        (crontab -l 2>/dev/null | grep -vF "callsheet"; echo "$CRON_CMD") | crontab -
        ok "Cron replaced"
      else
        info "Kept existing"
      fi
    else
      (crontab -l 2>/dev/null; echo "$CRON_CMD") | crontab -
      ok "Cron added: $CRON_HOUR:$CRON_MIN daily"
    fi
  fi
fi

# =============================================================================
# Summary
# =============================================================================
echo ""
echo -e "${BOLD}${GREEN}━━━ Setup Complete ━━━${RESET}"
echo ""
echo -e "  ${BOLD}Quick start:${RESET}"
echo "    yarn test              Test all enabled connectors"
echo "    yarn preview           Generate a PDF brief (no printing)"
echo "    yarn print             Generate + print"
echo ""
echo -e "  ${BOLD}Connector auth:${RESET}"
echo "    yarn auth:gcal         Google Calendar OAuth"
echo "    yarn auth:gmail        Gmail OAuth"
echo ""
echo -e "  ${BOLD}Debugging:${RESET}"
echo "    yarn data              See raw JSON payload Claude receives"
echo "    yarn test weather      Test a specific connector"
echo ""
echo -e "  ${BOLD}Files:${RESET}"
echo "    config.yaml            Main configuration"
echo "    .env                   API keys and secrets"
echo "    secrets/               Google OAuth tokens"
echo "    output/                Generated PDFs and briefs"
echo ""
if [[ $ERRORS -gt 0 ]]; then
  echo -e "  ${YELLOW}⚠ $ERRORS issue(s) found — check warnings above${RESET}"
else
  echo -e "  ${GREEN}✓ Everything looks good!${RESET}"
fi
echo ""
echo -e "  ${DIM}Full log: $LOG_FILE${RESET}"
echo ""
