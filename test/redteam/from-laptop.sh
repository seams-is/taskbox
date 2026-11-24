#!/bin/bash
# taskbox red-team tests run from the owner's laptop against the box over Tailscale (TB-SSH-1, TB-SSH-3,
# TB-SSH-4, TB-POL-1's laptop part). Read-only: nothing here changes the box. Each test prints what it
# ran, what it should do, and what happened. Send the whole output to taskbox.
# SSH3-i and SSH3-k try a local and a dynamic forward. Each says inconclusive, never its pass value,
# unless ssh connected and its laptop port answered. Read SSH3-i with POL1-b: it counts only when
# Screen Sharing is open. TASKBOX_AGENT names the agent account, remote by default.
#
#   bash test/redteam/from-laptop.sh taskbox-1 <box admin's short name> [<your own account on the box>]
#
# The lines for your own account run only when you name it. They use Tailscale SSH's check mode: if
# Tailscale asks you to sign in in the browser, do. The agent-forwarding test runs with a fresh,
# empty ssh-agent of its own, so your real agent never reaches the box.
set -u
H="${1:?usage: from-laptop.sh <box> <admin user>}"
ADMIN="${2:?usage: from-laptop.sh <box> <admin user>}"
PERSON="${3:-}"
A="${TASKBOX_AGENT:-remote}"
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
F="$(mktemp -t taskbox-rt)"
echo "red-team test file" > "$F"
PIDS=()
trap 'rm -f "$F"; [ ${#PIDS[@]} -eq 0 ] || kill "${PIDS[@]}" 2>/dev/null' EXIT
O=(-o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=yes)
lim() { perl -e 'alarm shift; exec @ARGV' "$@"; }
t() { # id, should, command...
  local id="$1" should="$2"; shift 2
  echo "=== $id"
  local ran="$*"; echo "ran:    ${ran:0:160}"
  echo "should: $should"
  local out; out="$(lim 25 "$@" < /dev/null 2>&1)"; local code=$?
  echo "exit:   $code"
  printf '%s\n' "$out" | head -8 | sed 's/^/out:    /'
}
up() { nc -z -G 1 localhost "$1" 2>/dev/null; }
fwd() { # id, should, laptop port, ssh forward flag, its spec, probe command...
  local id="$1" should="$2" port="$3" flag="$4" spec="$5"; shift 5
  echo "=== $id"
  echo "ran:    ssh -N $flag $spec $A@$H, then $*"
  echo "should: $should"
  if up "$port"; then echo "out:    inconclusive: laptop port $port is already in use"; return; fi
  ssh "${O[@]}" -N -o ExitOnForwardFailure=yes "$flag" "$spec" "$A@$H" < /dev/null > /dev/null 2>&1 &
  local pid=$! i=0 ok=""
  PIDS+=("$pid")
  # ssh binds a local forward only after it logs in, so a live ssh and an answering port show it did.
  while [ $i -lt 20 ]; do
    kill -0 "$pid" 2>/dev/null || break
    if up "$port"; then ok=1; break; fi
    sleep 0.5; i=$((i + 1))
  done
  if [ -z "$ok" ]; then
    echo "out:    inconclusive: ssh did not connect"
  else
    local out; out="$(lim 15 "$@" < /dev/null 2>&1)"; local code=$?
    echo "exit:   $code"
    printf '%s\n' "$out" | head -8 | sed 's/^/out:    /'
  fi
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  PIDS=()
}

