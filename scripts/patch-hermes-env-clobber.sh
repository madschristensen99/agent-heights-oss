#!/bin/bash
# Patch Hermes Python files to prevent load_dotenv(override=True) from
# clobbering non-empty API key env vars with empty values from .env.
#
# Root cause: Hermes calls load_dotenv(override=True) before every inference
# call. If .env contains DEEPSEEK_API_KEY= (empty), this overwrites the valid
# key in os.environ with an empty string, causing "API key not found" errors.
#
# This script patches the installed Hermes files after pip install to
# backup known API key env vars before load_dotenv calls and restore them
# if .env clobbered them with empty values.
set -e

# The list of API key env vars to protect
API_KEYS='"DEEPSEEK_API_KEY", "KIMI_API_KEY", "KIMI_CODING_API_KEY",
            "KIMI_CN_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
            "OPENROUTER_API_KEY", "ZAI_API_KEY", "GLM_API_KEY",
            "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "XAI_API_KEY",
            "GEMINI_API_KEY", "GOOGLE_API_KEY", "MISTRAL_API_KEY",
            "NVIDIA_API_KEY", "DASHSCOPE_API_KEY", "STEPFUN_API_KEY",
            "TAVILY_API_KEY", "FAL_KEY", "HF_TOKEN", "GITHUB_TOKEN",
            "HERMES_INFERENCE_PROVIDER", "DEEPSEEK_BASE_URL", "GLM_BASE_URL"'

# These vars must be ALWAYS restored from spawn env, even if .env has a
# non-empty stale value (e.g. HERMES_INFERENCE_PROVIDER=deepseek written by
# hermes serve). Regular restore only fires when the clobbered value is empty.
ALWAYS_RESTORE='"HERMES_INFERENCE_PROVIDER", "DEEPSEEK_BASE_URL", "GLM_BASE_URL"'

# Find the Python interpreter that has Hermes installed
HERMES_PYTHON=""
for py in python3 /home/remsee/.hermes/hermes-agent/venv/bin/python3 /usr/bin/python3; do
    if $py -c "import hermes_cli" 2>/dev/null; then
        HERMES_PYTHON="$py"
        break
    fi
done
if [ -z "$HERMES_PYTHON" ]; then
    echo "[patch-hermes] Could not find Python with Hermes installed"
    exit 1
fi
echo "[patch-hermes] Using Python: $HERMES_PYTHON"

# Find the installed Hermes package directory
HERMES_PKG=$($HERMES_PYTHON -c "import hermes_cli; import os; print(os.path.dirname(os.path.dirname(hermes_cli.__file__)))")
if [ -z "$HERMES_PKG" ]; then
    echo "[patch-hermes] Could not find Hermes package directory"
    exit 1
fi
echo "[patch-hermes] Found Hermes package at: $HERMES_PKG"

# Helper: check if a file has already been patched
already_patched() {
    grep -q "_api_key_.*_backup" "$1" 2>/dev/null
}

# Helper: create the backup/restore Python code block
# $1 = variable name suffix (e.g., "gw", "startup", "main")
make_backup_code() {
    local suffix="$1"
    cat <<PYEOF
_api_key_${suffix}_backup = {}
for _ek in (${API_KEYS}):
    _ev = os.environ.get(_ek, "")
    if _ev.strip():
        _api_key_${suffix}_backup[_ek] = _ev
PYEOF
}

make_restore_code() {
    local suffix="$1"
    cat <<PYEOF
for _ek, _ev in _api_key_${suffix}_backup.items():
    if not os.environ.get(_ek, "").strip():
        os.environ[_ek] = _ev
# Always restore provider + base URLs from spawn env — .env may have stale
# non-empty values (e.g. HERMES_INFERENCE_PROVIDER=deepseek) written by hermes serve.
for _ek in ($ALWAYS_RESTORE):
    if _api_key_${suffix}_backup.get(_ek):
        os.environ[_ek] = _api_key_${suffix}_backup[_ek]
PYEOF
}

# ── Patch 1: gateway/run.py — per-inference load_dotenv(override=True) ──
GW_RUN="$HERMES_PKG/gateway/run.py"
if [ -f "$GW_RUN" ] && ! already_patched "$GW_RUN"; then
    echo "[patch-hermes] Patching $GW_RUN (per-inference load_dotenv)"

    # Patch the per-inference load_dotenv call
    python3 <<PYSCRIPT
