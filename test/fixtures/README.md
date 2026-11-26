# Fixtures

Output of real commands on a box, with anything random or private replaced, kept for tests of the code that reads it.

- `launchctl-print-running.txt`, `ps-softnet.txt`: captured on macOS 27.2.
- `tailscaled-ssh.log`, `last-libxo.json`: made up, in the shape the real tools print (for `src/logins.ts`).
- `ws-fence-rules.txt`, `ws-fence-loaded.txt`: golden files for the workspaces' pf rules, written by taskbox.
- `old/`, `v2.6.1-shell.ts`: copies of earlier releases' code, for tests of the update from them.
- `v2.6.1/`: v2.6.1's hop() and the code it calls, unchanged, for the hop contract test.
- `policy/`: the policy files `taskbox policy show --whole` must give for each set of settings.
- `release-key-trial.txt` and its `.sig`: a statement signed with a trial key, for the release check.
