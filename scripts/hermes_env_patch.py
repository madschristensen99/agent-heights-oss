"""sitecustomize.py — Patches hermes_cli.config.get_env_value at Python startup.

Python automatically imports this module at startup. It directly imports
hermes_cli.config and patches get_env_value to skip empty os.environ values
and fall through to the .env file.

This fixes the "API key not found" error caused by load_dotenv(override=True)
clobbering DEEPSEEK_API_KEY with an empty value from .env.

Root cause: get_env_value checks `if key in os.environ: return os.environ[key]`
— when the key exists but is empty (set by load_dotenv override), it returns ""
instead of checking .env which has the real key.
"""
import os

try:
    import hermes_cli.config as _cfg

    _load_env_fn = _cfg.load_env

    def _patched_get_env_value(key):
        # Check os.environ first, but skip empty values.
        # load_dotenv(override=True) can set DEEPSEEK_API_KEY="" in os.environ,
        # clobbering the real key. Skip empty values and fall through to .env
        # file which has the correct key.
        val = os.environ.get(key, "")
        if val and val.strip():
            return val

        # Check .env file
        try:
            env_vars = _load_env_fn()
        except Exception:
            env_vars = {}
        v = env_vars.get(key)
        if v and v.strip():
            return v

        # If os.environ had a value (even empty), return it to preserve
        # original behavior for non-secret config values.
        if key in os.environ:
            return os.environ[key]
        return None

    _cfg.get_env_value = _patched_get_env_value
except Exception:
    pass
