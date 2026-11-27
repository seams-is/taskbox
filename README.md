# taskbox

taskbox turns a spare Apple silicon Mac, the box, into a GitHub Actions runner host. Each job runs in a fresh Tart VM that is deleted afterwards.

Every job on a box is untrusted code. A box never runs a job that holds secrets: those stay on GitHub's hosted runners. MIT licensed ([LICENSE](LICENSE)). Tart, Softnet and Tailscale have their own licences ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).

## A new owner

1. Make a private copy of this repo in your organisation, named `taskbox`.
2. Make a GitHub App there: Contents read-only, Self-hosted runners read and write. Install it on your copy. Its ID is `appId`.
3. Make a runner group, limited to selected private repos, that lists the one repo whose jobs the box runs.
4. Build tailscaled with `.github/workflows/build-tailscale.yml` ([docs](docs/build-tailscale.md)), publish it on a release of your copy, and pin it in `versions.json`.
5. Copy `taskbox.example.json` to `taskbox.json` and fill in your values: `org`, `jobsFrom` (the one repo), `appId` and `runnerGroup` are yours. The rest have defaults.
6. Merge a PR and publish the first release: a tag such as `v3.0.0` on a commit on `main`.

## Set up the box

At the box, on Ethernet, as your admin user:

1. In a Safari Private window, sign in to GitHub. Open your App's page, then Credentials, then Key pairs, and click "New key". The key lands in Downloads.
2. Download `https://github.com/<org>/taskbox/archive/refs/heads/main.zip` and unpack it in Downloads.
3. In Terminal, type `sh ~/Downloads/taskbox-main/install.sh`.
4. It shows the release, its PR and its commit. If they match your release page, type `yes`.
5. Follow its prompts: the service account's password, the Tailscale policy entry ([docs](docs/tailnet-policy.md)), then log in as the service account.

As the service account, type `taskbox status -w` to watch, and `taskbox check`. Every line should say OK.

## Commands

As the service account:
- `taskbox status` shows the box now. `-w` keeps watching.
- `taskbox check` lists every check with its fix. `--away` adds the checks for leaving the box.
- `taskbox job list` and `taskbox job timings` show past jobs and their timings.
- `taskbox size list` shows the VM sizes, what fits, and which jobs suit another size. A job picks a size by its label, such as `runs-on: [self-hosted, taskbox-linux-small]`.
- `taskbox tool list` shows the pinned tools and the base VM each kind's jobs clone, with the tools baked in. `taskbox image list` shows the images.
- `taskbox logs` shows the last day.
- `taskbox stop`, `taskbox start` and `taskbox drain` pause and resume jobs.
- `taskbox template show test-job` prints a working job for your repo.
- `taskbox policy show` prints the Tailscale policy entries.
- `taskbox load start` runs a load test from a test repo of your own.

As your admin user:
- `taskbox update [VERSION]` installs the newest release, or the one named.
- `taskbox rollback` goes back to the kept install.
- `taskbox connect github` makes the box's two GitHub Apps true. `taskbox connect status` shows them. `taskbox disconnect github` takes the job source off.
- `taskbox remove` takes taskbox off the box.

Type `taskbox help` for all commands, and a command with `--help` for its flags. Agents log in as the agent account. Its shell runs the read commands and the workspace requests (`queue`, `wait`, `progress`) only.
