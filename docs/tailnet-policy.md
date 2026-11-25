# The tailnet policy

The box signs in to your tailnet as the tagged device `tag:taskbox`. The install runs `tailscale up --ssh --accept-dns=false --advertise-tags=tag:taskbox` with the box's name. A tagged device belongs to no user, so only rules that name `tag:taskbox` reach it. Its key doesn't expire.

This policy is the only thing that decides who reaches the box. taskbox keeps no list of devices of its own. It replaces Tailscale's default "allow all" rule.

## What it allows

- From your own devices: the agent account (`accounts.agent`) on the box by Tailscale SSH in accept mode, each account in `accounts.ssh` by Tailscale SSH in check mode, and Screen Sharing on port 5900 for the accounts in `accounts.people`. A person gets Tailscale SSH only when named in `accounts.ssh`, which is empty by default: an account you use at the screen is no reason to let agents on your laptop log in as it.
- Your own devices reach each other as before.
- The box reaches nothing on the tailnet. Replies to your connections still flow.
- Nothing reaches root, the service account (`accounts.service`) or the box's admin users by Tailscale SSH.
- Port 5900 is open to your devices only when `accounts.people` names someone, so Screen Sharing's own settings decide who can log in. The box allows only those users, each a standard user, and `taskbox check` fails while it allows anyone else (README, Screen Sharing and remote access).
- People in `accounts.people` are your own accounts on the box: every rule's source is your Tailscale login.

## The policy

taskbox makes this policy from the box's settings. At the box, type `taskbox policy show --owner <your Tailscale login>`: it prints the entries to add, with the box's own account names and admins. `taskbox policy show --whole` prints the whole file, for a tailnet with nothing else in it. Below is the whole file for the example settings (`taskbox.example.json`) with one person, `pat`, in `accounts.people` and in `accounts.ssh`; a test checks it against the code that prints it. With nobody in `accounts.ssh`, the `check` rule isn't there, and with nobody in `accounts.people`, port 5900 isn't either.

Your Tailscale login, in place of `OWNER`, is the email on the admin console's Users page. It stays in the policy file, in the admin console, and taskbox never stores it. Keep it and the admins' names out of anything you post.

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

- **`tagOwners`:** only you may give a device `tag:taskbox`. Tailscale's Owners, Admins and Network admins can still apply any tag, so check on the Users page that you are the only one in those roles. Make no auth key that carries the tag.
- **`grants`:** your devices reach each other on every port, as today. They reach the box on 22 and 5900 only.
- **`ssh`:** the agent account in accept mode, for taskbox on your laptop and for agents. Each account in `accounts.ssh` in check mode: you sign in again in the browser every 12 h, the free plan's fixed period. Every other person is denied SSH, and the tests check it. No rule allows root, `autogroup:nonroot` or the admin user.
- **`sshTests` and `tests`:** the console refuses to save the file unless all of this holds. They check that you reach the agent, each account in `accounts.ssh`, SSH and Screen Sharing on the box, that root, the service account, the admin users and every other person are refused by SSH, and that the box reaches none of eight ports on your devices. Tests take one port each, so they check those eight. With no grant from `tag:taskbox`, every other port is closed too.
- **The default SSH rule** for your own devices (`autogroup:self`) can stay. It covers your untagged devices only.
- **SFTP is off in tailscaled itself.** The policy can't turn it off. tailscaled serves SFTP with its own file server, which skips the agent's restricted shell, so the box's tailscaled runs with `TS_SSH_DISABLE_SFTP` (README, Screen Sharing and remote access).
- **Never give the agent an `acceptEnv` entry.** With one, your laptop could send variables that act on taskbox's runtime before the restricted shell starts. Without one, Tailscale passes only `TERM`, `LANG` and `LC_*`.

## Applying it

A tag must be in the policy before a device can carry it (read: tailscale.com/kb/1068). So the policy goes in two steps.

**Before the install signs the box in:**
1. On the admin console's Access controls page, copy the whole policy file into a note on your laptop. To undo any edit, paste it back.
2. Add only the `tagOwners` entry, and save. The install prints it before it signs the box in.

**After the install has signed the box in:**
1. On the Machines page, check for an exit node or subnet routes, which would need a grant of their own, and for any other user or tagged device, which this policy would cut off.
2. Open a Screen Sharing session to the box, or sit at it, and keep that open until step 6.
3. Copy the policy file into a note again.
4. At the box, type `taskbox policy show --owner <your Tailscale login>`. On the Access controls page, remove the "allow all" rule. It is either an `acls` entry from `*` to `*:*`, or a grant from `*` to `*` with ip `*`. Remove whichever is there. Then put in the `grants`, `ssh`, `sshTests` and `tests` entries it printed. Where the file already has taskbox's own entries from before, replace them with these, rather than adding beside them: an old `check` rule left beside the new tests makes the console refuse the save.
5. Save. The console runs the tests and refuses a file that fails them.
6. From your laptop, check each path: `ssh` as the agent account to the box's Tailscale name, followed by `check`, on one line; a new Screen Sharing session as your own account; and `ssh` as that account to the box, which must be refused unless the account is in `accounts.ssh`. If one fails, paste the note from step 3 back, and say which one failed.
7. Then close the session from step 2.

After the install, from your laptop, `sftp` as the agent account to the box, and `scp` of a file to it, must both fail.

## If the box is lost or stolen

1. On the Machines page, open the box and remove it. Its tagged key never expires, so until it's removed, whoever has the box keeps its tailnet access. Remove any other device that carries `tag:taskbox` and isn't a box you have.
2. On GitHub, remove the box's runners from the organisation's runner group, and revoke the GitHub App's key, and the job source App's key if the box has one.
3. Change the password of your own account and of every other user that logged in at the box, wherever it is used elsewhere.