import re

path = "$GW_RUN"
with open(path, 'r') as f:
    content = f.read()

api_keys = '''"DEEPSEEK_API_KEY", "KIMI_API_KEY", "KIMI_CODING_API_KEY",
            "KIMI_CN_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
            "OPENROUTER_API_KEY", "ZAI_API_KEY", "GLM_API_KEY",
            "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "XAI_API_KEY",
            "GEMINI_API_KEY", "GOOGLE_API_KEY", "MISTRAL_API_KEY",
            "NVIDIA_API_KEY", "DASHSCOPE_API_KEY", "STEPFUN_API_KEY",
            "TAVILY_API_KEY", "FAL_KEY", "HF_TOKEN", "GITHUB_TOKEN",
            "HERMES_INFERENCE_PROVIDER", "DEEPSEEK_BASE_URL", "GLM_BASE_URL"'''

# Patch 1a: per-inference load_dotenv(override=True)
# Match the exact block:
#   try:
#       load_dotenv(_env_path, override=True, encoding="utf-8")
#   except UnicodeDecodeError:
#       load_dotenv(_env_path, override=True, encoding="latin-1")
#   except Exception:
#       pass
old_block = '''            try:
                load_dotenv(_env_path, override=True, encoding="utf-8")
            except UnicodeDecodeError:
                load_dotenv(_env_path, override=True, encoding="latin-1")
            except Exception:
                pass'''

new_block = '''            _api_key_inf_backup = {}
            for _ek in (%s):
                _ev = os.environ.get(_ek, "")
                if _ev.strip():
                    _api_key_inf_backup[_ek] = _ev
            try:
                load_dotenv(_env_path, override=True, encoding="utf-8")
            except UnicodeDecodeError:
                load_dotenv(_env_path, override=True, encoding="latin-1")
            except Exception:
                pass
            for _ek, _ev in _api_key_inf_backup.items():
                if not os.environ.get(_ek, "").strip():
                    os.environ[_ek] = _ev
            for _ek in ("HERMES_INFERENCE_PROVIDER", "DEEPSEEK_BASE_URL", "GLM_BASE_URL"):
                if _api_key_inf_backup.get(_ek):
                    os.environ[_ek] = _api_key_inf_backup[_ek]''' % api_keys

if old_block in content:
    content = content.replace(old_block, new_block, 1)
    print("[patch-hermes]   Patched per-inference load_dotenv")
else:
    print("[patch-hermes]   WARNING: per-inference load_dotenv block not found (may already be patched or code changed)")

# Patch 1b: startup load_hermes_dotenv
old_startup = '''load_hermes_dotenv(hermes_home=_hermes_home, project_env=Path(__file__).resolve().parents[1] / '.env')'''

new_startup = '''_api_key_gw_startup_backup = {}
for _ek in (%s):
    _ev = os.environ.get(_ek, "")
    if _ev.strip():
        _api_key_gw_startup_backup[_ek] = _ev

load_hermes_dotenv(hermes_home=_hermes_home, project_env=Path(__file__).resolve().parents[1] / '.env')

for _ek, _ev in _api_key_gw_startup_backup.items():
    if not os.environ.get(_ek, "").strip():
        os.environ[_ek] = _ev
for _ek in ("HERMES_INFERENCE_PROVIDER", "DEEPSEEK_BASE_URL", "GLM_BASE_URL"):
    if _api_key_gw_startup_backup.get(_ek):
        os.environ[_ek] = _api_key_gw_startup_backup[_ek]''' % api_keys

if old_startup in content:
    content = content.replace(old_startup, new_startup, 1)
    print("[patch-hermes]   Patched startup load_hermes_dotenv")
else:
    print("[patch-hermes]   WARNING: startup load_hermes_dotenv not found (may already be patched)")

with open(path, 'w') as f:
    f.write(content)
PYSCRIPT
else
    echo "[patch-hermes] Skipping $GW_RUN (already patched or not found)"
fi

# ── Patch 2: hermes_cli/main.py — startup load_hermes_dotenv ──
MAIN_PY="$HERMES_PKG/hermes_cli/main.py"
if [ -f "$MAIN_PY" ] && ! already_patched "$MAIN_PY"; then
    echo "[patch-hermes] Patching $MAIN_PY (startup load_hermes_dotenv)"
    python3 <<PYSCRIPT
