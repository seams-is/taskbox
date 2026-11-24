# taskbox

taskbox turns a spare Apple silicon Mac into CI for GitHub Actions. Each job runs in its own fresh VM, which is deleted afterwards. The owner installs it once and then leaves the box alone.

## What it promises

- **Generic.** Nothing in the code names an organisation, repo, App, account or machine. A box's own settings are in its `taskbox.json`, kept by its owner and never in this repo. Anyone can install it from scratch on a fresh Mac.
- **No hand-holding.** In normal use the owner never logs in, switches accounts or babysits the box. taskbox aims to set each setting itself and keep it true, rather than hand over a list of manual steps.
- **Away-ready.** The box survives restarts and power cuts. It heals itself where it can, and tells the owner when it can't. The owner can work from another office for days.
- **Measured.** Every job's phases are timed. Settings are tuned from data, not guesses.
- **Simple.** The least code and the fewest concepts that do the job reliably.

## What it never does

- **It never runs jobs that hold secrets.** Every job is untrusted code. Deploys, signing and releases stay on GitHub's hosted runners. A future major version may add a separate trusted box, on its own hardware.
- **It runs jobs from one repo only.** The runner group lists that repo, and which workflows may use it is the owner's to set.
- **It never bundles Tart.** It uses Tart under Tart's licence, with Lume as a fallback.
- **It never lets an agent stop CI or change the box.** Agents can read the box and nothing more. The owner installs, updates and merges.

## How it works

- **The loop**, running as `ci`: reads what's waiting from a job source, picks the next job with a scheduler that has no side effects, starts a VM, and cleans up after the job.
- **A VM per job**: macOS or Linux, from an image pinned by digest. It gets a one-job runner and sits behind Softnet's packet filter: it reaches the box for DNS only, and never the LAN or the tailnet.
- **Small root parts**: install, update, undo, remove, and a guard that keeps the network rules in place.
- **Checks**: `check` and `away` say what's wrong, and give one fix for each problem.
- **Remote access**: Tailscale SSH only. Agents log in as `remote`, whose shell runs taskbox's read commands only.

## Roadmap

- A repeatable load test.
- An access model of roles instead of accounts.
- A job source connected in one command, with the box's settings kept on the box.
- VM sizes by label, packed by memory.
- A pinned tool cache.
- Network diagnostics for each job.
- The controller: taskbox on the laptop, connected to each box, from signed public releases. It can set a box up over SSH.
- Workspaces: long-lived environments agents ask for and the owner approves.
- Remote updates.
- A trusted box, on its own hardware, for jobs that hold secrets.

## How we work

- **Every change is a PR.** The owner merges and releases. Agents never change the box.
- **Every PR has**: the scenarios it serves, a security review, a product review, and a plain "what it doesn't do".
- **Every PR is checked against its outcome**, on a Tart test Mac where that's possible, before it goes to the owner.
- **Releases** follow semver, one after another, with no compromise on quality.
