# taskbox

taskbox runs a Mac, the box, as a GitHub Actions runner host: one fresh Tart VM per job, deleted after it.

This is taskbox's public home, from v2.6.1. It holds no box's settings. MIT licensed ([LICENSE](LICENSE)); Tart, Softnet and Tailscale come under their own licences ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).

What it promises, what it never does, and how we work: [docs/PROJECT.md](docs/PROJECT.md).

## What taskbox is for, and not for

A box runs CI jobs that hold no secrets. It also runs open-ended work beyond CI, so every job on it is untrusted code:
- A box never runs a job that holds secrets: no deploy keys, no signing keys, no release tokens, no environment secrets.
- Jobs that need secrets stay on GitHub's hosted runners.
- Set the box's runner group to allow only the workflows meant for the box. taskbox checks that the group lists one repo; which workflows it allows is yours to set.
A future major version may add a separate trusted box, on its own hardware, for jobs that hold secrets.

One box's settings are in `taskbox.json`: the GitHub organisation, the App, the runner group, the one repo whose jobs it runs and the project name. This repo has no `taskbox.json`. `taskbox.example.json` shows the shape with made-up values. Keep your `taskbox.json` in your own private copy of taskbox: the box installs from that copy, and `install.sh` stops if it has none.

Nothing here reaches the box until the owner installs it at the box's keyboard. The install takes only a release whose commit is a PR merged on `main`. It shows its PR number, title, merge date and seven characters for a yes first.

## A new owner

taskbox is general: nothing in its code names an organisation, a repo, an App or a person. To run your own box:
1. Make a private copy of this repo in your organisation, named `taskbox`. Set the owner in `.github/CODEOWNERS` to your own GitHub account.
2. Make a GitHub App in that organisation: Repository permissions Contents read-only, Organization permissions Self-hosted runners read and write. Install it on your copy of taskbox. Its ID is `appId`.
3. Make a runner group, limited to selected private repos, that lists the one repo whose jobs the box runs: `runnerGroup` and `jobsFrom`.
4. Build tailscaled with `.github/workflows/build-tailscale.yml` (`docs/build-tailscale.md`), publish it on a release of your copy, and pin its asset ID and SHA-256 in `versions.json`.
5. Copy `taskbox.example.json` to `taskbox.json` and fill in your own values. Leave out `previousLabelPrefix`: it is only for a box first installed under other launchd labels. Connect a job source later, if you want one.
6. Merge a PR and publish the first release (a tag such as `v2.3.0` on a commit on `main`). Then follow the next section at the box.
A setting the install refuses is named in one line, with the field to fix.

## Set up the box

At the box, about twenty minutes, connected by Ethernet. On your release's GitHub page, note its tag, such as `v2.5.0`, and its commit's seven characters. The install's screen shows them as `Release:` and `Commit:`.

1. Open a Private window in Safari (File, New Private Window). Sign in to GitHub. For the second step, use whichever GitHub asks for: your passkey, or the code from your app. If it's a passkey on a phone, turn Bluetooth on at the box first, in Control Centre. Don't save the password.
2. Open this page in that window, then use the two links:
   1. Your GitHub App's page: your organisation's Settings, Developer settings, GitHub Apps, then the App whose ID is `appId`. Open the Credentials tab, then Key pairs, and click "New key". Safari saves the key in Downloads, as a file ending in `.private-key.pem`.
   2. Download taskbox: `https://github.com/` then your `org`, `/taskbox/archive/refs/heads/main.zip`. The repo is named `taskbox`, so the folder is `taskbox-main`. If Safari asks whether to allow downloads from github.com, click Allow. Safari unpacks it into a `taskbox-main` folder in Downloads. If Downloads shows `taskbox-main.zip` instead, double-click it.
3. Open Terminal and type `sh ~/Downloads/taskbox-main/install.sh`. It asks for your admin password.
4. It checks the box, then shows the `Release:`, its PR, its merge date and its `Commit:`. It also says it makes the service account, named in `accounts.service` (`taskbox` in the example settings). If the release and the seven characters match your release's page, type `yes`. Anything else stops it with nothing installed.
5. It makes the service account: type a password for it twice, and keep it, since you type it after every restart. Then macOS asks for your admin name and password, and the service account's password again, so it can unlock the disk. It makes the agent account (`accounts.agent`) too, with no password, and says its name: a laptop pairs with that name.
6. Before it signs the box in to Tailscale, it prints the `tagOwners` entry: add it in the admin console and save (docs/tailnet-policy.md). Then close the Private window. That signs the box out of GitHub. If you turned Bluetooth on, turn it off.
7. When it says "Now log in as" the service account, log out and log in as it. macOS shows its new-user screens: skip each one, and for Apple Account choose "Set Up Later". Click Allow if macOS asks about the local network. If macOS says a background item was added (it may name "bun"), that's the box's loop: leave it on. Leave the box like that.

Done: as the service account, type `taskbox status -w` in Terminal and leave it open. It shows the 77 GB download of macOS 27 with Xcode 27.2 as it goes, then what the box is doing. Use Ethernet: taskbox check --away fails on Wi-Fi, and a phone hotspot can use up the phone's data. Then type `taskbox check`: every line should say OK. A FAIL line has its fix on it.

### Your first job

In the repo whose jobs the box runs, a workflow job like this one runs on the box:

```yaml
jobs:
  test:
    runs-on: taskbox-macos   # or taskbox-linux
    timeout-minutes: 30      # at or under your jobTimeoutMinutes
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@08eba0b27e820071cde6df949e0beb9ba4906955 # v4.3.0
      - run: echo "on the box"
```

A box job names its kind's label, never the runner group alone or a bare `self-hosted`. It holds no secrets. `taskbox template show test-job` prints a working job made from the box's own settings.

## What you see at the box

`taskbox status -w` redraws every two seconds. Ctrl-C stops watching; the box carries on. Its first line is always the download:

- While it downloads: `Downloading macos-golden-gate-xcode 27.2: 34.7 of 77.0 GB (45%), 12.4 MB/s, about 58 min left.` If the network dropped and Tart carried on, it says so. After a restart Tart counts up from 0 again, so until it gets back there the line says: `It stopped at 45% (34.7 of 77.0 GB). Checking what is already on disk: 20.1 of 34.7 GB checked.` The parts Tart was fetching when it stopped come again over the network, at most 2.15 GB of this image, and the line says how much: `Fetched again: 0.4 GB.`
- If nothing arrives for two minutes: `No progress for 3 min. Check the box's network: it carries on by itself when the network is back.`
- If the download stopped: `The download ... stopped at 45%: <reason>. It tries again within a minute and carries on from where it stopped.`
- When it's done: `Image ready: macos-golden-gate-xcode 27.2.`

Then the loop (running, or how to start it), the VM (starting, waiting for a job from GitHub, running a job and its name, deleting the VM after its job), the checks (all OK, or which one failed), and the last job.

### Seeing the box's screen from your laptop (optional)

