#!/usr/bin/env bash
# Build, pack, and install the plugin globally with opencode's installer.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GLOBAL="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
# `bun pm pack` names the tarball after the package name and version.
TGZ="$REPO/$(python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); print(p["name"].lstrip("@").replace("/","-") + "-" + p["version"] + ".tgz")' "$REPO/package.json")"
OPENCODE_BIN="${OPENCODE_BIN:-$(command -v opencode || echo "$HOME/.opencode/bin/opencode")}"

bun() { BUN_BE_BUN=1 "$OPENCODE_BIN" "$@"; }

# 1. Build + pack.
( cd "$REPO" && bun build ./src/server.ts --outdir ./dist --target bun --external @opencode-ai/plugin --entry-naming server.js >/dev/null \
  && bun pm pack >/dev/null )
echo "built $TGZ"

# 2. Strip existing Crucible entries so the installer does not add a duplicate.
python3 - "$GLOBAL" <<'PY'
import json, sys, pathlib
gc = pathlib.Path(sys.argv[1])
for path in ("opencode.jsonc", "tui.json"):
    p = gc / path
    if not p.exists():
        continue
    try:
        data = json.loads(p.read_text())
    except ValueError:
        # JSONC with comments: leave the file untouched rather than abort.
        print(f"warning: {p} is not plain JSON; remove old Crucible entries by hand if needed", file=sys.stderr)
        continue
    kept = []
    for e in data.get("plugin", []):
        key = e[0] if isinstance(e, list) and e else (e if isinstance(e, str) else "")
        if isinstance(key, str) and ("crucible" in key):
            continue
        kept.append(e)
    data["plugin"] = kept
    p.write_text(json.dumps(data, indent=2) + "\n")
PY

# 3. Install via opencode's installer (writes server + tui targets).
( cd "$GLOBAL" && "$OPENCODE_BIN" plugin -g "$TGZ" --force )

echo "Done. Restart opencode to load the changes."