path = "$MAIN_PY"
with open(path, 'r') as f:
    content = f.read()

api_keys = '''"DEEPSEEK_API_KEY", "KIMI_API_KEY", "KIMI_CODING_API_KEY",
            "KIMI_CN_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
            "OPENROUTER_API_KEY", "ZAI_API_KEY", "GLM_API_KEY",
            "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "XAI_API_KEY",
            "GEMINI_API_KEY", "GOOGLE_API_KEY", "MISTRAL_API_KEY",
            "NVIDIA_API_KEY", "DASHSCOPE_API_KEY", "STEPFUN_API_KEY",
            "TAVILY_API_KEY", "FAL_KEY", "HF_TOKEN", "GITHUB_TOKEN",
            "HERMES_INFERENCE_PROVIDER", "DEEPSEEK_BASE_URL", "GLM_BASE_URL"'''

old = '''load_hermes_dotenv(project_env=PROJECT_ROOT / ".env")'''

new = '''_api_key_main_backup = {}
for _ek in (%s):
    _ev = os.environ.get(_ek, "")
    if _ev.strip():
        _api_key_main_backup[_ek] = _ev

load_hermes_dotenv(project_env=PROJECT_ROOT / ".env")

for _ek, _ev in _api_key_main_backup.items():
    if not os.environ.get(_ek, "").strip():
        os.environ[_ek] = _ev
for _ek in ("HERMES_INFERENCE_PROVIDER", "DEEPSEEK_BASE_URL", "GLM_BASE_URL"):
    if _api_key_main_backup.get(_ek):
        os.environ[_ek] = _api_key_main_backup[_ek]''' % api_keys

if old in content:
    content = content.replace(old, new, 1)
    print("[patch-hermes]   Patched startup load_hermes_dotenv")
else:
    print("[patch-hermes]   WARNING: load_hermes_dotenv call not found")

with open(path, 'w') as f:
    f.write(content)
PYSCRIPT
else
    echo "[patch-hermes] Skipping $MAIN_PY (already patched or not found)"
fi

# ── Patch 3: run_agent.py — startup load_hermes_dotenv ──
RUN_AGENT="$HERMES_PKG/run_agent.py"
if [ -f "$RUN_AGENT" ] && ! already_patched "$RUN_AGENT"; then
    echo "[patch-hermes] Patching $RUN_AGENT (startup load_hermes_dotenv)"
    python3 <<PYSCRIPT
path = "$RUN_AGENT"
with open(path, 'r') as f:
    content = f.read()

api_keys = '''"DEEPSEEK_API_KEY", "KIMI_API_KEY", "KIMI_CODING_API_KEY",
            "KIMI_CN_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
            "OPENROUTER_API_KEY", "ZAI_API_KEY", "GLM_API_KEY",
            "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "XAI_API_KEY",
            "GEMINI_API_KEY", "GOOGLE_API_KEY", "MISTRAL_API_KEY",
            "NVIDIA_API_KEY", "DASHSCOPE_API_KEY", "STEPFUN_API_KEY",
            "TAVILY_API_KEY", "FAL_KEY", "HF_TOKEN", "GITHUB_TOKEN",
            "HERMES_INFERENCE_PROVIDER", "DEEPSEEK_BASE_URL", "GLM_BASE_URL"'''

old = '''_loaded_env_paths = load_hermes_dotenv(hermes_home=_hermes_home, project_env=_project_env)
if _loaded_env_paths:'''

new = '''_api_key_ra_backup = {}
for _ek in (%s):
    _ev = os.environ.get(_ek, "")
    if _ev.strip():
        _api_key_ra_backup[_ek] = _ev

_loaded_env_paths = load_hermes_dotenv(hermes_home=_hermes_home, project_env=_project_env)

for _ek, _ev in _api_key_ra_backup.items():
    if not os.environ.get(_ek, "").strip():
        os.environ[_ek] = _ev
for _ek in ("HERMES_INFERENCE_PROVIDER", "DEEPSEEK_BASE_URL", "GLM_BASE_URL"):
    if _api_key_ra_backup.get(_ek):
        os.environ[_ek] = _api_key_ra_backup[_ek]

if _loaded_env_paths:''' % api_keys

if old in content:
    content = content.replace(old, new, 1)
    print("[patch-hermes]   Patched startup load_hermes_dotenv")
