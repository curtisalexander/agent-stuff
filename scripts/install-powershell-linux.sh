#!/usr/bin/env bash
set -euo pipefail

version="7.6.4"
sha256="4471b5a36bfe86ec7af8525d36bb1cacba0128e7aac22d05cc064bc00e604721"

if command -v pwsh >/dev/null 2>&1; then
	echo "PowerShell already available: $(pwsh -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion.ToString()')"
	exit 0
fi

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
	echo "This installer supports Linux x86_64 only." >&2
	echo "Install PowerShell using https://learn.microsoft.com/powershell/scripting/install/installing-powershell" >&2
	exit 1
fi

archive="$(mktemp -t powershell-${version}.XXXXXX.tar.gz)"
install_dir="$HOME/.local/share/powershell/$version"
url="https://github.com/PowerShell/PowerShell/releases/download/v${version}/powershell-${version}-linux-x64.tar.gz"
trap 'rm -f "$archive"' EXIT

echo "Downloading PowerShell $version..."
curl -fL "$url" -o "$archive"
printf '%s  %s\n' "$sha256" "$archive" | sha256sum -c -

mkdir -p "$install_dir" "$HOME/.local/bin"
tar -xzf "$archive" -C "$install_dir"
chmod +x "$install_dir/pwsh"
ln -sfn "$install_dir/pwsh" "$HOME/.local/bin/pwsh"

echo "Installed PowerShell $("$HOME/.local/bin/pwsh" -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion.ToString()')"