echo "taskbox red-team from the laptop, $(date -u +%Y-%m-%dT%H:%MZ)"
t SSH1-a "fail: sftp disabled"                 sftp "${O[@]}" -b /dev/null "$A@$H"
t SSH1-b "fail: sftp disabled"                 scp "${O[@]}" "$F" "$A@$H:/tmp/rt-scp"
t SSH1-c "fail: the shell refuses scp"         scp -O "${O[@]}" "$F" "$A@$H:/tmp/rt-scpO"
t SSH1-d "fail: sftp disabled"                 ssh "${O[@]}" -s "$A@$H" sftp
t SSH1-e "fail: the shell refuses it"          ssh "${O[@]}" "$A@$H" /usr/libexec/sftp-server
t SSH1-f "fail: the shell refuses rsync"       rsync -e "ssh ${O[*]}" "$F" "$A@$H:/tmp/rt-rsync"
t SSH1-g "fail: unsupported subsystem"         ssh "${O[@]}" -s "$A@$H" foo
if [ -n "$PERSON" ]; then
  t SSH1-h "fail: sftp disabled, also for $PERSON" sftp "${O[@]}" -b /dev/null "$PERSON@$H"
fi
t SSH3-a "fail: remote forwarding refused"     ssh "${O[@]}" -o ExitOnForwardFailure=yes -N -R 9000:localhost:22 "$A@$H"
fwd SSH3-i "empty, no RFB banner; counts only if POL1-b is open" 15900 -L 15900:localhost:5900 \
  bash -c 'nc -G 5 localhost 15900 < /dev/null | head -c 12'
fwd SSH3-k "000: no onward reach through the box" 15080 -D 15080 \
  curl -sS -m 10 --socks5-hostname localhost:15080 -o /dev/null -w '%{http_code}' https://github.com
if [ -n "$PERSON" ]; then
  # A throwaway agent with no keys, so nothing of yours is offered to the box.
  eval "$(ssh-agent -s)" > /dev/null
  t SSH3-b "empty: no agent socket for $PERSON" ssh "${O[@]}" -A "$PERSON@$H" 'echo "SSH_AUTH_SOCK=[$SSH_AUTH_SOCK]"'
  ssh-agent -k > /dev/null
  t SSH3-c "empty: no X11 for $PERSON"          env -u DISPLAY ssh "${O[@]}" -X "$PERSON@$H" 'echo "DISPLAY=[$DISPLAY]"'
fi
t SSH3-d "the normal hello line, not a bun version" ssh "${O[@]}" -o SetEnv=BUN_OPTIONS=--version -o SetEnv=NODE_OPTIONS=--version "$A@$H" hello
t SSH3-e "refused: hello takes nothing"        ssh "${O[@]}" "$A@$H" 'hello extra'
t SSH3-f "refused: ; isn't allowed"            ssh "${O[@]}" "$A@$H" 'status;id'
t SSH3-g "refused or the usage line"           ssh "${O[@]}" "$A@$H" ''
t SSH3-h "refused: far too long"               ssh "${O[@]}" "$A@$H" "$(head -c 200000 /dev/zero | tr '\0' a)"
up1() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }
UPPER="$(up1 "$PERSON")"
for u in root ci "$ADMIN" "$(up1 "${A:0:1}")${A:1}" "$(up1 "$A")" ${UPPER:+"$UPPER"} nobody daemon; do
  t "SSH4-$u" "fail: tailnet policy denies $u" ssh "${O[@]}" "$u@$H" true
done
if [ -n "$PERSON" ]; then
  t SSH4-shell "$PERSON's own shell (zsh), not taskbox-shell" ssh "${O[@]}" "$PERSON@$H" 'echo "SHELL=$SHELL"; ps -o comm= -p $$'
fi
t POL1-a "open: SSH"                           nc -vz -G 5 "$H" 22
t POL1-b "open: Screen Sharing"                nc -vz -G 5 "$H" 5900
t POL1-c "time out: closed"                    nc -vz -G 5 "$H" 5252
t POL1-d "time out: closed"                    nc -vz -G 5 "$H" 8080
V6="$("$TS" ip -6 "$H" 2>/dev/null | head -1)"
if [ -n "$V6" ]; then
  t POL1-e "open: SSH over IPv6"               nc -6 -vz -G 5 "$V6" 22
  t POL1-f "time out: closed over IPv6"        nc -6 -vz -G 5 "$V6" 8080
else echo "=== POL1-e/f: no IPv6 address read for $H"; fi
echo "=== done"
