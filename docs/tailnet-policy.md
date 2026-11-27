# The tailnet policy

The box signs in as `tag:taskbox`, or the tag in `tailnetTag`; give each box its own. The policy alone decides who reaches it, in place of Tailscale's allow-all rule: your devices reach the agent and workspace accounts by Tailscale SSH, and the accounts in `accounts.people` by Screen Sharing. Nothing reaches root, the service account or the admins, and the box reaches nothing.

At the box, `taskbox policy show --login <your Tailscale login>` prints the entries. `--admin <short name>` fills in `ADMIN`, once for each admin. `--whole` prints a whole file, as here for `taskbox.example.json` with `pat` in `accounts.people` and `accounts.ssh`:

```json
{
  "tagOwners": {
    "tag:taskbox": ["YOUR_LOGIN"]
  },
  "grants": [
    { "src": ["autogroup:member"], "dst": ["autogroup:self"], "ip": ["*"] },
    { "src": ["YOUR_LOGIN"], "dst": ["tag:taskbox"], "ip": ["tcp:22", "tcp:5900"] }
  ],
  "ssh": [
    { "action": "accept", "src": ["YOUR_LOGIN"], "dst": ["tag:taskbox"], "users": ["taskbox-agent"] },
    { "action": "check", "src": ["YOUR_LOGIN"], "dst": ["tag:taskbox"], "users": ["pat"] }
  ],
  "sshTests": [
    { "src": "YOUR_LOGIN", "dst": ["tag:taskbox"], "accept": ["taskbox-agent"], "check": ["pat"], "deny": ["root", "taskbox", "ADMIN"] }
  ],
  "tests": [
    { "src": "YOUR_LOGIN", "accept": ["tag:taskbox:22", "tag:taskbox:5900"] },
    { "src": "tag:taskbox", "deny": ["YOUR_LOGIN:22", "YOUR_LOGIN:80", "YOUR_LOGIN:443", "YOUR_LOGIN:445", "YOUR_LOGIN:548", "YOUR_LOGIN:3283", "YOUR_LOGIN:5900", "YOUR_LOGIN:7000"] }
  ]
}
```

## Applying it

1. Before the install signs the box in, save a copy of your policy, then add the `tagOwners` entry the install prints.
2. After the install, remove the allow-all rule and add the entries from `taskbox policy show`, in place of any older taskbox entries. The console refuses a file whose tests fail.
3. `taskbox check`'s "Tailnet policy" row compares the rules the box was sent with the settings.

## If the box is lost

1. Remove the box on the Tailscale Machines page. Its key never expires.
2. Remove its runners from the runner group, and revoke the GitHub App's keys.
3. Change the passwords of every user that logged in at the box.
