# Fixtures

Output of real commands on a box, with anything random or private replaced, kept for tests of the code that reads it.

- `launchctl-print-running.txt`, `ps-softnet.txt`: captured on macOS 27.2.
- `tailscaled-ssh.log`, `last-libxo.json`: made up, in the shape the real tools print (for `src/logins.ts`).
- `ws-fence-rules.txt`, `ws-fence-loaded.txt`: golden files for the workspaces' pf rules, written by taskbox.
- `old/`, `v2.6.1-shell.ts`: copies of earlier releases' code, for tests of the update from them.
- `v2.6.1/`: v2.6.1's hop() and the code it runs, from c7d2414, for the hop contract test. log.ts, the plists and the signers file are whole. Each other file is cut to what hop() runs, its parts unchanged; its imports and any part marked New are not v2.6.1's.
- `policy/`: the policy files `taskbox policy show --whole` must give for each set of settings.
- `release-key-trial.txt`, its `.sig` and `.signers`: a trial file signed with a Secure Enclave key, and a signers file that pins that key, for the release check.
- `github/conversion.json`: the example answer of `POST /app-manifests/{code}/conversions` from GitHub's OpenAPI description (github/rest-api-description, `integration-from-manifest`), its key replaced by the test. It has no `public` field.
- `se-signature/`: a real Secure Enclave signature (Touch ID, namespace taskbox-release) over `message.txt`, with its own public key, for the in-process signature check against ssh-keygen.
