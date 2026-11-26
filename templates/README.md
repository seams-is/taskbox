# Workflow templates

Workflows for the repo whose jobs your box runs. taskbox fills each one in from the box's settings and prints it. Save the output in that repo and commit it yourself, so GitHub's failure emails reach you.

- `taskbox template show box-check` prints a workflow that fails when a job for the box has waited too long. It runs on a hosted runner.
- `taskbox template show test-job` prints a workflow that sends the box one tiny job per VM kind, so the watchdog has a job to watch on a quiet day.
- `taskbox template show load` prints the load test's workflow, for a test repo of your own.

Intervals are the `away` settings in `taskbox.json`. `taskbox check --away` says whether the copies in the repo still match the box. GitHub turns off scheduled workflows in a public repo after 60 days without activity.