Screen Sharing is off on a new box, and taskbox names nobody for it by default: a new box's `taskbox.json` has `accounts.people` empty. To use Screen Sharing:

1. At the box, as your admin user, make an account for yourself: System Settings, Users & Groups, Add User. Choose Standard, never Administrator. Use any name.
2. Tell the agents that name. They make a PR that adds it to `accounts.people` in `taskbox.json`, and a release once you merge it. Then type `taskbox update` as your admin user. Before the yes it says it lets that account use Screen Sharing; after it, Screen Sharing's list of allowed users has that account and the admins, through the Administrators group macOS puts on the list.
3. In System Settings, General, Sharing, turn on Screen Sharing.
4. As the service account, type `taskbox check`. A pass: `OK   Sharing services off: only Screen Sharing, for` that name, `over Tailscale`. A FAIL line names what to change.

From your laptop, connect to the box over Tailscale, by the name `runnerNamePrefix` gives it, as that account.

## Commands at the box

The box is always in one state: Stopped, Downloading, Ready, Running, Updating, Needs you or Failing. Every command ends with three lines: `Now:` the state, `Did:` what changed, `Next:` one step. Needs you names something only you can do. Failing means agents have work to do and you don't.

As the service account:
- `taskbox` or `taskbox status`: the state, the install, the download, the network and the last job, once. The network line says whether the box is online, and how much the download received in the last minute.
- `taskbox status -w`: the same, redrawn every two seconds, with the time it was last drawn. Ctrl-C stops watching; the box carries on.
- `taskbox stop` and `taskbox start`: no jobs or downloads run until `taskbox start`, or until the service account logs in again. If a job is running, stop asks first, since stopping fails that job on GitHub. Stop waits for the loop to end, then deletes the VMs it left, so their CPUs, memory and disk are free. Type it in the service account's own login session, at the box or over Screen Sharing.
- `taskbox drain`: no new job starts, a VM waiting for a job ends, and running jobs finish. Then the loop stops by itself, as `taskbox stop` leaves it, with no job failed. Use it to give the box to other work, such as a render. `taskbox status` and `watch` say the box is draining. Jobs that come meanwhile wait on GitHub. A download under way stops, and no Linux proof starts. The drain survives the loop's own restarts, such as an update, and `taskbox start` cancels it.
- `taskbox check`: every check, OK or FAIL. A FAIL line has its fix on it.
- `taskbox prune`: removes old images, unfinished downloads and VMs left over, and says how much space came back. The loop does this itself after each new image. While the box's image is part downloaded, it cleans nothing, because Tart would delete that download.
- `taskbox logs`: the last day in plain sentences.
- `taskbox job timings` (v2.4.0): for each kind, over its last 50 jobs, the median and the 90th percentile of how long a VM took to be ready, how long a job waited, ran and took to clean up. Then each timing setting, now and what the numbers suggest. Any user can type it, and remote too. `--json` gives the same as numbers.
- `taskbox logins`: every Tailscale SSH login to the box in the last 7 days. As your admin user, each login, newest first: the local account, the tailnet user, the device and its address, the time and how long it lasted. Logins to the agent account, remote, are counted in one line; `taskbox logins --all` lists each. Anyone else, remote too, sees counts per kind of account (a person's, ci's, the agent account's) with the latest time, and no names. `--json` gives the same. `status` and `watch` show a line for logins in the last hour to any account but remote, and `taskbox check --away` has a row for logins to a person's account.
- `taskbox job list`: every job the box has run, newest first, 20 at a time. `taskbox job list -n 50` shows 50 and `taskbox job list --all` every one. Each line shows:
  - when it started, the repository and the job;
  - the result and how long it ran;
  - whether the VM was deleted, and the guard at the VM's start.
  A second line has the run's link and commit, "not known" until the box may read the Actions runs of the repo in `jobsFrom`. Any user can type it. The history stays on the box, in `/opt/taskbox-state`.

As your admin user. Each asks for your admin password, unless you typed it in the last few minutes. As the service account they say to switch to your admin user, and nothing runs. taskbox never asks for a password while you're logged in as the service account: if something does, don't type it.
- `taskbox update`: installs the newest release, or the one typed after it, such as `v2.5.0`, after showing its PR and the files it changes. A merge on `main` reaches the box only in a release.
- `taskbox rollback`: goes back to the install before, which the box keeps. It refuses an install from before undo existed, one with a pin retired for a flaw, and one whose files changed.
- `taskbox remove`: takes taskbox off the box, then names the two browser steps left.
- `taskbox unlock`: lets the service account's password unlock the disk after a restart. The install does this itself; `unlock` is for a box where it didn't. After your admin password, macOS asks for an admin's name and password, then for the service account's.
- `taskbox key reset approver`: clears the approver key this box trusts, after you type yes. Use it when the laptop that holds the key is lost. The box never takes that key again. Workspaces stay off until the next `taskbox update` shows the new key `taskbox.json` names, with its fingerprint, and you type yes.
- `taskbox workspace clear <agent>`: deletes the files of that agent's workspace account, after you type yes and their size. It refuses while the workspace is waiting, Active or Saving, or while any of the account's processes is left. It deletes as that account, never as root, then makes its home again, empty, at mode 700. At the box only.

Any user can type `taskbox workspaces`: each workspace with its agent, account and state, and the last steps the box applied. Every user sees the same names: the box's workspaces state is readable by all of them.

After a restart (a power cut or a macOS update), type the service account's password at the FileVault screen. `taskbox check`'s Restart password line says whether one password is enough.

To cancel a job, use its Cancel button on GitHub.

## Other users on the box

The box can have other users, such as a person's own account for heavy apps, like 3D or game tools. CI shares the box with them.

- Each VM gets 4 CPUs and 8 GB (`vmCpus`, `vmMemoryMB`), whoever else is logged in. A VM starts only while memory pressure is normal and the VM's memory and 4 GB more are free. At the top pressure level, the loop ends the job.
- Jobs share the box with every user all the time. `taskbox hold` and `taskbox share` are gone from v2.2.0, with `holdUsers` and `holdMaxHours`. Typed now, each says so in one line and changes nothing.
  - Your lever is `taskbox stop` and `taskbox start`, as the service account. `taskbox stop` stops every job and download until `taskbox start`, or until the service account logs in again. If jobs are running, it names them and asks first.
  - A hold kept from before the update, and any request left for one, end at the loop's first read after it, with one line in `taskbox logs`. The next install removes the old requests folder, `/opt/taskbox-state/<project>-requests`. A folder another user left in it with files stays, and the folder with it; the loop's log and the install say so once. Nothing reads it, and taskbox never walks into it.
  - Hold lines in `taskbox job list` from before v2.2.0 are no longer shown. A job line's waits may still name a hold.
- `status`, `watch`, `log`, `check` and `jobs` work for every user. The loop keeps a copy of its state for them in `/opt/taskbox-state`, with nothing secret in it and no path into the service account's folder. A copy that isn't the service account's alone isn't shown.
- `taskbox check` as the service account or root lists each user and whether it's an admin. As anyone else it gives counts and names nobody.
- Free disk counts every user's files. A VM needs 60 GB free to start, and 60 GB more for each VM already running (v2.2.0): 120 GB before a second starts. Before the image is held, its download needs room for it too, and it waits until there is.

## Linux VMs (v2.1.0)

Jobs labelled `taskbox-linux` run in a fresh arm64 Ubuntu 24.04 VM with Docker, so they get `services:` containers, `docker build` and `docker run`. Jobs labelled `taskbox-macos` run as before.

- A box job names its kind's label. A `runs-on` with the runner group and no label could land on either kind, so the jobs repo's own checks should refuse it.
- The image is Cirrus Labs' `ubuntu-runner-arm64` 24.04, pinned by digest in `taskbox.json` under `linux`, with its own CPUs and memory. It is an 11.3 GB download. The loop pulls it between VMs, at most once an hour until it is in, so a Linux download that fails or has no room never holds up macOS jobs.
- The Linux runner is pinned in `versions.json` as `runnerLinux`, the same release as the macOS one.
- Which VM a slot starts is the scheduler's choice: see Scheduling (v2.4.0).
- The job source is read as a read-only App of your own, installed on the `jobsFrom` repository only. The first App never gets that repository: its key could then mint tokens for its source. Its ID is the source's `appId` in `taskbox.json` (before v2.4.0, `actionsAppId`). Its key is `/opt/taskbox-keys/actions-<App ID>.pem`: a folder of root's that nobody else can write, outside every install and outside the service account's home, holding a file that is the service account's at mode 600. The service can read the key but can't replace it or put a link in its place. One token is kept for 55 minutes, and each list is read with its ETag.
- `taskbox connect github` places the key (Connect a job source). Each `taskbox update` asks GitHub again whether the key in place is the job source App's, with Actions read and nothing else, installed on the `jobsFrom` repository only. An App that gained rights or repos stops the update, with one line saying why. An App that is gone or uninstalled lets the update go on, and the box follows the jobs its VMs take until you connect again. `taskbox remove` deletes the key.
- With one slot and no job source, the box takes turns: a VM waits `turnIdleMinutes` (5) for a job of its kind, then gives way to the other kind. Once both kinds have given way in a row, each turn is `quietTurnMinutes` (30), so an idle box starts 2 VMs an hour. After a job the box starts the same kind again, up to 3 in a row. `taskbox status` and `check` say which way the box is choosing, and why.
- Before a VM gives way, its runner is deleted on GitHub. GitHub refuses that once it has given the runner a job, and then the VM keeps waiting for it.
- A VM that fails passes the slot to the other kind. After 3 failures in a row, that kind is paused for an hour, and the box reads Failing. A VM that gave way has no line in `taskbox job list` or `taskbox logs`.
- Each Linux VM gets the same Softnet rules, the same check that the box can't reach it, the same ceiling and the same delete after its job as a macOS VM. In the guest, SSH and Ubuntu's daily package updates are masked and admin gets a password nobody keeps. Then Docker must answer before the runner starts.
- Images built on the box are arm64. A job that needs amd64 images says so with `docker buildx --platform`, and that runs under emulation, slowly.
- Free disk counts each kind's own image until it is held: the 12 GB Linux image never stops a macOS job.
- `taskbox status` and `watch` show the Linux download on its own line and the kind of the VM in the slot. `taskbox job list` shows each job's kind. `taskbox check` lists each kind's label, image and size.
- Before any Linux job, the loop proves a Linux VM under Softnet reaches nothing on the box or the LAN. It starts a Linux VM with a job's Softnet rules, seals it, and from inside tries the box's bridge address, each of the box's LAN addresses, the router, the box's tailnet address, Tailscale's DNS address and the box's public address, on SSH, web, File Sharing, Remote Management, AirPlay and Screen Sharing ports. Every try must time out, and DNS and the internet must work. The VM runs no runner and gets nothing from GitHub, and it is deleted after. Linux jobs wait until a proof has passed for this image and this install. A failed proof runs again 6 hours later. macOS jobs carry on either way.

### Connect a job source

A job source lets the box see what waits, so it starts the right VM for it, puts the classes you set first, and never guesses. Without one the box works, following the jobs its VMs take. taskbox makes the source's read-only GitHub App for you, with two clicks. Nothing is copied by hand, and no PR or release is needed: the source is kept in the box's own settings, `/opt/taskbox-state/box.json`.

1. At the box, in Terminal, as your admin user: `taskbox connect github`. Over Screen Sharing is fine; over SSH it refuses.
2. Safari opens at the box. If it shows GitHub's sign-in, sign in there, as an owner of your organisation. This is the one place you sign in.
3. Click **Create GitHub App**. The App has Actions read and Metadata read, and nothing else, with no webhook.
4. On the next page, choose Only select repositories, pick your `jobsFrom` repository and nothing else, and click **Install**.
5. Terminal says Connected, and asks you to sign out of GitHub in that Safari window. Do that.
6. As the service account, type `taskbox check`. A pass: the key's row says `OK`, with the App's name and `from this box's settings`, and the "Box settings" row says `box.json sets sources`. After the loop's next VM, the `Choosing:` line says `by the job source's waiting jobs`.

If the box already has a job source App from before, `taskbox connect github` checks it with GitHub and keeps it in the box's own settings, with no new App. The next `taskbox update` does the same by itself.

- **Run it again** on a connected box: it checks the App, and offers to replace it with a new one. The App in use stays until the new one passes.
- **A new key for the runner App**, the one whose ID is `appId`: make it on the App's page (Credentials, Key pairs, New key), then type `taskbox update`. Before the yes, taskbox checks the key in Downloads with GitHub, places it in `/opt/taskbox-keys` and deletes the file. Nothing else changes.
- **A new key for the same App:** `taskbox connect github --new-key`. Safari opens the App's settings. Open Credentials, then Key pairs, and generate a new private key. taskbox takes the file from Downloads as soon as it is saved, checks it, places it and deletes the file. Then delete the old key on the same page, under Credentials, Key pairs; taskbox shows its fingerprint.
- **Stopped halfway** (Ctrl-C, or the install wasn't clicked): the next `taskbox connect github` finds the App it made, and asks whether to finish or drop it.
- **The runner group's runners:** `taskbox check` and `taskbox check --away` look at each runner in the box's group. One without the box's name, or with a label the box's settings don't name (such as `ubuntu-latest`), fails the check, named.
- **Disconnect:** `taskbox disconnect github`. It uninstalls the App and removes its key. GitHub keeps the App until you delete it, and the line says where.

To give the App a new key: `taskbox connect github --new-key`. To stop using the source: `taskbox disconnect github`.

### Turning Linux on, after the update to v2.1.0

At the box. macOS jobs carry on throughout.

1. As your admin user, type `taskbox update`. It installs v2.1.0.
2. As your admin user, type `taskbox update` once more. The install before v2.1.0 doesn't fetch the Linux runner; this run does.
3. As the service account, type `taskbox status -w`. The `Linux:` line shows the 11.3 GB download, then `Image ready`. Between macOS jobs, the VM line then says `Linux: Proving a Linux VM under Softnet reaches nothing on the box or the LAN`, for about 5 minutes.
4. As the service account, type `taskbox check`. A pass is a `Linux proof:` line that starts `OK, a Linux VM under Softnet reached none of the box's bridge address, the box's LAN address, the router` and ends `DNS and the internet worked`. A `FAIL` line names what the VM reached: Linux jobs wait, and agents fix it. There is nothing for you to do.
5. Only once step 4 passes, let the jobs repo send Linux jobs to the box, for example with a repo variable its workflows read.

## Two VMs at once (v2.2.0)

From v2.2.0 the box runs `vmsAtOnce` VMs at once: for example 2 on a Mac with 10 cores and 32 GB. Each VM keeps its own size, 4 CPUs and 8 GB today.

- macOS VMs are at most 2 at once. Apple's licence allows 2 per Mac, and Tart refuses a third.
- Before each start the box checks for room for one more VM. Memory: 12.2 GB free at normal pressure, as before, and with a VM running, every VM's memory and 12 GB for the box and its users must fit in the box's whole memory. Two 8 GB VMs fit in 32 GB; a third doesn't. Disk: 60 GB free for the new VM and 60 GB for each VM running, so 120 GB before the second starts, since a running job may still write all of its own 60. A download under way counts too. Room for one VM but not two is a wait, and the box reads Running, never Needs you. A third macOS VM is refused inside the gate too, whatever chose it.
- A VM that is up and waiting for a job carries on while 4 GB stays free at normal pressure. Before v2.2.0 it needed room for a whole second VM, which two VMs never leave.
- VM starts take turns through a gate: one start at a time, from its checks to the guard's read once its guest answers. So each start's checks see every VM before it, and the guard's record in that time is that start's. When the rules went missing while another VM stopped at the same moment, the box can't tell which did it, so it counts it as the start's, and no VM starts while Screen Sharing is on, as before.
- Which VM each slot starts: see Scheduling (v2.4.0).
- The Linux proof takes a slot. Linux jobs still wait for a proof that passed for this image and this install. With more than one slot, the proof also tries every other job VM that is up, on the same ports, and every try must time out: one job VM must not reach another. It waits up to 30 minutes for another VM to be up, then proves without one, and proves again once one is up.
- Merge jobs: each kind's labels hold a merge label, and a class puts merge_group jobs first (Scheduling (v2.4.0)). A runner registered with only that label gets only jobs that ask for it. The jobs repo puts the label on its merge_group jobs' `runs-on`, and its PR jobs keep the kind's own label.
- An update ends the waiting VMs, lets running jobs finish, then restarts. Your lever is `taskbox stop` and `taskbox start`: `taskbox stop` names every running job before it stops them all.
- `taskbox status -w` and `status` show a `VM 1:` and `VM 2:` line. The state names each running job. `taskbox job list` says which slot ran each job. `taskbox check` has a `Slots:` line.
- `status --json` answers version 2: `jobs` lists every running job with its kind and start, and `slots` gives the total and how many hold a VM. Every field of version 1 but `hold` is still there with its meaning, and `job` is the first running job's name. `hold` and the state word `Held` are gone with hold, and `jobs --json` has no hold entries. A reader that refuses any version but 1 refuses it, and says to update.
- `slots` in `taskbox.json` stays 1: v2.1.1's update reads the new release's settings with its own rules, which refuse anything else. `vmsAtOnce` is the setting from v2.2.0. `vmsAtOnce` 1 runs one VM at a time, taking turns, as before.
- Every wait has a ceiling: a start waits at most 45 min for the gate, and each job keeps its own ceiling.

### After the update to v2.2.0

At the box, one step at a time. Running jobs finish first.

1. As your admin user, type `taskbox update`. It installs v2.2.0. The loop ends its waiting VMs, waits for any running job, then restarts.
2. As the service account, type `taskbox status -w`. A pass: a `VM 1:` and a `VM 2:` line. Within a few minutes one says `macOS: Ready, waiting for a job from GitHub.` The other proves Linux for about 5 minutes, since the proof runs again for each install, then says `Linux: Ready, waiting for a job from GitHub.`
3. As the service account, type `taskbox check`. A pass: every line OK, and a `Slots:` line that starts `2 VMs at once, macOS at most 2`. If `Free disk` fails, its line says how much it needs.
4. In the same `taskbox check`, find the `Linux proof:` line. A pass: it starts `OK` and names `another job VM` among what the Linux VM reached none of. That shows a Linux job VM couldn't reach the macOS VM beside it. A `FAIL` line naming `another job VM` means one VM reached the other: Linux jobs wait, and agents fix it. If the OK line doesn't name `another job VM`, no other VM was up when the proof ran. The loop proves again by itself once one is up: type `taskbox check` again in 15 minutes.
5. Agents make the jobs repo's PR that puts `taskbox-macos-merge` and `taskbox-linux-merge` on the merge_group jobs. You merge it. Until then merge jobs run as PR jobs do.

To go back to one VM at a time: agents make a PR that sets `vmsAtOnce` to 1, and you install it with `taskbox update`. Or type `taskbox rollback` as your admin user, for the release before.

## Scheduling (v2.4.0)

Which VM each slot starts, and when a waiting VM gives way. The design is [docs/scheduling-design.md](docs/scheduling-design.md), and its test cases are [docs/scheduling-scenarios.md](docs/scheduling-scenarios.md). The code names no organisation, repository, App or label: every value is in `taskbox.json`.

- **A job source** says what waits. `github-actions` reads the queue through your read-only App (Connect a job source). `none`, or no source at all, means the box can't see the queue.
- **One source, one real repo.** `sources` takes one source. Its `repos` names your `jobsFrom`, and from v2.6.0 at most one test repo for the load test (Load test, below): the settings check refuses more.
- **Labels.** Each kind's `labels` is every label its VMs may register, its own label first. A job belongs to the kind whose labels hold every label it asks for, less the labels every runner has, such as `self-hosted`.
- **Classes** rank what waits. The first rule that matches wins, and a job no rule matches is in the last class, `jobs`. A rule can name the events a source vouches for, such as GitHub's `merge_group`, and a label it matches (`equals`, `startsWith` or `endsWith`). A label comes from the workflow, which a pull request can change in its own copy, so a label alone never matches a rule that names events. A pull request's job that names a merge label is ordered with the other PR jobs. It can still be given a VM the box started for a merge job, if GitHub picks it first: labels decide which runners may take a job, and GitHub decides which job each takes. The merge job then gets the next free slot. And a merge_group run runs the workflow of the pull requests in the queue, so a pull request approved into the queue can add jobs of the merge class.
- **A job is the box's** only when every label it asks for is one its kind's runners have: the kind's `labels`, or the ones GitHub gives every runner of that kind (`self-hosted`, its OS, `arm64`). A job that asks for `windows`, `x64` or a label out of shape would never run here, so it holds no VM.
- **With a source:** a free slot starts a VM for the first waiting job no waiting VM can take, the best class first, then the oldest. That VM registers only the labels that job asks for, so a merge VM takes only merge jobs. With nothing like that waiting, one VM of each kind waits ready. When every slot is taken, one waiting VM that no waiting job needs gives way for a job that can't get a slot.
- **Without a source**, the box follows the jobs its VMs take. A kind is busy when one of its VMs took a job within `busyWithinSeconds` (60) of being ready, in the last `busyForMinutes` (10).
  - A quiet box keeps one VM of each kind waiting.
  - A free slot goes to a busy kind first.
  - A waiting VM gives way after `giveWayMinutes` (3) with no job, when every slot is taken and another kind is busy.
  - No kind goes without a VM for more than `floorMinutes` (8) while the box is busy.
- **Give-way** counts from when a VM is ready, never from when it was asked for. Without a source, a VM still booting never gives way, and a kind isn't busy after one of its VMs gave way, until a VM takes a job soon after it was ready again, so a burst's end settles to one VM of each kind. With a source, a VM no waiting job needs may give way while it boots, and within a class a kind with no VM goes first, so a macOS job doesn't wait behind a Linux backlog.
- **One slot with no source** takes turns, as before. One slot whose source can't be read while its VM waits gives way after `turnIdleMinutes`, as a turn does.
- `taskbox status -w` shows each slot's reason on a `Why:` line under it. `taskbox check` has a `Job source:` line and a `Timings:` line.
- **Timings** are settings, under `timings` in `taskbox.json`, with the defaults above. `taskbox job timings` measures what they should be from each job's phases, and suggests. The box never changes its own settings: you or an agent's PR does.
- Every job line in `taskbox job list` has its phases: how long the VM took to be ready, how long the job waited, ran and took to clean up. `jobs --json` gives them as `phases`, and its answers are version 3.

### After the update to v2.4.0

At the box, one step at a time. Running jobs finish first. v2.3.0 must be installed.

1. As your admin user, type `taskbox update`. It installs v2.4.0. The loop ends its waiting VMs, waits for any running job, then restarts. The Linux proof runs again for the new install, about 5 minutes.
2. As the service account, type `taskbox status -w`. A pass: each `VM` line has a `Why:` line under it, such as `Why: the box can't see the queue, so a macOS VM waits ready for the next job.`
3. As the service account, type `taskbox check`. A pass: every line OK, a `Job source:` line, and a `Timings:` line that starts `give way 3 min, floor 8 min`.
4. After a day of jobs, type `taskbox job timings`. A pass: each kind shows its jobs measured. Once each kind has 10, it suggests a value for each timing, and the agents bring any change as a PR.
5. If you want the box to see the queue: Connect a job source, above.

To go back: as your admin user, type `taskbox rollback`. v2.3.0 reads the job lines v2.4.0 wrote, and skips their phases.

### Acceptance on the box (v2.4.0)

Written before the install. Over a day or two of real jobs, `taskbox job timings` ends with an `Acceptance` block that reads each of these from the job lines and the give-way log of the last 48 hours, with its number and PASS, FAIL or NOT MEASURED. `taskbox job timings --json` gives the same under `acceptance`.

| criterion | read from | pass |
|---|---|---|
| Linux bursts keep the slots busy | job lines: in each burst of 4 or more Linux jobs within 15 min, the share of the slots' time running jobs of any kind | the median burst at least 55% |
| no later job goes before a merge job | job lines with a job source: a job of the last class queued after a merge-class job that took a VM before it | 0 |
| macOS jobs' wait | job lines with a job source: from queued to running, 90% of macOS jobs | at most 12 min |
| give-ways per busy hour | the give-way log, over the hours with a job | at most 3 with a job source, 8 without |
| every VM deleted | job lines | 0 not deleted |
| box failures | job lines, the box's own failures, never a job's | at most 2% |

- NOT MEASURED means the lines can't show it yet: the merge and wait criteria need a job source, and a burst needs a burst.
- A FAIL means: as your admin user, type `taskbox rollback`, back to v2.3.0. Agents then find why from the job lines and `taskbox logs`, fix it in a PR with a replay of that day, and you install the fix with `taskbox update`.
- **Calibrating the simulator.** After the first day, as remote, type `taskbox job list --all --json`, and send it to the agents. They save it in `test/replays/`, with every job's name dropped. A test replays it through the simulator with that day's measured boot times, and checks that its macOS waits match the box's within 3 minutes. Where they don't, the simulator is fixed first, and then the limits above are checked against the corrected model in a PR you merge.

## Leaving the box for days (v2.5.0)

The box runs for days with no one at it. The design is [docs/away-ready-design.md](docs/away-ready-design.md).

- Before you leave, type `taskbox check --away` as `ci`. Every line should say OK, WARN or SKIP; each FAIL says what to do and where, and a WARN is worth a look but no reason to stay. It ends `Ready to leave.` or how many things are left. From the laptop, `remote` can run it too.
- While you're away, `taskbox status` says what is wrong, who acts, and whether it can be done from away: "Waits by itself", "From away" (a step on GitHub or the laptop), or "At the box".
- GitHub refusing the box reads Failing after 3 tries in a row, with the reason: the App's key, a clock that is off, a runner group or installation that is gone, or GitHub not answering. A rate limit reads Waiting until GitHub's time.
- A loop that stops moving reads Failing for every reader once its heartbeat is 5 minutes past its own deadline. It restarts itself, and the guard restarts a loop frozen too hard to do that, a few minutes later; the loop's log says which.
- An image Tart removed is downloaded again by itself. Job VMs left behind are deleted on idle passes. A Linux proof that couldn't run tries again in 15 minutes.
- The box reads its public address from two sources, and blocks every address they give for every VM.
- `taskbox check` has rows for GitHub, the heartbeat, automatic macOS updates and restart after power loss.
- Each job's line records what it used: the guest's memory and CPUs at peak and their 90th percentile, sampled every 30 seconds. `taskbox job list` shows them, and `taskbox job timings` shows each label's median and 90th percentile, for sizing VMs per label. It leaves out disk, network, a GPU, swap, the VM's own memory on the box, CPU beyond the one second each sample watches, and anything shorter than a sample (the design lists each).
- A dead box can't say so itself. `taskbox template show box-check` and `taskbox template show test-job` print two workflows, made from the box's settings, for the repo whose jobs the box runs: GitHub emails you when the box's jobs wait too long ([templates/README.md](templates/README.md)). `taskbox check --away` says whether the copies there match the box.
- A restart stops at the FileVault screen. Each box has a restart plan, `away.restartPlan` in its `taskbox.json`. The recommended default is `accept`, with precautions: FileVault stays on, automatic macOS updates are off, a UPS keeps the box and the router up through short power cuts, the watchdog emails you, and someone near the box types the password after a longer cut. The later option is `kvm`: an IP-KVM on Tailscale types the password. `filevault-off` is the third. The design weighs each, and its "Owner steps" go one at a time: turn automatic updates off, fit the UPS, and confirm with `taskbox check --away`. Its UPS line reads `pmset -g ps`: OK when a UPS is seen and the box runs on AC through it, with its battery level and charging state; WARN under `accept` when none is seen; SKIP for other plans. A UPS without a USB cable to the box can't be seen.

Settings, each with a default, in `taskbox.json`'s `away`: `githubFailures` (3), `heartbeatGraceMinutes` (5), `proofRetryMinutes` (15), `publicAddress` (`["cloudflare-trace", "ipify"]`), `watchdogIntervalMinutes` (60), `watchdogWaitMinutes` (30), `canaryIntervalMinutes` (60), and `restartPlan`.

## Load test (v2.6.0)

A private test repo of your own sends the box short sleep jobs, so you can see how the box schedules a busy day without waiting for one. The design is [docs/load-test-design.md](docs/load-test-design.md).

- **Its own runner group.** The test repo's VMs register in a runner group that lists only the test repo, so GitHub never gives a test job to a real VM, or a real job to a test VM.
- **Real jobs first.** Every test job ranks after every real job, whatever its class, and a test job never makes a real VM give way. Beside the real repo, test VMs hold at most every slot but one, and each kind one place below its cap, so one real job at a time always has a slot. A second real job at the same moment may wait for a test job to end; each test job ends within 20 minutes. With one VM at a time, the test repo runs only with `--only`.
- **It needs the queue.** Test jobs run only while the box can see the queue through the job source. When it can't, `taskbox load status` and `taskbox status` say test jobs wait, and why.
- **Sessions.** As `ci`, `taskbox load start` starts a numbered session beside the real repo, for at most 4 hours (`--for 2h` sets less). `taskbox load start --only` gives the test repo the box alone for that time: the real repo's jobs wait on GitHub. While real jobs wait it names them and asks for `yes`. `load on` runs `taskbox check --away`'s checks first and names any not met; the session still starts, and the report lists them. `taskbox load stop` ends it. Running test jobs finish; no new test VM starts. If the test repo's runner group is set up wrong, the box ends the session itself and says why.
- **The report.** `taskbox load report` scores the last session, or `--session N`: the acceptance criteria for real jobs and test jobs apart, each side with its own give-ways; real jobs a test VM went ahead of, which must be 0; real jobs that waited for a running test job, the cost of running beside; test jobs left queued at the end; and the reads of GitHub. Anyone may type it, remote too. `--json` gives the same. `taskbox job timings` leaves the test repo's jobs out.
- **The workflow.** `taskbox template show load` prints it, made from the box's settings as `taskbox template show test-job` makes the canary. It runs only on the box's labels, so it uses no GitHub-hosted minutes, and only when you start it. Its jobs only sleep or echo. The patterns: `canary`, one tiny job per kind, as the canary asks for; `burst`, 12 Linux jobs at once; `push`, one macOS job with 9 Linux jobs; `day`, 6 macOS jobs and 54 Linux jobs, which measures every criterion. Beside the real repo, `day` needs 3 or more VMs at once to finish well inside 4 hours. Runs may overlap: start `push` again while one runs for a busier moment.
- `taskbox status` has a `Load:` line while a session is on.

### Setting up the test repo

One step at a time.

1. Make a new private repo in your organisation, with a README. Give it no secrets: the box never runs jobs that hold them. A pass: the repo's page shows the README, and its Settings, Secrets and variables, Actions, lists none.
2. At the box, or from the laptop, type `taskbox template show load`. Save what it prints as `.github/workflows/load.yml` in the test repo, and commit it. A pass: the repo's Actions tab lists `load`. When the box's labels change, make it again.
3. In your organisation's Settings, Actions, Runner groups, click New runner group. Give it a name of its own. Under Repository access, choose Selected repositories and pick only the test repo. Leave "Allow public repositories" unticked. A pass: the new group lists the test repo alone, and the box's own group still lists only the real repo.
4. At the box, as your admin user, type `taskbox connect github --load <org>/<test repo> --group "<the new group>"`. It checks the App with GitHub and keeps the test repo in the box's own settings. A pass: it says the test repo is in this box's settings.
5. As `ci`, type `taskbox check`. A pass: every row OK, the `Test repo` row among them, which says the test repo's runner group lists it alone.
6. In your organisation's Settings, GitHub Apps, open your job source App, then Configure. Under Repository access, add the test repo beside the real one. A pass: both repos are listed, and no other. Nothing to do at the box: it reads the test repo from the next session on.

### Running a load test

1. At the box, as `ci`, type `taskbox load start`, or `taskbox load start --only`. A pass: `taskbox status` has a `Load:` line with the session's number and end, and after a minute it doesn't say test jobs wait.
2. On GitHub, open the test repo's Actions tab, then `load`, then Run workflow. Choose a pattern and click Run workflow. A pass: the run's jobs are queued, and a slot's `Why:` line in `taskbox status -w` says it started for a load test job. If the box can't use the test repo's runner group, it ends the session and `taskbox load status` says why; the real repo carries on.
3. When the run is done, type `taskbox load stop`. It names any test jobs still queued: cancel them in the test repo's Actions tab, since the box's App can only read.
4. Type `taskbox load report`. A pass: each criterion the pattern measures is PASS, `real jobs a load VM went ahead of: 0, at most 0`, and no `Test jobs never started` line.

### Removing the test repo

In this order.

1. In the job source App's Configure page, remove the test repo. A pass: only the real repo is listed. The box goes on serving the real repo.
2. At the box, as your admin user, type `taskbox connect github --load off`. A pass: `taskbox check` is all OK, with no `Test repo` row.
3. Delete the test repo's runner group, then the test repo.

`taskbox rollback` past v2.6.0 works with the test repo still connected: the box's own runner group still lists only the real repo, and the release before reads only its own repo. A later update run by that older release refuses an App on two repos, so do step 1 first. After an undo, `taskbox job timings` counts the test repo's job lines as real ones, so read its numbers from after the last session.

## The bridge to v3 (v2.6.1)

v2.6.1 changes nothing a job sees. It gets the box ready for v3, which comes from this public repo, signed with the release key.

- **Where v2 releases come from.** From v2.6.1, v2 releases come from `releaseRepo` in `taskbox.json`, a repo in `org`, when it is set, and from `repo` when it isn't. Until a repo has that name, `taskbox update` says `The release repo ... isn't there yet`, and the loop's log says so once per job. Jobs run as before.
- **Trials.** `taskbox update v3.0.0-rc.1` takes a trial by name. `taskbox update` with no release named never takes a trial or a v3 release.
- **The hop to v3.** `taskbox update v3.0.0-rc.1` reads the release's signed statement from `publicRepo` with no token, and checks its signature against the release key v2.6.1 pins in `signers/allowed_signers`, before it downloads anything else. Then it checks the tarball and its files against the statement, and shows the signing key. Compare that key with the fingerprint in `signers/allowed_signers`, and type yes only if they match. v2.6.1 never reads v3's settings: v3 moves them itself.
- **The release key.** `signers/allowed_signers` pins the key that signs v3 releases, by a PR the owner merges. A test fails if it holds no key line. No v3 release installs unless that key signed it.
- **Going back by itself.** The hop leaves a watcher, run every minute from the v2.6.1 install. If v3's guard hasn't proved v3 in time, the watcher takes the box back to v2.6.1, as `taskbox rollback` would. If going back fails, `taskbox check` says so on its Rollback watcher line, and the watcher tries again by itself. Its lines are in the guard's log.
- **Undo.** Going back from v3 also stops v3's own services, which v2.6.1 doesn't run, and puts back v2.6.1's own guard and loop.
- **One at a time.** An update, an undo and the watcher never run at once.

### The steps

1. Your admin user types `taskbox update v2.6.1`, compares the PR, files and commit, and types yes.
2. If your v2 releases move to another repo in `org`, set `releaseRepo` to its name in a PR, then rename the repo. In the box's GitHub App settings, keep its installation on selected repositories, with only the release repo, so a box still on v2.6.0 can't read any other. A box gone back to v2.6.0 after the move can't update. Type `taskbox rollback` once more to return it to v2.6.1.
3. When v3.0.0-rc.1 is out, your admin user types `taskbox update v3.0.0-rc.1`, as above.

## Screen Sharing and remote access

- The box is reached over Tailscale only. The tailnet policy in [docs/tailnet-policy.md](docs/tailnet-policy.md) decides who reaches it, and says what to do if the box is lost.
- A laptop running taskbox as a controller reads `hello` and `--json` on `status`, `jobs`, `log` and `check`. Each prints one line of JSON with a version number, and text cut to printable ASCII. `hello` gives the box's release and its install ID, `/opt/taskbox-state/install-id`: made once by the install, root's and read-only, and no password. Read the answer, never the exit code: over Tailscale SSH, a refused command still exits 0 (ran, at the box), probably because macOS's `login` sits between tailscaled and the shell (not checked). A refusal in `--json` says `"kind":"error"`.
- The install signs the box in, with Tailscale SSH on, port forwarding refused, and MagicDNS's answers off. Remote Login stays off.
- The box's accounts are named in `taskbox.json`'s `accounts`, by role (v2.7.0). `service` runs the loop and holds the App's key. `agent` is for reading the box over Tailscale SSH. `people` are your own standard accounts. taskbox makes the service and the agent, and never makes, changes or deletes a person's account. No role may be an admin. `taskbox policy show` prints the tailnet policy for them. With `approverKey` set, taskbox also makes `taskbox-ws1`, the account a workspace runs in: hidden, with no password, in a group of its own, and denied cron and at. The box trusts the key only once it is pinned at the box: `taskbox update` shows its fingerprint before your yes, and a new key needs a statement signed by the old one, and its fingerprint's last 6 characters typed at the box. An update that changes the files that decide trust names them before your yes.
- The agent account is for reading the box. Its login shell is taskbox's own: it runs `check`, `hello`, `job`, `load`, `logins`, `logs`, `status`, `template`, `workspace`, `queue`, `wait`, `progress`, `deny`, `signed` and `workspaces`, and nothing else. The last seven are an agent's workspace commands: each writes one request for the guard, or reads root's state, and none gives anyone more of the box. It has no password. Its home is `/private/var/taskbox-<agent>`, an empty folder that is root's and read-only. The install never changes `/Users/<agent>`, where macOS protects some folders even from root. The agent can't log in at the box's screen. Admin work is never done through it: it is done at the box, as the admin user.
- A person's own account logs in over Screen Sharing, when it is in `accounts.people`, and over Tailscale SSH only when it is also in `accounts.ssh`, which is empty by default.
- Every Tailscale SSH login is kept. A login comes from macOS's own login records, which root's `login` writes with the address it came from, so no client can fake one. The guard reads them every minute, and asks Tailscale once who has that address: that names the tailnet user and the device. It keeps them for 8 days, in `/var/log/taskbox-logins.json` for admins, and as counts with no names in `/var/db/taskbox-logins.json` for every user. Any user with a full shell can type `last` and see the accounts and addresses anyway; the agent can't.
- tailscaled writes its log to `/var/log/taskbox-tailscaled.log`: root's, group admin, mode 640. If the guard finds it readable by every user, it moves it aside for root only, makes a new one and restarts tailscaled. It keeps it under 2 MB, with the last part in `taskbox-tailscaled.log.0`. The log is read for two things only, each shown as unverified, since a client on the tailnet can write lines there: whether check mode asked, and sessions with no login record. "Check asked" means tailscaled logged a check it fetched. A wait of 5 seconds or more before a session is shown as that wait, "likely a check". A session with no terminal, such as `ssh box taskbox status`, has a login record too, so it is a login like any other.
- If tailscaled's LaunchDaemon is on disk but not loaded for 30 seconds, the guard loads it, says so in its log, and tries again later if that fails. `taskbox rollback` loads tailscaled again from a one-shot LaunchDaemon of its own, so an undo typed over Tailscale SSH can't leave it unloaded.
- SFTP and `scp` to the agent fail. tailscaled serves SFTP with its own file server, run as the user, which never goes through the user's shell. So the box's tailscaled runs with SFTP turned off (`TS_SSH_DISABLE_SFTP`), and the Tailscale row in `taskbox check` fails if its LaunchDaemon differs from taskbox's. v2.0.0 and v2.0.1 left SFTP on.
- Screen Sharing works over Tailscale only. macOS can't bind it to one network, so pf drops its port, 5900, on every interface but Tailscale's (`utun99`, set by `tailscaleTun`).
- The guard keeps those pf rules in place: a root LaunchDaemon that runs at boot and every minute. Each time it finds them missing it puts them back and drops Screen Sharing's connections from off Tailscale. `taskbox check` shows it on the "Screen Sharing guard" line.
- If the rules went missing when a VM started, the box starts no VM while Screen Sharing is on, until a later release shows VM starts leave them alone.
- While Screen Sharing is on, the box starts VMs only if:
  - the guard is running;
  - Screen Sharing allows only the users in `accounts.people`, each a standard user, and the admins, in System Settings, General, Sharing, Screen Sharing, behind the info button. taskbox names nobody by default. The admins come through the Administrators group, which macOS puts on the list. taskbox keeps it, so an admin can do admin work at the box from a laptop, still over Tailscale only and its policy. Anyone else on the list fails the row;
  - no VNC password is set, and nobody may ask permission to share the screen.
  Otherwise the "Sharing services off" line fails, and the next step is to turn Screen Sharing off. A VM still waiting for a job is deleted when that line starts failing.
- A VM reaches the box for DNS only: Softnet blocks the box's bridge address for every VM.
- Nobody on the box reaches a VM. Its image ships SSH on and a password everyone knows, so the loop turns SSH off and sets a password nobody keeps. Then the box tries the VM's SSH and Screen Sharing ports itself. Softnet must drop both, or the VM is deleted before its runner starts.
- `taskbox remove` takes the guard and its pf rules away, and tailscaled with its state and its log, so the box leaves the tailnet. Type it at the box. Turn Screen Sharing off before you type it.

## Updating a box from v2.2.x to v2.3.0

v2.3.0 renames taskbox's launchd services to `local.taskbox.loop`, `local.taskbox.guard` and `local.taskbox.tailscaled`. The update to it is run by v2.2.x's own code, which knows only the old names, so it takes two updates:
1. As your admin user, type `taskbox update`. It installs v2.3.0, and every service keeps its old name for now.
2. `taskbox check` then has a FAIL line, "Service names": type `taskbox update` once more. Before the yes, it says it also moves the services to their new names. It moves the guard and tailscaled at once, with a few seconds without Tailscale. The loop moves by itself once no job runs: in the Tart test, about 9 minutes after the second update.
`taskbox rollback` after step 1 goes back to v2.2.x as it was. After step 2, it still goes back to v2.2.x, and puts the guard's and tailscaled's old names back; log the service account out and in, and the loop follows.

This repo carries no old-named plists. A private copy for a box first installed under other labels keeps its three old plists in `launchd/`, with `previousLabelPrefix`, until the box has had both updates: a box still on v2.2.x is updated by code that reads them.

## Updating a box to v2.7.0

v2.7.0 names the box's accounts in `accounts`, by role. A box installed before it keeps its accounts, so nothing is made or renamed. In your own copy, before you merge v2.7.0, `taskbox.json` must have `accounts` with the box's own names: `"service": "ci"`, `"agent"` as your `remoteUser` (or `"remote"`), and `"people"` as your `screenSharingUsers`. Keep those two old keys beside it, with the same names, for this release. Without `accounts`, v2.7.0's code refuses to run, and `taskbox rollback` goes back.
1. As your admin user, type `taskbox update`. One update is enough.
2. `taskbox check`: the "Service account" and "Agent account" lines should say OK, and the agent line names the account a laptop pairs with.
3. `taskbox policy show --owner <your Tailscale login>` prints the tailnet policy's entries. From v2.7.0 a person gets Tailscale SSH only when named in `accounts.ssh`, so a box from before it loses the `check` rule for its people unless `accounts.ssh` names them. If so, replace taskbox's `ssh` and `sshTests` entries in the admin console with the ones printed. From v2.7.0 on, an update names any such change before the yes.
`taskbox rollback` goes back with nothing on the box changed.
`remoteUser` and `screenSharingUsers` stay in this box's `taskbox.json`, equal to `accounts`, for v2.7.0 only, since v2.6.x's code reads them during the update.

## Releases

A release is a version tag, such as v2.0.0, on a commit on taskbox `main`, published with notes. `taskbox update` installs the newest one, or the one typed after it. Nothing is compiled or signed: the box installs the release's source, and every tool it runs is pinned by SHA-256 in `versions.json`. `taskbox rollback` goes back to the install before.

## What's here

- `install.sh`: the first install. It fetches the pinned bun, checks its hash and hands over to `src/cli.ts`. It is the one shell file.
- `src/install.ts`: the first install and every update, one code path. `src/layout.ts`: where installs live. `/opt/taskbox` links to the install folder, and an update or undo moves that link in one step. `/usr/local/bin/taskbox` puts the command on every user's PATH.
- `src/vm.ts`: the VM engine, the one interface the loop, the checks and the install use. `docs/vm-engines.md` says what any engine must give. `src/tart.ts`: Tart, the one engine, and every Tart command taskbox runs. `src/guest.ts`: what differs inside a macOS and a Linux guest. `src/kinds.ts`: asks the scheduler which VM a slot starts next. `src/scheduler.ts`: the scheduler, a function with no side effects. `src/source.ts`: job sources. `src/classes.ts`: priority classes. `src/timings.ts`: `taskbox job timings`. `src/shell.ts`: the agent's login shell. `src/access.ts`: the roles and the `accounts` block. `src/accounts.ts`: the accounts taskbox makes. `src/policy.ts`: `taskbox policy show`. `src/boxsettings.ts`: the box's own settings. `src/connect.ts`, `src/connectflow.ts` and `src/listen.ts`: `taskbox connect github`. `src/logins.ts`: `taskbox logins`, and the guard's reading of tailscaled's log. `src/approver.ts`: the approver key, which turns workspaces on, and what an update does with a new one. `src/pin.ts`: root's files for the pinned key and the workspace account. `src/gate.ts`: the workspace account's login shell, which opens only while its workspace is Active in this boot. `src/workspace/agent.ts`: the agent's workspace commands. `src/workspace/show.ts`: `taskbox workspaces`. `src/workspace/clear.ts`: `taskbox workspace clear`, which deletes a workspace account's files as that account.
- `src/loop.ts`: the runner loop. Per job it runs the checks, registers a one-job runner, clones the pinned image, starts it with Softnet, runs the job and deletes the VM. Softnet blocks the box's own public address for the VM, which it reads each time from Cloudflare's trace, so a job can't reach the router through it. If it can't read the address, it starts no VM.
- `src/checks.ts` and `src/ops.ts`: `taskbox check` and the other commands at the box. The checks are also run before every VM.
- `taskbox.json`: one box's settings: the organisation, the App ID, the runner group, the repo it serves, the project, the users, each kind's label, image and size, and the limits. It is never in this repo: each owner keeps their own in a private copy. `taskbox.example.json`: the same shape with made-up values.
- `versions.json`: every tool the box runs, pinned by version and SHA-256.
- `launchd/`: the LaunchAgent that runs the loop in the service account's login session, and the guard's and tailscaled's LaunchDaemons, all labelled `local.taskbox.*`. A box installed under other labels names their prefix in `previousLabelPrefix`, and its copy of taskbox keeps the three plists under that prefix too, the same but for the Label. The update to the first release with the new labels is run by the install before it, which reads those files, so every service keeps its old name and runs the new code. Type `taskbox update` once more: the new code boots out the old guard and tailscaled, removes the old files and loads the new ones. The loop sees the new LaunchAgent and restarts as for an update, once no job runs, under its new label. The public copy carries none of this.
- `src/guard.ts`: the guard's pf rules, and the record it leaves for `taskbox check` and the loop.
- `docs/build-tailscale.md` and its workflow: builds tailscaled twice, compares the builds, and attaches them to a draft release for `versions.json` to pin.

## Tests

`bun install`, then `bun test` and `bun run typecheck`. Tests fake Tart and GitHub. They never run a real command, and they run with a temp `HOME` and a system-only `PATH`. They need no `taskbox.json`.

CI (`.github/workflows/ci.yml`) runs the tests on GitHub-hosted runners for every pull request and every push to `main`, with read-only permissions and no secrets. A box never runs this repo's jobs.

## Licence

MIT, in [LICENSE](LICENSE). taskbox bundles no third-party code. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) covers the Tailscale build it publishes, and Tart and Softnet, which the box downloads from their own releases.
