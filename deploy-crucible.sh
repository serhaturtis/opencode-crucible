#!/usr/bin/env bash
# Build and register this checkout as a global opencode (v2) plugin.
# opencode resolves a local directory plugin's `server`/`tui` entrypoints (server.ts, tui.ts
# at the repo root), so the repo's own node_modules must satisfy zod, @opentui/solid, solid-js.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GLOBAL="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
OPENCODE_BIN="${OPENCODE_BIN:-$(command -v opencode || echo "$HOME/.opencode/bin/opencode")}"

bun() { BUN_BE_BUN=1 "$OPENCODE_BIN" "$@"; }

# `bun run <script>` spawns a bare `bun`; give the embedded runtime a PATH shim.
BUN_SHIM="$(mktemp -d)"
trap 'rm -rf "$BUN_SHIM"' EXIT
printf '#!/usr/bin/env bash\nexec env BUN_BE_BUN=1 "%s" "$@"\n' "$OPENCODE_BIN" > "$BUN_SHIM/bun"
chmod +x "$BUN_SHIM/bun"
export PATH="$BUN_SHIM:$PATH"

# 1. Install deps, build.
( cd "$REPO" && bun install >/dev/null \
  && bun run build >/dev/null )

# 2. Register the checkout in the global config, replacing older Crucible entries.
python3 - "$GLOBAL" "$REPO" <<'PY'
import json, sys, pathlib
gc, repo = pathlib.Path(sys.argv[1]), sys.argv[2]
p = gc / "opencode.jsonc"
if not p.exists():
    p.write_text(json.dumps({"$schema": "https://opencode.ai/config.json"}, indent=2) + "\n")
try:
    data = json.loads(p.read_text())
except ValueError:
    print(f"warning: {p} is not plain JSON; add \"{repo}\" to its plugins by hand", file=sys.stderr)
    raise SystemExit(1)

def key(entry):
    if isinstance(entry, list) and entry:
        return entry[0]
    if isinstance(entry, dict):
        return entry.get("package", "")
    return entry if isinstance(entry, str) else ""

def kept(entry):
    entry_key = key(entry)
    return not (isinstance(entry_key, str) and "crucible" in entry_key)

for field in ("plugin", "plugins"):
    data[field] = [e for e in data.get(field, []) if kept(e)]
data.setdefault("plugins", []).append(repo)
p.write_text(json.dumps(data, indent=2) + "\n")
PY

echo "Done. Restart opencode to load the changes."
