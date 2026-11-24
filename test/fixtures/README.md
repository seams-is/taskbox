# Captured output

Output of real commands on a box, kept for tests of the code that reads it. Anything random or
private in a capture is replaced (the launchd socket's name).

- `launchctl-print-running.txt`: `launchctl print gui/502/local.taskbox.loop` on macOS 27.2 while the
  loop ran, from the v2.5.0 Tart rerun, cut at its first 80 lines. The same lines read the same
  after the loop was stopped with SIGSTOP: launchd still says running, which is why the guard reads
  the beats too (src/loopwatch.ts).
- `ps-softnet.txt`: one line of `/bin/ps -axo pid=,etime=,user=,ruser=,svuid=,comm=`, run by ci on
  macOS 27.2 in the PR #40 Tart rerun, while taskbox's Softnet ran as root before it dropped to ci.
  Softnet was started the way Tart 2.41.1 starts it (Foundation Process, found through the loop's
  PATH), so comm is the full path through the /opt/taskbox link. comm is the process's argv[0]: the
  same Softnet started by a bare name prints `softnet`.

Two fixtures are made, not captured, for src/logins.ts. Every name and address in them is made up.
- `tailscaled-ssh.log`: Tailscale SSH lines as tailscaled v1.104.5 prints them, built from the format
  strings in ssh/tailssh/tailssh.go at tag v1.104.5 (each regex in src/logins.ts names its line), with
  Go's log.LstdFlags time in front, and two unrelated tailscaled lines. Not captured on a box.
- `last-libxo.json`: `last --libxo json -y -s` in the shape macOS 27.2 prints it on a Mac (read on the
  owner's laptop, values replaced), with sessions from tailnet addresses added. Not captured on a box. A session with no terminal
  shows as tty `tty__`, as `login -f -h <address> <user> <command>` with no terminal records it in a
  Tart test Mac on macOS 27.2.
