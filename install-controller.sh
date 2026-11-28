#!/bin/sh
# The first install of taskbox on a Mac as the controller, the Mac you run every box from.
# Run as your own user, from the release folder you downloaded and unpacked:
#   sh ~/Downloads/taskbox/install-controller.sh <org>/<repo>
# <org>/<repo> is the public repo you downloaded it from. It fetches the pinned bun, checks its
# hash, and hands over to src/controller/main.ts, which downloads that repo's newest release,
# checks its signature against the signers file in this folder, and installs it after your yes.
# It uses no admin rights. The bun pin below must equal versions.json (a test checks it).
set -eu

BUN_URL="https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-darwin-aarch64.zip"
BUN_SHA256="c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510"

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
self="$here/$(basename -- "$0")"
if [ "$(id -u)" = 0 ]; then
  echo "Run it as your own user: sh $self <org>/<repo>"
  exit 1
fi
case "${1:-}" in
  */*) ;;
  *)
    echo "Type sh $self <org>/<repo>, naming the public repo you downloaded taskbox from."
    exit 1
    ;;
esac
if [ "$(uname -m)" != arm64 ]; then
  echo "This Mac is not Apple silicon, and taskbox pins bun for Apple silicon only."
  exit 1
fi

cd /
work=$(mktemp -d "${TMPDIR:-/tmp}/taskbox-bootstrap.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM

/usr/bin/curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  -o "$work/bun.zip" "$BUN_URL"
got=$(/usr/bin/shasum -a 256 "$work/bun.zip" | /usr/bin/cut -c1-64)
if [ "$got" != "$BUN_SHA256" ]; then
  echo "FAIL: the bun download does not match its pin. Nothing was installed."
  exit 1
fi
/usr/bin/ditto -x -k "$work/bun.zip" "$work"

/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$HOME" TMPDIR="$work" \
  BUN_INSTALL_CACHE_DIR="$work/cache" \
  "$work/bun-darwin-aarch64/bun" --no-install --no-env-file --cwd=/ --config="$here/bunfig.run.toml" \
  "$here/src/controller/main.ts" install --from "$1" --bootstrap "$here"
