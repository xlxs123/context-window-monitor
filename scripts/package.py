"""Package source and prebuilt Codex plugin runtime without local session data."""

import hashlib
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / ".codex-plugin/plugin.json").read_text(encoding="utf-8"))
name, version = manifest["name"], manifest["version"]
output = root / "dist" / f"{name}-{version}.zip"
entries = [
    ".codex-plugin", ".mcp.json", "hooks", "skills", "runtime", "src",
    "scripts", "test", "docs", "package.json", "package-lock.json",
    "tsconfig.json", "eslint.config.mjs", ".gitignore", "README.md",
    "CHANGELOG.md", "LICENSE",
]
files = []
for entry in entries:
    path = root / entry
    if not path.exists():
        raise SystemExit(f"Required package entry missing: {entry}")
    files.extend(sorted(path.rglob("*")) if path.is_dir() else [path])
files = [path for path in files if path.is_file() and "__pycache__" not in path.parts]
output.parent.mkdir(exist_ok=True)
with ZipFile(output, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
    for path in files:
        if path.is_symlink():
            raise SystemExit(f"Refusing symlink: {path}")
        archive.write(path, Path(name) / path.relative_to(root))
with ZipFile(output) as archive:
    assert archive.testzip() is None
    assert f"{name}/.codex-plugin/plugin.json" in archive.namelist()
    assert f"{name}/runtime/mcp-server.mjs" in archive.namelist()
digest = hashlib.sha256(output.read_bytes()).hexdigest()
output.with_suffix(".zip.sha256").write_text(f"{digest}  {output.name}\n", encoding="ascii")
print(f"Packaged {len(files)} files: {output}")
print(f"Bytes: {output.stat().st_size}; SHA-256: {digest}")
