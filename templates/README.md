# Workflow templates

Workflows for the repo whose jobs your box runs. taskbox fills each one in from the box's settings. On the controller, template apply opens one pull request with them, through your own GitHub session; you merge it. `taskbox template show NAME` prints one, and `taskbox template list` says whether the repo's copies match.

- `box-check`: the hourly box check, on a hosted runner. It fails, and GitHub emails you, when jobs for the box wait with no hold, when the box has been held too long, when a workspace request waits too long, or when GitHub's API can't be read on 3 runs in a row. Your controller keeps the box's hold in the repository variable `TASKBOX_HOLD_<BOX>`; it runs out by itself within 12 hours.
- `test-job`: one tiny job per VM kind on the box, so the hourly box check has a job to watch on a quiet day.
- `load`: the load test's workflow, for the test repo the settings name. The controller's `taskbox load start` writes it there and starts it.

Intervals and limits are the `away` settings. GitHub turns off scheduled workflows in a public repo after 60 days without activity.
