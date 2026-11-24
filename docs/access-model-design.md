# The access model (v2.7.0): design

Status: design, for review. Facts are labelled: **read** (in the code or a doc), **ran**, or **not checked**.

## 1. Outcome and roles

### The outcome

The owner's words: taskbox "feels hard-coded to the specific random user accounts i created for throwaway purposes". Today the code fixes the service account as `ci` (`CI_USER` in `src/config.ts`; `/Users/ci` and `"ci"` written out in `src/checks.ts`; read). It defaults the agent account to `remote` (`DEFAULT_REMOTE_USER`; read), makes the owner create `ci` by hand (`MAKE_CI` in `src/install.ts`; read), and keeps who may reach the box in a hand-edited `docs/tailnet-policy.md` that names `remote` and `ci` (read).

After v2.7.0:
- Every account taskbox uses is named in one place, the `accounts` block of `taskbox.json`, by its role.
- taskbox makes the two accounts it owns (service and agent) itself.
- `taskbox policy` writes the tailnet policy from the settings.
- The rules for who may do what are pure functions, tested without a Mac.
- A box installed today keeps its accounts and names.

### The roles

| Role | Who | May do | Never |
|---|---|---|---|
| **owner-admin** | any macOS admin account on the box (`admin` group; read: `src/elevate.ts`) | `update`, `undo`, `remove`, `unlock`, through `sudo`; `policy` and every read command, with no `sudo` | is named in `accounts`; is reached by Tailscale SSH (the policy denies admins) |
| **service** | the one account that runs the loop in its GUI session, owns `~/.taskbox` and Tart's images, and unlocks the disk after a restart | `stop`, `start`, `clean`, `watch --state`, the loop itself; every read command, with names | is an admin; is reached by Tailscale SSH; is a person's account |
| **agent** | the account agents and a laptop controller reach over Tailscale SSH, in accept mode | taskbox's restricted shell only: `status`, `watch`, `jobs`, `timings`, `log`, `check`, `hello` (read: `SHELL_COMMANDS` in `src/shell.ts`) | is an admin; holds a password anyone keeps; has a home it can write; logs in at the screen |
| **person** | a human's own standard account | Screen Sharing (when on); Tailscale SSH in check mode only when named in `accounts.ssh` (empty by default; the owner's decision, 20 Nov 2026); every read command, with counts in place of other users' names | is an admin; is the service or the agent |
| **guest** | the VM image's own account, inside each VM | nothing on the box. The loop seals it (SSH off, a new password; read: `sealGuest` in `src/loop.ts`) | is a box account. It is the image's concern and isn't in `accounts` |

Any other account is **other**: shown as a count in `taskbox check`, and refused for every taskbox role.

### Settings

```json
"accounts": {
  "service": "taskbox",
  "agent": "taskbox-agent",
  "people": ["pat"]
}
```

- `service`: required. Its default in `taskbox.example.json` is `taskbox`. A box installed before v2.7.0 names `ci`.
- `agent`: optional. Absent means no agent account and no Tailscale SSH for agents: a box with no controller. A box installed before v2.7.0 names `remote`.
- `people`: optional, may be empty. It replaces `screenSharingUsers`.
- These go: `CI_USER`, `DEFAULT_REMOTE_USER`, `DEFAULT_SCREEN_SHARING_USERS` and `workspaceUsers`.
- `remoteUser` and `screenSharingUsers` stay accepted beside `accounts` for one release, when they agree with `accounts.agent` and `accounts.people` (section 4). Alone, or disagreeing, `loadConfig` refuses them with one line naming their new places. v2.8.0 refuses them always.

### Validation

