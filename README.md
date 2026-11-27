# taskbox

taskbox turns a spare Apple silicon Mac, the box, into a GitHub Actions runner host. Each job runs in a fresh Tart VM that is deleted afterwards.

Every job on a box is untrusted code. A box never runs a job that holds secrets: those stay on GitHub's hosted runners. MIT licensed ([LICENSE](LICENSE)). Tart, Softnet and Tailscale have their own licences ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).

## Install

1. Make a private settings repo in your organisation. Copy `taskbox.example.json` to `taskbox.json` there and fill in your values: `org`, `jobsFrom` (the one repo whose jobs the box runs) and `runnerGroup` are yours. The rest have defaults. Everything that makes a setup your own lives in that repo; the code comes from this repo's signed releases.
2. Make a runner group, limited to selected private repos, that lists the one repo.
3. Install taskbox for the controller on your own Mac, from the [release page](https://github.com/seams-is/taskbox/releases).

## Set up a box

From the controller, with Remote Login on at the new Mac (System Settings, General, Sharing):

`taskbox box install ADMIN@MAC --settings ORG/REPO`

It fetches the signed release and checks it, reads `taskbox.json` through your own GitHub session, copies both to the Mac, and runs the install there over ssh: each password is asked in your terminal. The install verifies the release again against the keys it pins, shows the release, the key that signed it and the settings commit, and takes your `yes`. Then it turns Remote Login off, and runs `taskbox box add` and `taskbox connect github` from the controller.

At the Mac's screen instead, as your admin user: download `statement.json`, `statement.json.sig` and `taskbox-vX.Y.Z.tar.gz` from the release page into one folder, unpack the tarball there, and type `sh taskbox/install.sh --settings ORG/REPO`. It reads a public settings repo itself; a private one goes through `taskbox box install`. Then, from the controller, `taskbox box add` and `taskbox connect github`.

## Update

- A box updates itself, inside its update window, to the newest signed release on its channel (`update.channel`: `stable` or `beta`).
- `taskbox update [VERSION]`, as the admin at the box, installs one now. `taskbox rollback` goes back to a kept install.
- A box on v2.6.1 moves to v3 with `taskbox update v3.0.0-rc.1`. The steps are in the [release notes](docs/release-v3.0.0-rc.1.md).

## Commands

As the service account:
- `taskbox status` shows the box now. `-w` keeps watching.
- `taskbox check` lists every check with its fix. `--away` adds the checks for leaving the box.
- `taskbox job list` and `taskbox job timings` show past jobs and their timings.
- `taskbox size list` shows the VM sizes, what fits, and which jobs suit another size. A job picks a size by its label, such as `runs-on: [self-hosted, taskbox-linux-small]`.
- `taskbox tool list` shows the pinned tools and the base VM each kind's jobs clone, with the tools baked in. `taskbox image list` shows the images.
- `taskbox logs` shows the last day.
- `taskbox pause` takes no new jobs; `taskbox drain` also waits for running ones; `taskbox resume` undoes both. `taskbox stop` drains, then stops the loop, and `taskbox start` starts it.
- `taskbox template show test-job` prints a working job for your repo.
- `taskbox policy show` prints the Tailscale policy entries.
- `taskbox load start --pattern burst|day|merge`, on the controller, runs a load test in the test repo the box's settings name.

As your admin user:
- `taskbox update [--to VERSION]` installs the newest release, or the one named.
- `taskbox rollback` goes back to the kept install.
- `taskbox connect github` makes the box's two GitHub Apps true. `taskbox connect status` shows them. `taskbox disconnect github` takes the job source off.
- `taskbox remove` takes taskbox off the box.

Type `taskbox help` for all commands, and a command with `--help` for its flags. Agents log in as the agent account. Its shell runs the read commands and the workspace requests (`workspace request`, `wait`, `progress`) only.

On the controller, agents run as their own user, `taskbox-agents`, with a projects folder that is theirs alone. Their work reaches you as PRs; work in your own clones.
