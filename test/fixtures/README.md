# Fixtures

Output of real commands on a box, with anything random or private replaced, kept for tests of the code that reads it. Some files are made, not captured:

- `launchctl-print-running.txt`, `ps-softnet.txt`: captured on macOS 27.2.
- `tailscaled-ssh.log`, `last-libxo.json`: made up, in the shape the real tools print (for `src/logins.ts`).
- `ws-fence-rules.txt`, `ws-fence-loaded.txt`: golden files for the workspaces' pf rules, written by taskbox.
