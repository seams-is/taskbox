# taskbox v3.0.0-rc.1

The first v3 trial, installed over v2.6.1 by v2.6.1's own signed hop.

## New

- Signed releases from this public repo, with update, rollback and a rollback watcher.
- The settings model: a private settings repo, guarded keys, and `taskbox confirm` at the box.
- Availability: `taskbox pause`, `drain`, `resume`, `stop` and `start` as ops.
- The GitHub key keeper: both Apps' keys stay with it, out of the service account's reach.
- The move from v2.6.1: v3's guard moves the settings, accounts, keys and daemons by itself, then proves v3. If v3 isn't proved, v2.6.1's watcher takes the box back.

## The visit, at the box, as the admin

1. `taskbox status` (optional), to pick a quiet moment. Nothing needs to stop first.
2. `taskbox update v3.0.0-rc.1`. Compare the fingerprint with `taskbox sign --fingerprint` on the signing Mac, then type yes.
3. `taskbox status -w`, until it says `proved: v3.0.0-rc.1`. A v2 job may still be running; the rollback clock waits for it.
4. `taskbox confirm`, with a yes to each guarded change, if status names any.
5. `taskbox box add` on the controller, then a check of its fingerprint at the box.

Steps 4 and 5 can be done later. `taskbox rollback --to 2.6.1` goes back while v2.6.1 is kept.
