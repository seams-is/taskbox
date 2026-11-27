#!/bin/sh
# The first install of taskbox on a box, from a signed release.
# In one folder: the release's statement.json, statement.json.sig and taskbox-vX.Y.Z.tar.gz from its
# release page, the tarball unpacked there. Then, as your admin user:
#   sh taskbox/install.sh --settings ORG/REPO
# taskbox box install from the controller does this over ssh, with a private settings repo's
# taskbox.json put beside the release. Without one, this reads a public settings repo itself.
# It asks for the admin password, fetches the pinned bun, checks its hash, and hands over to
# src/cli.ts, which verifies the release against the keys this copy pins before anything else. This
# is the one shell file; the bun pin below must equal versions.json (a test checks it).
# --guest-test: the whole install in taskbox's own VMs, with the steps a guest can't take skipped.
set -eu

BUN_URL="https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-darwin-aarch64.zip"
BUN_SHA256="c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510"
USAGE="Type sh taskbox/install.sh --settings ORG/REPO, in the folder the release is in."

settings=""
guest=""
while [ $# -gt 0 ]; do
  case "$1" in
    --settings)
      case "${2:-}" in
        */*/*|*[!A-Za-z0-9._/-]*|/*|*/|-*|.*|"") echo "--settings takes the settings repo, as ORG/REPO."; exit 2 ;;
        */*) settings=$2 ;;
        *) echo "--settings takes the settings repo, as ORG/REPO."; exit 2 ;;
      esac
      shift 2 ;;
    --guest-test) guest=--guest-test; shift ;;
    *) echo "$USAGE"; exit 2 ;;
  esac
done
if [ -z "$settings" ]; then
  echo "$USAGE"
  exit 2
fi

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
self="$here/$(basename -- "$0")"
from=$(dirname -- "$here")
if [ "$(basename -- "$self")" != install.sh ] || [ ! -f "$self" ]; then
  echo "$USAGE"
  exit 1
fi
# The release's signed files, beside the unpacked tree, before any password is asked for.
if [ ! -f "$from/statement.json" ] || [ ! -f "$from/statement.json.sig" ]; then
  echo "The release isn't complete in $from: download statement.json, statement.json.sig and taskbox-vX.Y.Z.tar.gz from the release page into one folder, unpack the tarball there, then type sh taskbox/install.sh --settings $settings"
  exit 1
fi

# Not root: run again as root through sudo, by fixed paths, with this file's own full path.
if [ "$(id -u)" != 0 ]; then
  if ! /usr/sbin/dseditgroup -o checkmember -m "$(id -un)" admin >/dev/null 2>&1; then
    echo "Switch to your admin user and type sh $self --settings $settings"
    exit 1
  fi
  echo "The install needs your admin password."
  exec /usr/bin/sudo -p "Password for %u: " -- /bin/sh "$self" --settings "$settings" $guest
fi
if [ -z "${SUDO_USER:-}" ] || [ "$SUDO_USER" = root ]; then
  echo "Log in as your admin user, then type sh $self --settings $settings"
  exit 1
fi
if [ "$(uname -m)" != arm64 ]; then
  echo "This box is not Apple silicon."
  exit 1
fi

cd /
work=$(mktemp -d /private/var/tmp/taskbox-bootstrap.XXXXXX)
trap 'rm -rf "$work"' EXIT INT TERM
get() { /usr/bin/curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-time 600 "$@"; }

get -o "$work/bun.zip" "$BUN_URL"
got=$(/usr/bin/shasum -a 256 "$work/bun.zip" | /usr/bin/cut -c1-64)
if [ "$got" != "$BUN_SHA256" ]; then
  echo "FAIL: the bun download does not match its pin. Nothing was installed."
  exit 1
fi
/usr/bin/ditto -x -k "$work/bun.zip" "$work"

# The release and the settings, copied into root's own folder, so nothing changes under the install.
rel="$work/release"
/bin/mkdir -m 700 "$rel"
for f in statement.json statement.json.sig taskbox.json taskbox.json.commit; do
  if [ -f "$from/$f" ] && [ ! -L "$from/$f" ]; then /bin/cp "$from/$f" "$rel/$f"; fi
done
for f in "$from"/taskbox-v*.tar.gz; do
  if [ -f "$f" ] && [ ! -L "$f" ]; then /bin/cp "$f" "$rel/"; fi
done

# A public settings repo: its default branch's head commit, then taskbox.json at that commit.
if [ ! -f "$rel/taskbox.json" ]; then
  echo "settings: taskbox.json from $settings, at its default branch's head."
  sha=$(get -H "Accept: application/vnd.github.sha" -H "User-Agent: taskbox" "https://api.github.com/repos/$settings/commits/HEAD" 2>/dev/null || true)
  case "$sha" in
    *[!0-9a-f]*|"") sha="" ;;
  esac
  if [ ${#sha} -ne 40 ] || ! get --max-filesize 512000 -o "$rel/taskbox.json" "https://raw.githubusercontent.com/$settings/$sha/taskbox.json" 2>/dev/null; then
    echo "taskbox couldn't read taskbox.json from $settings. A private settings repo is read through your own GitHub session: from the controller, type taskbox box install ADMIN@MAC --settings $settings. Nothing was installed."
    exit 1
  fi
  echo "$sha" > "$rel/taskbox.json.commit"
fi

/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/var/root TMPDIR="$work" \
  SUDO_USER="$SUDO_USER" BUN_INSTALL_CACHE_DIR="$work/cache" \
  "$work/bun-darwin-aarch64/bun" --no-install --no-env-file --cwd=/ --config="$here/bunfig.run.toml" "$here/src/cli.ts" install --bootstrap "$rel" --settings "$settings" $guest