These are pure functions in `src/access.ts`, run by `loadConfig`:
- Every name matches macOS's short-name shape (`USER_NAME` today; read).
- The names are distinct, ignoring case (macOS ignores case in user names; read: v2.1.1's `toLowerCase` checks).
- No name is `root`, `daemon`, `nobody`, `admin`, `wheel`, `staff`, `everyone` or `guest`, or starts with `_` (macOS's own accounts and groups).
- `people` has at most 8 names, with no repeats. Eight is the Screen Sharing list's size in practice and the pool's cap; it keeps the policy's lines short.
- Spelling counts: macOS finds `Pat` for `pat`, but Screen Sharing's list and the login list use the real name. So the install and `taskbox check` read each account's `RecordName` and fail with the real spelling when it differs.

These checks need the box, so the install and `taskbox check` run them, never `loadConfig`:
- No role names an admin account.
- service and agent are standard accounts.
- Each person in `people` exists and is standard.

## 2. Accounts taskbox makes and manages

### service

Constraints:
- The loop runs in the service account's GUI login session. Its LaunchAgent is `LimitLoadToSessionType Aqua` (read: `launchd/local.taskbox.loop.plist`), and Tart runs VMs from that session.
- With FileVault on, the service account must be able to unlock the disk, so a restart takes one password (read: `ciUnlocksDisk`, `taskbox unlock`).
- A user made with `sysadminctl` and no admin credentials gets no secure token (read: the comment above `MAKE_CI`).

Design (the install, as root, at the box):
1. If `accounts.service` exists: check it is standard, as today's `ensureCiUser` does, and use it. A box from before v2.7.0 takes this path, with `ci`.
2. If it doesn't exist, ask:
   > "taskbox makes the account <name> to run jobs. Type yes to make it."
   On yes, run `sysadminctl -addUser <name> -fullName "taskbox" -password -`, so sysadminctl asks for the new password itself, at the terminal, and it is never on a command line. Not checked: that `-password -` prompts, and doesn't echo.
3. Then give it the disk unlock with `fdesetup add -usertoadd <name>`, as `taskbox unlock` does today. fdesetup asks for an admin's name and password, then the new password. Read: `src/ops.ts` `unlock`. Not checked: that this also gives a secure token to a user `sysadminctl` made with no admin credentials, on macOS 27. The Tart test checks it. Its fallback is today's step: the owner makes the account in System Settings, and the install says so in one line.
4. Record that taskbox made it, in `/opt/taskbox-state/accounts.json` (root's, 0644): `{ "made": { "service": "<name>" } }`.

What the owner still types:
- the service password, twice (sysadminctl's prompt);
- an admin's name and password, and the service password again (fdesetup's prompts);
- after a restart, the service password once, at the FileVault screen.
No other password.

### agent

The agent account never logs in at the screen, and Tailscale SSH in accept mode needs no password. Design:
1. If `accounts.agent` exists, check it is standard and place it as `placeRemote` does today. Its shell becomes taskbox's (`REMOTE_SHELL`), and its home becomes an empty folder of root's, `/private/var/taskbox-<agent>`. Read: `src/install.ts` `placeRemote`.
2. If it doesn't exist, make it with `dscl`, as #19 makes its accounts: `Password "*"` (no password works) and `IsHidden 1` first, then taskbox's shell, the empty home, a hidden user ID from 470 to 499, and the staff group. Nobody logs in as it at the screen, and Tailscale SSH in accept mode needs no password, so it has none.
3. Record it in `accounts.json` as made, with its user ID and GeneratedUID, as soon as the record exists.

The owner types nothing for the agent.

### people

taskbox never makes, changes or deletes a person's account. It reads them: they must exist and be standard, or `taskbox check` says which one isn't.

Screen Sharing's list of allowed users (the `com.apple.access_screensharing` group) is set by the install from `people`, after the yes, each change listed before it. taskbox records whom it added, and remove takes back only those. Anyone else on the list is left, and the check row names them. Not checked: that changing the group with `dseditgroup` is what System Settings shows and macOS enforces. The Tart run checks it.

### remove

`taskbox remove` keeps #27's rules: at the box only, sign out, and keep the command if tailscaled sticks. Then:
- It offers to delete the accounts that `accounts.json` says taskbox made, one question each, saying what goes:
  > "Delete the account taskbox (its home, with the downloaded images, about N GB)? Type yes to delete it."
- Deletion runs `sysadminctl -deleteUser <name>`.
- It never offers to delete an account taskbox didn't make, a person's, or an admin's.
- A box from before v2.7.0 made `ci` by hand, so remove says to delete it in System Settings, as today.

## 3. `taskbox policy`

`taskbox policy` prints the tailnet policy JSON for this box, generated from the settings, to paste into the admin console. It writes nothing to Tailscale: taskbox holds no Tailscale API key, and the owner applies the policy (#10's rule).

Inputs:
- `accounts`, the tag (`tailnetTag`, default `tag:taskbox`), and the ports (22, 5900);
- the owner's Tailscale login, given as `--owner <login>` or left as the placeholder `OWNER`. It is never stored or logged;
- the box's admin accounts, read from the `admin` group when run at the box, or `--admin <name>`, repeatable.

Output: one JSON document, the same shape as today's doc. Read: `docs/tailnet-policy.md`.
- `tagOwners`: the tag, owned by the owner alone.
- `grants`: the owner's own devices to each other; the owner to the tag on 22 and 5900.
- `ssh`:
  - `accept` for the agent, if there is one. The workspace accounts join once #19's install makes and restricts them;
  - `check` for each person in `accounts.ssh`, if there are any (empty by default; the owner's decision, 20 Nov 2026);
  - nothing else.
- `sshTests`:
  - the agent accepted;
  - each person in `accounts.ssh` checked;
  - `deny` for root, the service, every other person and each admin.
- `tests`: 22 and 5900 reach the tag, and the tag reaches none of the eight owner ports.

Pure function: `policyFor(settings, { owner, admins }) → object`. `taskbox policy` prints it with sorted keys, so the same settings always give the same bytes.

`docs/tailnet-policy.md` keeps its prose: why each rule, how to apply it in two steps, and box loss. Its JSON block becomes generated. A unit test rebuilds it from `taskbox.example.json` with `--owner OWNER --admin ADMIN`, and fails if the doc differs. The hand-edited copy goes.

## 4. The upgrade from today's box

Today's box has `ci` (made by hand, the disk unlock given), `remote` (placed by taskbox), and a person's account in `screenSharingUsers`.

- **Settings.** The box's own `taskbox.json`, in the release's commit, changes:
  - `remoteUser` and `screenSharingUsers` go;
  - `"accounts": { "service": "ci", "agent": "remote", "people": [<the person>] }` comes in.
  Nothing is renamed on the box.
- **The update to v2.7.0 is run by v2.6.x's code** (as with the labels in v2.3.0). That code reads the new `taskbox.json` with its own `loadConfig`, which ignores `accounts`. It falls back to `remote` and an empty Screen Sharing list. Read: v2.6 keeps `cfg.remoteUser ?? DEFAULT_REMOTE_USER` and `screenSharingUsers ?? []`.
  - So that update places `remote` as before. Its Screen Sharing row may fail until the next check by the new code. Not checked: the exact line it prints. The Tart test checks it.
  - To keep that update clean, the box's `taskbox.json` also keeps `screenSharingUsers` for one release, beside `accounts`. `loadConfig` accepts the two together only when they agree, and refuses them when they differ. v2.8.0 drops the old key.
- **Paths** come from `accounts.service`: `/Users/<service>`, its `~/.taskbox`, and Tart's home. For `ci` they are what they are today, so no state moves.
- **No account is made.** `ci` and `remote` exist, and `accounts.json` doesn't. So remove keeps today's line for `ci`, and treats `remote` as placed, never made.
- **The policy.** `taskbox policy` for today's settings gives the same rules as today's doc, with `remote` and `ci` named from the settings. A test compares the two. They match only when `accounts.ssh` names the person; otherwise the person loses the `check` rule, and the README's step for v2.7.0 says to replace taskbox's entries in the console.
- **Changing a name on a running box.** The install refuses a new `accounts.service` while the old service's state exists: the line says the state would be left behind, and to remove first. A new `accounts.agent` is placed, and the old agent account keeps taskbox's shell. `taskbox check` names it, and remove offers it only if `accounts.json` says taskbox made it.
- **Undo** to v2.6.x: the kept install reads its own `taskbox.json`. The names are the same, so nothing on the box changes. A fresh v2.7.0 box has no earlier install to undo to.

## 5. Testing in isolation

- **`src/access.ts`, pure, with no Sys:**
  - `validateAccounts(raw) → Accounts | Error`;
  - `peopleProblem`, `agentProblem`, `serviceProblem`, each given account facts (exists, admin, shell, home) and returning a line or nothing.
  - Table-driven tests cover case-folding, reserved names, duplicates, and old keys. A key the release doesn't know is passed over, so a box reads a newer release's block during its update; a test holds the repo's own `taskbox.json` to the known keys, so a typo fails before any release.
- **`src/policy.ts`, pure:**
  - `policyFor(settings, { owner, admins })`;
  - fixtures: the example settings; no agent; no people; two people; a custom tag. Golden JSON files are in `test/fixtures/policy/`.
  - The doc's JSON block is rebuilt and compared.
  - Its own tests: each `ssh` rule has its matching `sshTests` line; root, the service and admins are always denied; no rule allows `autogroup:nonroot`.
- **`src/accounts.ts`, with the fake Sys:**
  - make the service account: the exact `sysadminctl` and `fdesetup` calls, with no password in any argument;
  - make the agent account, with its password on stdin;
  - place it;
  - write and read `accounts.json`;
  - remove's offers.
- **On a Tart test Mac (later):**
  - a fresh install making both accounts;
  - FileVault unlock by the made service account (not checked: whether a Tart Mac can turn on FileVault; if not, that step runs on a spare Mac);
  - remove deleting them;
  - today's box updated, with nothing renamed.

## 6. Scenarios

1. **A fresh box.**
   - The owner fills `accounts` from the example, or keeps its defaults (`taskbox`, `taskbox-agent`, no people), and runs `install.sh`.
   - The install makes `taskbox` (the owner types its password twice, then the admin's and its own for the disk unlock) and `taskbox-agent` (nothing typed).
   - It says to log in as `taskbox`.
   - `taskbox policy` prints the policy to paste.
   - Screen Sharing stays off: there are no people.
2. **Today's box.**
   - One update: the settings already name `ci` and `remote`, so nothing is made or renamed.
   - `taskbox check` reads the roles from `accounts`.
   - `taskbox policy` matches today's policy only if `accounts.ssh` names its person. With no `accounts.ssh`, the person loses the `check` rule, and the README's step for v2.7.0 says to replace the console's entries.
3. **A box with no person accounts.**
   - `people: []`. The policy has no `check` rule.
   - The Screen Sharing row fails while Screen Sharing is on, as today: "taskbox.json names nobody for it".
4. **An agent tries an admin action.**
   - Over Tailscale SSH as the agent, `taskbox update` is refused by the restricted shell.
   - `sudo` isn't reachable: the shell runs only taskbox.
   - An `ssh` as an admin, the service or root is refused by the policy, and `sshTests` proves it.
5. **Two people.**
   - `people: ["pat", "sam"]`. Both are allowed Screen Sharing; the Screen Sharing row checks that exactly those two are allowed.
   - With `ssh: ["pat"]`, the policy has one `check` rule naming pat, and sam is denied SSH.
   - Each sees counts, never the other's name, as people do today.
6. **A person's name collides with the service** (`people: ["Taskbox"]`): `loadConfig` refuses it, ignoring case.
7. **The owner names an admin as a person.** The install leaves it unplaced and `taskbox check` fails: "<name> is an admin; a person's account must be standard".

## 7. Owner steps, and what it does not do

### A fresh box, one step at a time

1. In your copy of taskbox, set `accounts` in `taskbox.json`, or keep the example's.
2. At the box, as your admin user: `sh ~/Downloads/taskbox-main/install.sh`. Before it signs the box in, it prints the `tagOwners` entry: save that in the admin console first.
3. When it asks, type yes to make the service account, then its password twice.
4. When fdesetup asks, type your admin name and password, then the service password.
5. Type yes to the release.
6. Log out, and log in as the service account.
7. At the box: `taskbox policy --owner <your Tailscale login>`, then add the entries it prints in the admin console, in the doc's steps.

### Today's box

1. `taskbox update`.
2. `taskbox check`: every row should say OK.

### What it does not do

- It doesn't apply the tailnet policy: the owner pastes it. taskbox holds no Tailscale key.
- It doesn't make, change or delete a person's account.
- It doesn't rename an account on a running box.
- It doesn't remove the FileVault step: macOS asks for an admin's password to give the disk unlock.
- It adds no second service account or trusted box. Jobs that hold secrets stay off the box (README).
- The guest account stays the image's.

## 8. Where it touches other code

- `src/config.ts`: the `accounts` type and validation; paths from `accounts.service`. `CI_USER` goes.
- `src/install.ts`: `ensureCiUser` becomes `ensureService`, `placeRemote` becomes `placeAgent`, and `accounts.json`.
- `src/checks.ts`: every literal `"ci"` and `/Users/ci`, the Screen Sharing rows, `remoteUserRow`, `otherUsers`, `ciUnlocksDisk`.
- `src/ops.ts`: `unlock`, `remove`'s offers, and the uses of `CI_USER` in status.
- `src/cli.ts`: `ciUid()`, the service-only commands, and `taskbox policy`.
- `src/actionskey.ts`: the ACL names the service.
- **`src/loop.ts`, in two places only:**
  - the import of `CI_USER`;
  - `beside = logins.users.filter((u) => u !== CI_USER)`.
  Both become `cfg.accounts.service`. A one-line change each, which can merge after core's v2.5.0 work with a trivial conflict at most.
- Tests: about 60 places across 11 files name `ci`, `remote` or a person. They switch to the example's made-up names.
