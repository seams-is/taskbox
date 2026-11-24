# Building tailscale for the box

The box runs the open source `tailscaled`, the only Tailscale build for macOS that starts before anyone signs in. Tailscale publishes no macOS binary of it, so `.github/workflows/build-tailscale.yml` builds `tailscale` and `tailscaled` for the box (macOS on Apple silicon). It builds them twice, on a macOS runner and on a Linux runner, and fails unless the two builds are byte-identical.

## What it pins

- Tailscale v1.104.5, fetched through the Go module proxy and checked against the public checksum database.
- Go 1.27.4, downloaded from go.dev and checked against a pinned SHA-256. `GOTOOLCHAIN=local`, so Go fetches no other toolchain. `GOENV=off`, so no Go settings file on a runner changes the build.
- Two GitHub-owned artifact actions, pinned by commit SHA.

The release's `tailscale.tar.gz` holds `tailscale`, `tailscaled`, Tailscale's licence (`LICENSE-tailscale`) and Go's (`LICENSE-go`), both BSD-3-Clause, which asks for the notice to go with the binaries. THIRD_PARTY_NOTICES.md says the same.

A change to any pin is a pull request the owner merges. `versions.json` pins the published file by its asset ID on a release of taskbox's own repo, and by SHA-256.

## Running it

It runs by hand only (`workflow_dispatch`), from `main`, and takes no inputs. A run costs under $1. Check the org's Actions spend before each run.

## Checking a run before using its files

Do this on a device agents don't use, such as a phone.

1. The run makes a draft release named `tailscale-<version>`. Open the run: its header shows the event `workflow_dispatch` and the branch `main`.
2. Open the logs of both build jobs, `build (macos)` and `build (linux)`. Each prints a SHA-256 line for `tailscale` and for `tailscaled`. They must match each other.
3. Publish the draft. A reviewed PR then pins the asset ID and the SHA-256s in `versions.json`. Its `files` lines must equal both build jobs' lines.
4. The install checks the download against that pin, so a wrong pin stops the install.

The run's summary is written by the workflow, so it proves nothing on its own.

## Threats this answers

1. **Tampered Tailscale source.** The checksum database check. Left over: a bad release by Tailscale itself.
2. **Tampered Go.** The pinned hash and `GOTOOLCHAIN=local`. Left over: a bad Go release whose hash we pinned.
3. **A compromised build machine.** Two builds on two operating systems must match. Left over: the same compromise on both, or in Go itself.
4. **A run of unreviewed code.** `workflow_dispatch` runs the workflow file from whatever branch is dispatched, and an agent with the owner's token can push a branch and dispatch it. The owner's checks above tie a run to reviewed code on `main`. The job's own `main` condition only catches mistakes. Left over: anyone who can merge to `main` without a review. Require a review on `main`, and give agents a credential with no rights over workflows.
5. **Swapped files after the run.** The owner checks hashes on the box against the run logs read on a phone. Artifacts expire after 7 days. Left over: a takeover of the owner's GitHub account.
6. **Spend.** Run by hand, one at a time, with 20 and 5 minute ceilings.

## Not what Tailscale ships

Tailscale's own builds use its fork of Go. This one uses upstream Go with cgo off. The box's checks confirm it works.

## Updates

The open source `tailscaled` doesn't update itself. Whoever looks after the box watches Tailscale's security bulletins, and a fix is rebuilt here, reviewed and installed within 7 days.