else:
    print("[patch-hermes]   WARNING: load_hermes_dotenv call not found")

with open(path, 'w') as f:
    f.write(content)
PYSCRIPT
else
    echo "[patch-hermes] Skipping $RUN_AGENT (already patched or not found)"
fi

# ── Patch 4: cron/scheduler.py — per-run load_dotenv(override=True) ──
CRON_SCHED="$HERMES_PKG/cron/scheduler.py"
if [ -f "$CRON_SCHED" ] && ! already_patched "$CRON_SCHED"; then
    echo "[patch-hermes] Patching $CRON_SCHED (per-run load_dotenv)"
    python3 <<PYSCRIPT
path = "$CRON_SCHED"
with open(path, 'r') as f:
    content = f.read()

api_keys = '''"DEEPSEEK_API_KEY", "KIMI_API_KEY", "KIMI_CODING_API_KEY",
                    "KIMI_CN_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
                    "OPENROUTER_API_KEY", "ZAI_API_KEY", "GLM_API_KEY",
                    "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "XAI_API_KEY",
                    "GEMINI_API_KEY", "GOOGLE_API_KEY", "MISTRAL_API_KEY",
                    "NVIDIA_API_KEY", "DASHSCOPE_API_KEY", "STEPFUN_API_KEY",
                    "TAVILY_API_KEY", "FAL_KEY", "HF_TOKEN", "GITHUB_TOKEN",
                    "HERMES_INFERENCE_PROVIDER", "DEEPSEEK_BASE_URL", "GLM_BASE_URL"'''

old = '''        from dotenv import load_dotenv
        try:
            load_dotenv(str(_hermes_home / ".env"), override=True, encoding="utf-8")
        except UnicodeDecodeError:
            load_dotenv(str(_hermes_home / ".env"), override=True, encoding="latin-1")'''

new = '''        from dotenv import load_dotenv
        _api_key_cron_backup = {}
        for _ek in (%s):
            _ev = os.environ.get(_ek, "")
            if _ev.strip():
                _api_key_cron_backup[_ek] = _ev
        try:
            load_dotenv(str(_hermes_home / ".env"), override=True, encoding="utf-8")
        except UnicodeDecodeError:
            load_dotenv(str(_hermes_home / ".env"), override=True, encoding="latin-1")
        for _ek, _ev in _api_key_cron_backup.items():
            if not os.environ.get(_ek, "").strip():
                os.environ[_ek] = _ev
        for _ek in ("HERMES_INFERENCE_PROVIDER", "DEEPSEEK_BASE_URL", "GLM_BASE_URL"):
            if _api_key_cron_backup.get(_ek):
                os.environ[_ek] = _api_key_cron_backup[_ek]''' % api_keys

if old in content:
    content = content.replace(old, new, 1)
    print("[patch-hermes]   Patched per-run load_dotenv")
else:
    print("[patch-hermes]   WARNING: load_dotenv block not found")

with open(path, 'w') as f:
    f.write(content)
PYSCRIPT
else
    echo "[patch-hermes] Skipping $CRON_SCHED (already patched or not found)"
fi

# ── Patch 5: tui_gateway/server.py — startup load_hermes_dotenv ──
TUI_SRV="$HERMES_PKG/tui_gateway/server.py"
if [ -f "$TUI_SRV" ] && ! already_patched "$TUI_SRV"; then
    echo "[patch-hermes] Patching $TUI_SRV (startup load_hermes_dotenv)"
    python3 <<PYSCRIPT
path = "$TUI_SRV"
with open(path, 'r') as f:
    content = f.read()

api_keys = '''"DEEPSEEK_API_KEY", "KIMI_API_KEY", "KIMI_CODING_API_KEY",
            "KIMI_CN_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
            "OPENROUTER_API_KEY", "ZAI_API_KEY", "GLM_API_KEY",
            "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "XAI_API_KEY",
            "GEMINI_API_KEY", "GOOGLE_API_KEY", "MISTRAL_API_KEY",
            "NVIDIA_API_KEY", "DASHSCOPE_API_KEY", "STEPFUN_API_KEY",
            "TAVILY_API_KEY", "FAL_KEY", "HF_TOKEN", "GITHUB_TOKEN",
            "HERMES_INFERENCE_PROVIDER", "DEEPSEEK_BASE_URL", "GLM_BASE_URL"'''

