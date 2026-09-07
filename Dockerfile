FROM node:22-slim

# Install Python + pip for Hermes Agent gateway (messaging platform integration)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    bubblewrap \
  && rm -rf /var/lib/apt/lists/*

# Install Hermes Agent
# Install Hermes Agent with messaging extra (Telegram, Discord, Slack, etc.)
# The extra is called "messaging" not "telegram" per pyproject.toml
RUN pip3 install --no-cache-dir --break-system-packages 'hermes-agent[messaging]'
# Belt-and-suspenders: directly install python-telegram-bot in case the extra doesn't resolve
RUN pip3 install --no-cache-dir --break-system-packages 'python-telegram-bot[webhooks]>=22.6,<23'

# ── Patch 1: python-dotenv — ROOT CAUSE FIX ──
# Hermes calls load_dotenv(override=True) before every inference call.
# The .env file may contain stale non-empty values (e.g.
# HERMES_INFERENCE_PROVIDER=deepseek written by `hermes serve`) that
# overwrite the correct values from the spawn env (e.g. z-ai).
# Patch python-dotenv's set() to NEVER override an existing non-empty env
# var.  The spawn env from hermes-process.ts is the source of truth on
# Railway — load_dotenv should only fill in gaps, never clobber.
RUN DOTENV_MAIN=$(python3 -c "import dotenv.main; print(dotenv.main.__file__)") && \
    sed -i "s/os.environ\[k\] = v/if k not in os.environ or not os.environ.get(k, '').strip(): os.environ[k] = v/" "$DOTENV_MAIN" && \
    echo "[Docker] Patched python-dotenv set() at $DOTENV_MAIN" && \
    python3 -c "import dotenv.main, inspect; src=inspect.getsource(dotenv.main.DotEnv.set_as_environment_variables); assert 'not os.environ.get(k' in src, 'PATCH FAILED'; print('Verify: python-dotenv source patched OK')" && \
    python3 -c "import os,tempfile,pathlib; from dotenv import load_dotenv; os.environ['HERMES_INFERENCE_PROVIDER']='z-ai'; f=tempfile.NamedTemporaryFile(mode='w',suffix='.env',delete=False); f.write('HERMES_INFERENCE_PROVIDER=deepseek\n'); f.flush(); load_dotenv(f.name,override=True); assert os.environ['HERMES_INFERENCE_PROVIDER']=='z-ai',f'FUNCTIONAL TEST FAILED: got {os.environ[\"HERMES_INFERENCE_PROVIDER\"]}'; print('Verify: python-dotenv functional test OK'); pathlib.Path(f.name).unlink()"

# ── Patch 2: Hermes get_env_value — secondary defense ──
# Skip empty os.environ values in get_env_value so it falls through to .env
# file which has the correct key (written by syncHermesEnvFile).
RUN CONFIG_PY=$(python3 -c "import hermes_cli.config as c; print(c.__file__)") && \
    sed -i 's/    if key in os.environ:/    if key in os.environ and os.environ[key].strip():/' "$CONFIG_PY" && \
    echo "[Docker] Patched get_env_value in $CONFIG_PY" && \
    python3 -c "import hermes_cli.config, inspect; src=inspect.getsource(hermes_cli.config.get_env_value); assert '.strip()' in src, 'PATCH FAILED'; print('Verify: get_env_value patched OK')"

# ── Patch 3: Comprehensive Hermes env clobber patches ──
# Patches load_dotenv/load_hermes_dotenv calls in 6 Hermes files to
# backup API keys before and restore them after (belt-and-suspenders).
COPY scripts/patch-hermes-env-clobber.sh /tmp/patch-hermes-env-clobber.sh
RUN bash /tmp/patch-hermes-env-clobber.sh || true && rm /tmp/patch-hermes-env-clobber.sh

RUN corepack enable && corepack prepare pnpm@10.10.0 --activate

WORKDIR /app

# Install dependencies (cached layer)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN cd node_modules/@railway/cli && node npm-install/postinstall.js

# Install Chromium for Playwright (agent browser feature)
# install-deps installs OS libraries (libglib2.0, libnss3, libatk, etc.)
# without which the browser binary exists but fails to launch
RUN npx playwright install --with-deps chromium

# Copy source and build the client
COPY . .
RUN pnpm build:all

# Create data directory for agent workspaces / logs / saves
# All persistent data lives under /app/ag — mount it as a volume in Railway
# Persist Hermes config (credentials, .env, config.yaml) inside the ag volume so they survive redeploys
# rm -rf first because pip install may have created /root/.hermes as a real directory
RUN mkdir -p /app/ag /app/ag/hermes && \
    rm -rf /root/.hermes && \
    ln -s /app/ag/hermes /root/.hermes

# Hermes gateway port
EXPOSE 3001 9119

ENV PORT=3001
ENV NODE_ENV=production
# Hermes gateway auto-started by the Node server as a child process
ENV HERMES_BASE_URL=http://127.0.0.1:9119
# Explicit HERMES_HOME on the persistent volume so credentials survive redeploy
ENV HERMES_HOME=/app/ag/hermes

CMD ["pnpm", "exec", "tsx", "server/index.ts"]
