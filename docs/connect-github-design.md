# `taskbox connect github`: design

Status: design, for review. Facts are labelled: **read** (in the code or GitHub's docs), **ran**, or **not checked**. Based on #31's branch (`taskbox/v2.7.0-access`). The release it ships in is the lead's to name.

## 1. Outcome

The owner's words: "i want connect and i want it to be implemented properly".

Today a box reads which jobs wait through a second GitHub App, the job source (`sources` in `taskbox.json`, read: `src/config.ts` `checkScheduling`). The owner makes that App by hand in GitHub's settings, copies its ID into a PR, downloads its key to Downloads, and types `taskbox update` so the install can prove and place the key (read: `src/actionskey.ts` `placeActionsKey`). The README has seven steps for it.

After this change:
- At the box, as an admin: `taskbox connect github`.
- Two clicks in the browser: Create, then Install.
- No ID or key is copied by hand. No PR or release is needed for one box's job source.
- The source is written to the box's own settings file, on the box.

## 2. The flow

`connect` is a root command (it joins `ROOT_COMMANDS`, so an admin's `taskbox connect github` re-runs through `sudo`; read: `src/elevate.ts`). It refuses over SSH, as `remove` does (read: `src/ops.ts` `cameOverSsh`). It needs the service account and the first App, so it runs on an installed box.

### Step 1: make the App (GitHub's App manifest flow)

1. taskbox makes a state token (32 random bytes, hex).
2. It listens on `127.0.0.1` only, on a port the system picks, for two requests at most: one `GET /start` and one `GET /done`. It stays open until `/done` comes, the owner presses Ctrl-C, or an hour passes (the code's own life on GitHub). Then it closes.
3. It opens `http://127.0.0.1:<port>/start/<page token>` in the admin's browser, as the admin. It also prints the URL.
4. `/start` serves one page with a form that posts itself to `https://github.com/organizations/<org>/settings/apps/new?state=<state>`. The form has one field, `manifest`, holding (read: GitHub's "Registering a GitHub App from a manifest"):
   ```json
   {
     "name": "<box name> jobs",
     "url": "https://github.com/<org>",
     "hook_attributes": { "url": "https://github.com/<org>", "active": false },
     "redirect_url": "http://127.0.0.1:<port>/done",
     "public": false,
     "default_permissions": { "actions": "read", "metadata": "read" },
     "default_events": []
   }
   ```
   `<box name>` is `runnerNamePrefix`. App names are unique on all of GitHub; if it is taken, GitHub's page says so and the owner can change it there (not checked).
5. The owner clicks **Create GitHub App** (click one). GitHub redirects to `/done?code=<code>&state=<state>`.
6. taskbox checks the state, then posts `POST /app-manifests/<code>/conversions` (no auth; the code is single-use and lasts an hour; read). The answer holds the App's `id`, `slug`, `owner`, `permissions`, `events`, `pem`, `client_id`, `client_secret` and `webhook_secret`.
7. It checks the answer before it keeps anything:
   - `owner.login` is `org`;
   - permissions are exactly Actions read and Metadata read;
   - no events.
   If any fails, it keeps nothing and says what GitHub made, so the owner can delete it.
8. The App is recorded at once, before anything else. Its private key goes into root's keys folder as `actions-key.pending.pem`, root's own at 600, beside the key in use, which it doesn't touch. It is never written to Downloads. The client secret and webhook secret are dropped, never written or logged.

### Step 2: install it on the jobs repo (click two)

1. taskbox opens `https://github.com/apps/<slug>/installations/new` in the admin's browser. GitHub's page lets the owner pick the org and repositories. The line says to choose "Only select repositories" and `jobsFrom` alone. A pre-selected repo through `suggested_target_id` and `repository_ids[]` is not checked, and isn't relied on.
2. The owner clicks **Install** (click two).
3. taskbox waits up to 10 minutes, asking every 5 s with the App's JWT: `GET /app/installations`. Once there is one, it runs today's proof (`proveActionsKey`):
   - one installation, on `org`, as selected repositories;
   - a token's repos are exactly `jobsFrom`;
   - the rights are Actions read only;
   - the token is revoked after.
4. If the proof fails because the owner picked more repos or "All repositories", it says which, and waits again. The owner changes it in the App's settings, and the next poll passes. GitHub sends no redirect after the install, since the manifest names no `setup_url`; taskbox needs none.

### Step 3: keep it

1. Only now, with the installation proved: the pending key becomes the key in use (the service's, 600, renamed over the old one), then the source goes into the box's own settings (section 3): `{ "type": "github-actions", "appId": <id>, "repos": [jobsFrom], "app": "<slug>" }`. Then the pending record goes.
2. It restarts nothing itself. The loop restarts as for an update, once no job runs, and reads the new settings at its start. The loop already restarts when its `updated()` signal says so: the installed commit changed, or `relabel()` (read: `runLoop` in `src/loop.ts`). `cli.ts` builds `relabel`, so it adds "box.json changed since the loop started" to it there. `src/loop.ts` doesn't change.
3. It says: "Connected: App <slug> reads the queue of <jobsFrom>. taskbox check shows it."

## 3. Box-local settings

### The file

`/opt/taskbox-state/box.json`:
- root's, 0644, in root's `/opt/taskbox-state` (755);
- outside every install folder, so an update or undo never changes it;
- written whole and renamed into place, as the accounts record is;
- read with `readStateJson` (no link, one name, size cap; read: `config.ts`).

The service and every user can read it. It holds no secret: an App ID, a repo, a slug.

### Layering

`loadConfig(dir)` reads the release's `taskbox.json`, then the box file, then checks the result as one. Each key is in one of two classes:
- **Product keys:** only in the release's `taskbox.json`. Every key but `sources`: the image pins, labels, classes, timings, `org`, `repo`, `appId` (the first App), `runnerGroup`, `jobsFrom`, `project`, `accounts`, `runnerNamePrefix`, `vmsAtOnce` and the rest.
- **Local-only keys:** only in the box file. This is `sources`, the one key taskbox writes there. A release's `taskbox.json` that has `sources` (or `actionsAppId`) is still read, for one release, so boxes from before keep their source. Once a box file has `sources`, the release's are ignored, and `taskbox check` says the source is the box's.

A box file with any other key is set aside, and the release's settings are used alone. `taskbox check` and the update say so, with one fixed line: type `taskbox connect github`, or `taskbox disconnect github`. Either writes `{ sources }` alone, which clears it.

## 4. Running it again, and disconnect

- `taskbox connect github` on a connected box first proves the App in place. (A box with today's setup and no box file is adopted, as section 4a says.) If it passes, it says so and asks:
  > "Type replace to make a new App and drop this one's key, or anything else to keep it."
  replace runs steps 1 to 3 with a new App. The key and source in use stay until the new App's installation is proved. To keep the same App and give it a new key, use `--new-key` (section 4b).
- If the App in place fails its proof (deleted on GitHub, uninstalled, rights changed), connect says why and offers to replace it.
- `taskbox disconnect github`:
  - removes the source from `box.json` and deletes the key;
  - asks nothing more, after one yes;
  - says: "GitHub keeps the App <slug> until you delete it: <org>'s Settings, Developer settings, GitHub Apps, <slug>, Advanced, Delete."
  - The box then follows the jobs its VMs take (read: `source.ts`, no source).
- `taskbox remove` removes `box.json` with the rest of `/opt/taskbox-state`, and says the same about the App.

## 4a. Adopting today's setup

The owner keeps today's App (#32's source, its key placed by hand with v2.4.1). Adopting it makes no new App and needs no hand step.

What "today's setup" is (read):
- the release's `taskbox.json` has `sources: [{ type: "github-actions", appId, repos: [jobsFrom] }]`;
- the key is at `/opt/taskbox-keys/actions-key.pem`, the service's, mode 600, and `actionsKeyProblem` passes.

### Adopted by the update itself

1. On every install from this release on, after the key step and before the swap, the install looks at three things:
   - whether the box file has no `sources`;
   - whether the release's `taskbox.json` has a github-actions source;
   - whether the key in place passes `proveActionsKey` for that App ID.
2. If all three hold, it writes that source into `box.json`, and adds `app` (the slug, from `GET /app`).
3. The summary before the yes says: "It also keeps the job source App <slug> in this box's own settings."
4. Nothing else changes. The loop reads the same source, now from the box.
5. If the key fails its proof, nothing is adopted, and the line says why, as today's update does.

`taskbox connect github` on such a box does the same on demand: it finds the source and key, proves them, writes `box.json`, and says "Connected: the App <slug> you already had".

### The release that drops it from the repo

1. Release N (this change) adopts on update, as above, and still carries `sources` in `taskbox.json`.
2. Release N+1 drops `sources` from the repo's `taskbox.json`.
   - Its install refuses to go on while the box file has no source and the release before had one, so a box can't lose its source by skipping a step: "Type taskbox update to release N first, or taskbox connect github".
   - A box on N has adopted, so N+1 changes nothing for it.
3. `taskbox check`'s job source row says where the source comes from: "from this box's settings", or "from the release's taskbox.json, until the next update keeps it on the box".

## 4b. A new key for the same App

GitHub's API can't make an App key: keys are made on the App's settings page only (read: GitHub's "Managing private keys for GitHub Apps"). So a new key for the same App takes the owner's click, and a browser saves the file to its download folder; taskbox can't change where.

`taskbox connect github --new-key`:
1. Opens the App's settings page: `https://github.com/organizations/<org>/settings/apps/<slug>`.
2. Says: "Open Credentials, then Key pairs, and generate a new private key. taskbox takes the file as soon as it's saved." (read: the App's page puts keys under Credentials, then Key pairs; the button's wording varies.)
3. Watches the admin's Downloads for 10 minutes for one new file ending `.private-key.pem`, made after the command started. Within a second of it appearing, it reads it as today's code does (no link, one name, size cap), proves it is this App's key with these rights, places it, and deletes that file (same device and inode). The file is in Downloads for about a second, and never in a release, a PR or the terminal.
4. Says: "On the same page, delete the old key: Credentials, Key pairs, the older one, Delete." GitHub's API can't delete it either. taskbox shows the old key's SHA-256 fingerprint, as GitHub's page lists it (not checked: GitHub shows the same form of fingerprint), so the owner deletes the right one.
5. If no file comes in 10 minutes, nothing changes, and the old key stays in use.

The way with no file at all is `replace` (section 4): a new App by manifest, whose key comes in GitHub's answer. `--new-key` is for keeping the same App.

## 4c. The test repo

v2.6.0's load test has one test repo in the source's `repos` (docs/load-test-design.md). Once the box keeps its own source, the release's `repos` no longer reach it, so the box's file is the one place, with one writer:
- `taskbox connect github --load <org/repo> <runner group>` writes `{ name, role: "load", runnerGroup }` beside `jobsFrom`. It runs the settings check on the result, then proves the App against it: on `jobsFrom`, maybe on the test repo, on no other. A box whose source is still the release's is adopted with it.
- `taskbox connect github --load off` takes it out. The proof refuses while the App is still on the test repo, so the order the App check needs (off the App first) is kept for the owner.
- Adoption copies the release's `repos` as they are, and a replace keeps the box's test repo when it moves the source to the new App.

Threat model: an admin at the box, as root, can let the read-only App read one more repo, in the same organisation, with its own runner group, never `runnerGroup`. The App's rights stay Actions read. The proof still refuses an App on any repo not named. Nothing new holds a secret. Needs an independent security review with the rest of #34.

## 5. From the laptop controller

The controller (#12) reaches the box over Tailscale SSH as the agent, in taskbox's restricted shell. The tailnet policy refuses admins over SSH (read: `src/policy.ts`). That is by design: no root path over SSH. So `connect`, a root command, can't run from the laptop's SSH session.

How it works from the laptop:
- **Now:** over Screen Sharing. The owner keeps the admins' Screen Sharing for remote admin work (#31), over Tailscale only. The controller's `taskbox connect <box> github`:
  - opens a Screen Sharing session to the box;
  - shows the one line to type there: `taskbox connect github`.
  The browser that opens is the box's, and the listener stays on the box's 127.0.0.1.
- **Later, if wanted:** a request the agent may leave and root acts on, as #19's approvals do. The controller would leave "connect github requested"; the owner approves at the box; root runs the flow. That needs its own design and threat model, and isn't part of this change.
- The laptop never holds the App's key or the manifest code.

## 6. Threat model

- **The listener.**
  - It binds 127.0.0.1 only, so the tailnet, the LAN and the VMs can't reach it. VMs reach the host only through Softnet's gateway; 127.0.0.1 is the host's own (read: `docs/vm-engines.md`; not checked for this port).
  - It lives an hour at most, answers two requests, and closes. Ctrl-C on `taskbox connect` reaches it as SIGTERM, which sudo passes on; any other end of connect leaves it to its timeout.
  - Another local user on the box could reach it while it is open. `/start` answers once, and `/done` needs the state token. A stolen state lets someone post a code for an App of their own. That App is refused: its owner isn't `org`, or it isn't installed on `jobsFrom`. The proof's checks hold whatever App is offered.
  - The page has a `Content-Security-Policy` that allows only the form's post to github.com, and `Cache-Control: no-store`.
- **The code.** Single-use, and one hour on GitHub's side (read). taskbox exchanges it once and never logs it.
- **The key.** It goes from GitHub's answer straight into `writeKey`: O_EXCL, O_NOFOLLOW, root's 700 folder, the service's 600 file, flushed, then renamed. `log.secret` covers it, the JWTs and the tokens. The client and webhook secrets are dropped.
- **The App's rights.** Checked twice: in the conversion's answer, and by `proveActionsKey` on the installation. Exactly Actions read and Metadata read, no events, one installation on `jobsFrom` only. The box's update proves it again each time, as today.
- **The box file.** Root's, so only an admin changes it. Product keys are refused in it, so a box can't move its own image, labels or first App. It holds no secret.
- **Over SSH.** Refused, as `remove` is. No agent can start it.
- **What a stolen key gives.** Actions read on one repo, and the App's webhook settings through its JWT (`PATCH /app/hook/config`), never its rights. The App can't push, open PRs or read code. replace and disconnect uninstall the old App with its own JWT before its key goes, so an old copied key reads nothing.
- Section 11 changes the listener, the browser, the key files and disconnect; it is part of this threat model.

## 7. Testing

- **Unit tests with a fake GitHub (`test/connect.test.ts`):**
  - the manifest's exact JSON;
  - the state check;
  - the conversion's checks (owner, rights, events);
  - the key placed with no temp file;
  - secrets dropped;
  - the install wait, with a proof that fails, then passes;
  - replace, keeping the old key until the new one passes;
  - disconnect;
  - the box file's layering and refusals.
- **The listener, against a real `Bun.serve` on 127.0.0.1 in the test:**
  - two requests at most;
  - a wrong state refused;
  - the timeout closes it;
  - no other address answers.
- **On a Tart test Mac (the lead's warm environment):**
  - `connect` with GitHub faked by `fakegh.ts`;
  - the listener at 127.0.0.1 as root;
  - the browser opening in the admin's session;
  - the files and their modes;
  - disconnect, and remove.
- **Only a real GitHub can prove, at the owner's first real run:**
  - that GitHub accepts a `redirect_url` on `http://127.0.0.1:<port>`;
  - the org manifest path;
  - what the page does with a taken name;
  - the conversion's answer on this account;
  - how soon an installation shows in `GET /app/installations`;
  - that an org owner's two clicks are all it takes.
  If the redirect to 127.0.0.1 is refused, the fallback is a page that asks the owner to paste the code. That is one hand-copy, so the design treats it as a failure of the outcome, and asks the owner.

## 8. Owner steps

1. At the box, as your admin user: `taskbox connect github`.
2. Safari opens at the box. If it shows GitHub's sign-in, sign in there, as an owner of the organisation. This is the one place you sign in.
3. Click **Create GitHub App**.
4. On the next page: choose Only select repositories, pick the jobs repo, click **Install**.
5. Back in Terminal it says Connected, and asks you to sign out of GitHub in that Safari window. `taskbox check`'s job source row says OK.

## 9. What it does not do

- It doesn't make the first App (the runners'): that stays the install's step.
- It doesn't delete an App on GitHub: GitHub's API has no call for that with these rights.
- It doesn't run over SSH or from an agent.
- It moves no other key to the box file: every key but `sources` is the release's (section 3).

Signed: a taskbox agent

## 10. The runner group's runners

`taskbox check` and `taskbox away` read the box's runner group and its runners: three reads with the runner App's token, no writes. The row fails on a runner whose name lacks the box's runner prefix, or one with a label the box's settings don't name, and names each.

This relies on what the lead saw on GitHub (ran, against a throwaway runner group on taskbox's own repo): a JIT runner's labels are exactly the ones it was registered with, with no implicit labels. A JIT runner registered with `ubuntu-latest` got no `runs-on: ubuntu-latest` job in two tries of three jobs each; they went to hosted runners within 2 s. So the box's own runners carry only its labels, and any other label in the group is someone else's doing.

Which workflows the group allows is the owner's to set on GitHub. Keeping that list from the box is a separate change, on its own branch (docs/runner-group-workflows-design.md there).

## 11. One key folder for both Apps

The runner App's key moves to `/opt/taskbox-keys/runner.pem`, beside the job source App's. One function, `takeDownloadedKey`, serves the first install, the update and `connect github --new-key`:
- It reads one `*.private-key.pem` from the owner's Downloads, as `keyFromDownloads` does (no link, one name, a size cap, a key).
- It asks `GET /app` with a JWT for each of the box's App IDs in turn. A 200 naming that ID says which App's key it is. A source key then gets today's proof of its rights.
- Only a 401 from every ID refuses the key, and the line says to delete it. Any other answer stops with nothing changed and never says to delete it.
- No key, or Downloads that can't be read, is no key: an update uses the keys in place. A first install stops, since it has none.

A proved key is written with `writeKey` into root's folder, the service's at mode 600, and the download is deleted by device and inode. That happens before the yes when the service exists, and after the files when the install makes the service. So a revoked key in place never stops the update that brings its replacement. Root never writes in the service's home: the first update reads `~/.taskbox/app-key.pem` once, as before, and copies it to `runner.pem`. The old copy stays for `taskbox undo`, whose release reads only that file.

Threat model:
- Asset: the runner App key (org self-hosted runners write) and the source key.
- A wrong key can't be placed: it must get a 200 from `GET /app` as one of the box's App IDs.
- A fault on the way to GitHub can't make taskbox tell the owner to delete a good key: only a 401 from every ID refuses.
- A key is written only into root's folder, and only once the service exists, so the chown and the ACL name a real account. The folder stays root's at 700 with the service's search ACL. The service already held both keys, so it gains nothing.