old = '''_hermes_home = get_hermes_home()
load_hermes_dotenv(
    hermes_home=_hermes_home, project_env=Path(__file__).parent.parent / ".env"
)'''

new = '''_hermes_home = get_hermes_home()

_api_key_tui_backup = {}
for _ek in (%s):
    _ev = os.environ.get(_ek, "")
    if _ev.strip():
        _api_key_tui_backup[_ek] = _ev

load_hermes_dotenv(
    hermes_home=_hermes_home, project_env=Path(__file__).parent.parent / ".env"
)

for _ek, _ev in _api_key_tui_backup.items():
    if not os.environ.get(_ek, "").strip():
        os.environ[_ek] = _ev
for _ek in ("HERMES_INFERENCE_PROVIDER", "DEEPSEEK_BASE_URL", "GLM_BASE_URL"):
    if _api_key_tui_backup.get(_ek):
        os.environ[_ek] = _api_key_tui_backup[_ek]''' % api_keys

if old in content:
    content = content.replace(old, new, 1)
    print("[patch-hermes]   Patched startup load_hermes_dotenv")
else:
    print("[patch-hermes]   WARNING: load_hermes_dotenv call not found")

with open(path, 'w') as f:
    f.write(content)
PYSCRIPT
else
    echo "[patch-hermes] Skipping $TUI_SRV (already patched or not found)"
fi

# ── Patch 6 (CRITICAL): hermes_cli/config.py — get_env_value ──
# This is the single chokepoint: all API key lookups go through get_env_value.
# The bug: if os.environ["DEEPSEEK_API_KEY"] == "" (set by load_dotenv override),
# get_env_value returns "" instead of falling through to .env which has the real key.
# Fix: skip empty os.environ values and fall through to .env file.
CONFIG_PY="$HERMES_PKG/hermes_cli/config.py"
if [ -f "$CONFIG_PY" ]; then
    echo "[patch-hermes] Patching $CONFIG_PY (get_env_value — CRITICAL fix)"
    CONFIG_PY_PATH="$CONFIG_PY" python3 <<'PYSCRIPT'
import os

path = os.environ.get("CONFIG_PY_PATH", "")
if not path or not os.path.isfile(path):
    print("[patch-hermes]   WARNING: config.py not found at " + str(path))
    exit(0)

with open(path, 'r') as f:
    content = f.read()

# Check if already patched
if "skip empty values" in content:
    print("[patch-hermes]   config.py already patched")
    exit(0)

old = '''def get_env_value(key: str) -> Optional[str]:
    """Get a value from ~/.hermes/.env or environment."""
    # Check environment first
    if key in os.environ:
        return os.environ[key]
    
    # Then check .env file
    env_vars = load_env()
    return env_vars.get(key)'''

new = '''def get_env_value(key: str) -> Optional[str]:
    """Get a value from ~/.hermes/.env or environment."""
    # Check environment first, but skip empty values — they may have been
    # set by load_dotenv(override=True) clobbering a real key with an empty
    # value from .env. Fall through to .env file in that case.
    if key in os.environ and os.environ[key].strip():
        return os.environ[key]

    # Then check .env file
    env_vars = load_env()
    val = env_vars.get(key)
    if val and val.strip():
        return val

    # If os.environ had an empty value and .env didn't have it either,
    # return the os.environ value (preserves original behavior for non-key vars)
    if key in os.environ:
        return os.environ[key]
    return None'''

if old in content:
    content = content.replace(old, new, 1)
    print("[patch-hermes]   Patched get_env_value (CRITICAL fix)")
else:
    print("[patch-hermes]   WARNING: get_env_value pattern not found (may already be patched or code changed)")

with open(path, 'w') as f:
    f.write(content)
PYSCRIPT
else
    echo "[patch-hermes] Skipping $CONFIG_PY (not found)"
fi

# Verify all patches compile
echo "[patch-hermes] Verifying patches compile..."
for f in "$GW_RUN" "$MAIN_PY" "$RUN_AGENT" "$CRON_SCHED" "$TUI_SRV" "$CONFIG_PY"; do
    if [ -f "$f" ]; then
        python3 -m py_compile "$f" && echo "[patch-hermes]   OK: $f" || echo "[patch-hermes]   FAIL: $f"
    fi
done

echo "[patch-hermes] Done!"
