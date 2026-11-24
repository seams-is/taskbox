#!/bin/sh
# The first install of taskbox on the box.
# Run at the box, as your admin user: sh ~/Downloads/taskbox-main/install.sh
# It asks for the admin password itself, fetches the pinned bun, checks its hash, and hands over
# to src/cli.ts, which installs the newest release of taskbox after your yes. This is the one shell
# file; the bun pin below must equal versions.json (a test checks it).
set -eu

BUN_URL="https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-darwin-aarch64.zip"
BUN_SHA256="c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510"

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
self="$here/$(basename -- "$0")"
if [ "$(basename -- "$self")" != install.sh ] || [ ! -f "$self" ]; then
  echo "Type sh ~/Downloads/taskbox-main/install.sh"
  exit 1
fi
# The box's own settings come from this copy of taskbox. The public repo has none.
if [ ! -f "$here/taskbox.json" ]; then
  echo "This copy of taskbox has no taskbox.json. Copy taskbox.example.json to taskbox.json in your private copy, fill in your values (README, A new owner), then download that copy again."
  exit 1
fi

# Not root: run again as root through sudo, by fixed paths, with this file's own full path.
if [ "$(id -u)" != 0 ]; then
  if ! /usr/sbin/dseditgroup -o checkmember -m "$(id -un)" admin >/dev/null 2>&1; then
    echo "Switch to your admin user and type sh $self"
    exit 1
  fi
  echo "The install needs your admin password."
  exec /usr/bin/sudo -p "Password for %u: " -- /bin/sh "$self"
fi
if [ -z "${SUDO_USER:-}" ] || [ "$SUDO_USER" = root ]; then
  echo "Log in as your admin user, then type sh $self"
  exit 1
fi
if [ "$(uname -m)" != arm64 ]; then
  echo "This box is not Apple silicon."
  exit 1
fi

cd /
work=$(mktemp -d /private/var/tmp/taskbox-bootstrap.XXXXXX)
trap 'rm -rf "$work"' EXIT INT TERM

/usr/bin/curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  -o "$work/bun.zip" "$BUN_URL"
got=$(/usr/bin/shasum -a 256 "$work/bun.zip" | /usr/bin/cut -c1-64)
if [ "$got" != "$BUN_SHA256" ]; then
  echo "FAIL: the bun download does not match its pin. Nothing was installed."
  exit 1
fi
/usr/bin/ditto -x -k "$work/bun.zip" "$work"

/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/var/root TMPDIR="$work" \
  SUDO_USER="$SUDO_USER" BUN_INSTALL_CACHE_DIR="$work/cache" \
  "$work/bun-darwin-aarch64/bun" --no-install --no-env-file --cwd=/ --config="$here/bunfig.run.toml" "$here/src/cli.ts" install --bootstrap "$here"
