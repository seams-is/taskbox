# Workflow templates

Workflows for the repo whose jobs your box runs. taskbox's own repo runs none of them. taskbox
fills each one in from the box's own settings and prints it; later releases add theirs here.

## The watchdog and the canary (v2.5.0)

They tell you when the box stops taking jobs, even when it is dead, asleep or at the FileVault
screen. The design is in [docs/away-ready-design.md](../docs/away-ready-design.md), "Alerts".

- The watchdog runs on a GitHub-hosted runner. It fails when a job for one of the box's labels has
  waited longer than the wait (30 minutes by default) while no job for the box is running.
- The canary asks the box for one tiny job per kind of VM, so the watchdog has a job to watch on a
  quiet day. It runs on the box.

Set them up, one step at a time:

1. At the box, or from the laptop, type `taskbox watchdog`. It prints the watchdog, filled in with
   every label the box serves, the wait and the interval. Save it as
   `.github/workflows/taskbox-watchdog.yml` in the repo whose jobs your box runs.
2. Type `taskbox canary`, and save what it prints as `.github/workflows/taskbox-canary.yml` there.
3. Commit both yourself. GitHub emails a scheduled workflow's failures to the person who created
   it, or to whoever last changed its `cron:` line, so that person should be you. A change an
   agent's pull request makes to the `cron:` line moves the emails to whoever the commit names.
4. On GitHub, in your notification settings, choose to be notified by email when a workflow run
   fails.
5. In the repo's Actions tab, run "taskbox watchdog" by hand with "Fail on purpose" ticked. You
   should get an email about the failed run. Run it again without the tick: it should pass.
6. At the box, as ci, type `taskbox away`. Its Watchdog and Canary lines read the latest run of
   each, through the job source's App, and say whether the copy in the repo was made from this
   box's settings, is turned on, and ran lately.

When the box's labels or the settings change, make both again and commit them: `taskbox away` says
when a copy no longer matches.

The settings, in `taskbox.json`'s `away`, each with a default:

- `watchdogIntervalMinutes`: 60. One of 15, 20, 30, 60, 120, 180, 240, 360, 480, 720 or 1440, or
  0 to run it by hand only.
- `watchdogWaitMinutes`: 30. It must be shorter than the canary's interval, so a quiet day's
  canary is seen waiting well before the next one starts.
- `canaryIntervalMinutes`: 60, from the same list.

How long it takes: a dead box is seen at the first watchdog run after a job for it has waited the
wait. On a busy day that is about the wait plus one watchdog interval: 90 minutes with the
defaults. On a quiet day, add up to one canary interval: about 2 and a half hours. GitHub can run a
scheduled workflow late, or drop a run, so these are typical times. While the box stays dead, every
watchdog run fails and emails: hourly with the defaults.

What it costs: each watchdog run is one short job on a hosted runner, billed at least a minute.
Hourly is about 720 minutes a month, every 30 minutes about 1,440, none nothing. A public repo pays
nothing. Each canary starts a fresh VM on the box and takes that slot for a few minutes, so it can
delay a real job by as much; it uses no hosted minutes. The watchdog's token can read this repo's
Actions and nothing else; the canary gets no token. If GitHub's own API doesn't answer, the
watchdog passes with a warning on the run, so an outage at GitHub doesn't email you; a long outage
at GitHub also hides a dead box until it ends.

Keep it running: GitHub turns off scheduled workflows in a public repo after 60 days with no
activity in it. `taskbox away` says when the watchdog or the canary is turned off; enable it again
in the repo's Actions tab. Whoever enables it gets the emails from then on.

The canary's jobs are real jobs on the box: they show in `taskbox jobs`, and a job source counts
them.

## The load test (v2.6.0)

`taskbox-load.yml` is the load test's workflow, for a test repo of your own, never the repo whose
jobs your box runs. `taskbox load workflow` fills it in from the box's settings and prints it, as
`taskbox canary` does; its `canary` pattern asks for the same jobs as the canary. The steps are in
the README, Load test.
