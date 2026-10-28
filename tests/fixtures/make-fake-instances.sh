#!/bin/sh
# Builds fake VS Code app bundles for the instance scan, in a temp tree.
#
#   make-fake-instances.sh [root]        create the tree (root defaults to a new temp dir); prints shell
#                                        exports for the two test-only variables on stdout
#   make-fake-instances.sh clean <root>  remove a tree made by this script (refuses any other folder)
#
# Layout under <root>:
#   Applications/                 scan root 1
#     Visual Studio Code.app          com.microsoft.VSCode           1.143.1           listed
#     Visual Studio Code - Insiders.app  com.microsoft.VSCodeInsiders 1.144.0-insider  listed
#     VSCodium.app                    com.vscodium                   1.140.0           listed
#     Antigravity IDE.app             bin/antigravity-ide runs a helper that is missing (ENOENT)   not listed
#     Antigravity.app                 no Contents/Resources/app/bin  not listed
#     Broken Code.app                 com.microsoft.VSCode, serve-web --help exits 1   not listed
#   UserApplications/             scan root 2 (empty, like a missing ~/Applications)
#   AppSupport/                   stands in for ~/Library/Application Support
#     Code - Insiders/User/settings.json (with comments and a trailing comma) and keybindings.json
#     Code - Insiders/User/globalStorage/storage.json  the vault (<root>/Vault) is associated with the Default profile
#   Home/.vscode-insiders/extensions/   stands in for ~/.vscode-insiders/extensions
#     extensions.json and chakrounanas.turbo-console-log-3.29.0/   Turbo Console Log, enabled (the extension spike's fixture)
#   Vault/                        the vault folder the association above names
#
# Every stub `code` answers `serve-web --help` and otherwise runs the fake serve-web server from this
# folder (fake-code.sh), so a Code tab can start against it. The folder is only ever written under <root>.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
MARK=.workbench-fake-instances

if [ "${1:-}" = clean ]; then
  root=${2:?usage: make-fake-instances.sh clean <root>}
  if [ ! -f "$root/$MARK" ]; then
    echo "refusing to remove $root: not made by make-fake-instances.sh" >&2
    exit 1
  fi
  rm -rf "$root"
  exit 0
fi

root=${1:-}
if [ -z "$root" ]; then
  root=$(mktemp -d "${TMPDIR:-/tmp}/workbench-fake-instances.XXXXXX")
else
  mkdir -p "$root"
fi
touch "$root/$MARK"

# make_app <folder name> <bundle id> <version> <cli name> <data folder> <name short> <kind: ok|helper-missing|exit1|nobin>
make_app() {
  app="$root/Applications/$1"
  mkdir -p "$app/Contents/Resources/app"
  cat >"$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>$2</string>
</dict>
</plist>
PLIST
  cat >"$app/Contents/Resources/app/product.json" <<JSON
{ "version": "$3", "dataFolderName": "$5", "nameShort": "$6", "darwinBundleIdentifier": "$2" }
JSON
  if [ "$7" = nobin ]; then return 0; fi
  bin="$app/Contents/Resources/app/bin"
  mkdir -p "$bin"
  case "$7" in
    ok)
      cp "$here/fake-code.sh" "$bin/fake-code.sh"
      cp "$here/fake-serve-web.mjs" "$bin/fake-serve-web.mjs"
      cat >"$bin/$4" <<'STUB'
#!/bin/sh
# Stub CLI: answers `serve-web --help`; any other call runs the fake server next to it.
here=$(dirname "$0")
if [ "$1" = "serve-web" ] && [ "$2" = "--help" ]; then
  echo "Runs a local web version of Visual Studio Code"
  echo "Usage: code-tunnel serve-web [OPTIONS]"
  echo "      --connection-token-file <FILE>  --disable-telemetry"
  exit 0
fi
exec "$here/fake-code.sh" "$@"
STUB
      chmod +x "$bin/$4" "$bin/fake-code.sh"
      ;;
    helper-missing)
      # Like Antigravity IDE here: the launcher exists but the binary it runs is gone.
      cat >"$bin/$4" <<'STUB'
#!/bin/sh
here=$(dirname "$0")
exec "$here/antigravity-tunnel" "$@"
STUB
      chmod +x "$bin/$4"
      ;;
    exit1)
      printf '#!/bin/sh\necho "serve-web is not available" >&2\nexit 1\n' >"$bin/$4"
      chmod +x "$bin/$4"
      ;;
  esac
}

mkdir -p "$root/Applications" "$root/UserApplications"
make_app "Visual Studio Code.app"            com.microsoft.VSCode          1.143.1          code            .vscode           Code              ok
make_app "Visual Studio Code - Insiders.app" com.microsoft.VSCodeInsiders  1.144.0-insider  code            .vscode-insiders  "Code - Insiders" ok
make_app "VSCodium.app"                      com.vscodium                  1.140.0          codium          .vscode-oss       VSCodium          ok
make_app "Antigravity IDE.app"               com.google.antigravity-ide    1.0.0            antigravity-ide .antigravity-ide  "Antigravity IDE" helper-missing
make_app "Antigravity.app"                   com.google.antigravity        1.0.0            antigravity     .antigravity      Antigravity       nobin
make_app "Broken Code.app"                   com.microsoft.VSCode          1.100.0          code            .vscode           Code              exit1

user="$root/AppSupport/Code - Insiders/User"
mkdir -p "$user"
cat >"$user/settings.json" <<'JSONC'
{
  // a comment the copy may drop
  "editor.fontSize": 15,
  "python.analysis.typeCheckingMode": "basic",
  "files.watcherExclude": { "**/build": true, },
}
JSONC
printf '[\n  { "key": "cmd+k cmd+t", "command": "workbench.action.selectTheme" }\n]\n' >"$user/keybindings.json"

# The extension spike's fixture (tests/render/extension-spike.mjs GP1): Turbo Console Log installed and enabled in the
# Insiders extensions folder, and the vault associated with the Default profile. Nothing outside <root> is touched.
mkdir -p "$root/Vault" "$user/globalStorage"
cat >"$user/globalStorage/storage.json" <<JSON
{
  "profileAssociations": {
    "workspaces": {
      "file://$root/Vault": "__default__profile__"
    }
  },
  "userDataProfiles": []
}
JSON
ext="$root/Home/.vscode-insiders/extensions"
mkdir -p "$ext/chakrounanas.turbo-console-log-3.29.0"
printf '{ "name": "turbo-console-log", "publisher": "ChakrounAnas", "version": "3.29.0", "main": "./out/extension.js" }\n' >"$ext/chakrounanas.turbo-console-log-3.29.0/package.json"
cat >"$ext/extensions.json" <<JSON
[
  {
    "identifier": { "id": "chakrounanas.turbo-console-log" },
    "version": "3.29.0",
    "location": { "\$mid": 1, "path": "$ext/chakrounanas.turbo-console-log-3.29.0", "scheme": "file" }
  }
]
JSON

echo "export WORKBENCH_SCAN_ROOTS='$root/Applications:$root/UserApplications'"
echo "export WORKBENCH_APP_SUPPORT_ROOT='$root/AppSupport'"
echo "# spike fixture: extensions $ext   vault $root/Vault"
echo "# tree: $root   (remove with: $0 clean '$root')"
