# The tailnet policy

The box signs in to your tailnet as the tagged device `tag:taskbox`, or the tag in `tailnetTag`, such as `tag:taskbox-studio`. Give each box its own tag when you have more than one, so each keeps its own rules. Your tailnet policy alone decides who reaches it. It replaces Tailscale's default allow-all rule.

It allows your own devices to reach the box by Tailscale SSH as the agent account and the workspace accounts, and by Screen Sharing for the accounts in `accounts.people`. A person given as `{ "user": "sam", "tailnet": "sam@example.com" }` is reached from that Tailscale login only. Nothing reaches root, the service account or the admin users. The box reaches nothing on the tailnet.

For a while, one admin user can be reached: set `adminSsh` in the box's overlay to `{ "login": "pat@example.com", "user": "pat-admin", "until": "2026-12-01T18:00:00Z" }`, at most 30 days off. It is a guarded setting, so it opens after `taskbox settings apply` and `taskbox confirm` at the box. While it is open, the printed policy accepts that login to that user, and `check` warns. After `until`, paste the policy again; `check` then says the access has gone.

At the box, type `taskbox policy show --owner <your Tailscale login>` to print the entries for your settings. `--admin <short name>` names an admin user, once for each, in place of `ADMIN`. `--whole` prints a whole file. This is the whole file for `taskbox.example.json` with one person, `pat`, in `accounts.people` and `accounts.ssh`:

```json
{
  "tagOwners": {
    "tag:taskbox": ["OWNER"]
  },
  "grants": [
    { "src": ["autogroup:member"], "dst": ["autogroup:self"], "ip": ["*"] },
    { "src": ["OWNER"], "dst": ["tag:taskbox"], "ip": ["tcp:22", "tcp:5900"] }
  ],
  "ssh": [
    { "action": "accept", "src": ["OWNER"], "dst": ["tag:taskbox"], "users": ["taskbox-agent"] },
    { "action": "check", "src": ["OWNER"], "dst": ["tag:taskbox"], "users": ["pat"] }
  ],
  "sshTests": [
    { "src": "OWNER", "dst": ["tag:taskbox"], "accept": ["taskbox-agent"], "check": ["pat"], "deny": ["root", "taskbox", "ADMIN"] }
  ],
  "tests": [
    { "src": "OWNER", "accept": ["tag:taskbox:22", "tag:taskbox:5900"] },
    { "src": "tag:taskbox", "deny": ["OWNER:22", "OWNER:80", "OWNER:443", "OWNER:445", "OWNER:548", "OWNER:3283", "OWNER:5900", "OWNER:7000"] }
  ]
}
```

## Applying it

1. Before the install signs the box in, copy your current policy file to a safe note, then add only the `tagOwners` entry the install prints.
2. After the install, remove the allow-all rule and add the entries from `taskbox policy show`. Replace any older taskbox entries. The console runs the tests and refuses a file that fails them.
3. From the controller, check that SSH as the agent account works and SSH as any other account is refused. `taskbox check`'s "Tailnet policy" row compares the rules the tailnet sent the box with the settings.

## If the box is lost

1. Remove the box on the Tailscale Machines page. Its key never expires.
2. Remove its runners from the runner group, and revoke the GitHub App's keys.
3. Change the passwords of every user that logged in at the box.
