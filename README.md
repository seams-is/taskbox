# taskbox

taskbox turns a spare Apple silicon Mac, the box, into a GitHub Actions runner host. Each job runs in a fresh Tart VM that is deleted afterwards.

Every job on a box is untrusted code. A box never runs a job that holds secrets: those stay on GitHub's hosted runners. MIT licensed ([LICENSE](LICENSE)). Tart, Softnet and Tailscale have their own licences ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).

## Install

Every org installs this repo's signed releases. Its own settings live in its private settings repo: `taskbox.json`, from `taskbox.example.json`, and `boxes/<box>.json` for each box.

- The controller: unpack this repo's newest release in Downloads, then type `sh ~/Downloads/taskbox/install-controller.sh <org>/<repo>`, naming this repo.
- A box: at the box, on Ethernet, as your admin user, unpack the same release in Downloads and type `sh ~/Downloads/taskbox-main/install.sh`. Type `yes` once the release it shows matches the release page. Its prompts cover the service account, the Tailscale policy entry ([docs](docs/tailnet-policy.md)) and the service account's login.

Then `taskbox check`: every line should say OK.

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
- `taskbox update [VERSION]` installs the newest release, or the one named.
- `taskbox rollback` goes back to the kept install.
- `taskbox connect github` makes the box's two GitHub Apps true. `taskbox connect status` shows them. `taskbox disconnect github` takes the job source off.
- `taskbox remove` takes taskbox off the box.

Type `taskbox help` for all commands, and a command with `--help` for its flags. Agents log in as the agent account. Its shell runs the read commands and the workspace requests (`queue`, `wait`, `progress`) only.

On the controller, agents run as their own user, `taskbox-agents`, with a projects folder that is theirs alone. Their work reaches you as PRs; work in your own clones.
