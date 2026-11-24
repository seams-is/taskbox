# Load test design (v2.6.0)

A repeatable load test for any box. A test repo of the owner's own sends the box bursts of short sleep jobs of each kind when the owner sets it off. The box serves it beside its real repo, never taking the last slot from real jobs, or instead of it for a while. Then `taskbox load report` scores the session against v2.4.0's acceptance criteria, real and load jobs apart. Nothing in it names an org, repo, App or label: they are settings.

Status: being built, v2.6.0, on v2.4.0's scheduling engine (#28), after v2.5.0 (away-ready), whose pieces it reuses. An independent product and edge-case review of this design came first, and the design below holds its answers.

The owner's decision: the `merge` pattern is approved. Its throwaway pull requests are opened and queued in the owner's own test repo, by that repo's workflow, with that repo's own `GITHUB_TOKEN`. The owner starts each run. Agents never open, queue or merge pull requests in any repo. The pattern ships only after the owner's trial on GitHub (below), since GitHub may not allow it as written.

## What it reuses

- **From v2.4.0 (#28):** the job source, the classes, the scheduler, each job's phases, `taskbox timings` and its acceptance criteria. The load test adds no rule of its own: it scores the same rules.
- **From v2.5.0 (away-ready), as hooks until its PR is up:**
  - **The watchdog workflow template** (`templates/taskbox-watchdog.yml`). It watches the real repo only. The test repo runs only when the owner starts it, so its jobs never wait on the box while load is off, and the watchdog never alarms for them. The test repo has no canary schedule.
  - **The checklist** (`taskbox away`, `src/away.ts`). `taskbox load on` runs its checks first and names any not met (built: `checklistNotMet` in `src/loadcmd.ts`), and the report lists them as they stood, so a slow result on a box that fails the checklist isn't read as the scheduler's.

## What the box does today

The box serves exactly one repo. Four places hold that:
- the settings require the source's `repos` to be exactly `jobsFrom`;
- the runner group check requires the group to list `jobsFrom` and nothing else;
- the key placement requires the source App to be installed on that one repo only;
- the queue reader reads one repo, and each job line names `jobsFrom`.

## What changes

1. **Repos, each with its own runner group.** The source's `repos` becomes a list, each with a role:
   ```json
   "repos": [
     "<org>/<real repo>",
     { "name": "<org>/<test repo>", "role": "load", "runnerGroup": "<group for the test repo>" }
   ]
   ```
   A plain name is the `jobs` repo, which must be `jobsFrom` and uses `runnerGroup`, as today. A `load` repo has a runner group of its own, which lists only that repo. Each VM registers its runner in the group of the repo it was started for. GitHub only gives a runner jobs from the repos its group lists, so a load VM can never take a real job, and a real VM can never take a load job, whatever their labels. The job line's repo is then exact. The real group still lists one repo, so the release before still works after an undo.
2. **The queue reader** reads the real repo first, with its full budget of 30 runs and 500 jobs, then the load repo with its own budget of 15 runs and 250 jobs, so load runs never crowd real ones out of view. Each item carries its repo and role. Each repo has its own token, and the load repo is read in its own try, only while a session is on and for 2 minutes after. A test repo that is gone, renamed or off the App never hides the real queue: the box keeps the real items and says why it can't read the test repo.
3. **Load ranks after every real job.** The code does this, so no setting can get it wrong: `decide()` adds `LOAD_RANK` to every load item's rank, so every load item comes after every real item. Within the load repo the classes still apply, so the `merge` pattern exercises merge priority among load jobs. A merge class can never rank a test repo's job above a real one.
4. **Load never takes the last slot.** Beside the real repo:
   - load VMs hold at most `vmsAtOnce - 1` slots, and each kind one place below its cap, so a real job of either kind always has a place;
   - a load job never makes a real VM give way: it may take only a waiting load VM's place;
   - a waiting load VM gives way to a real job like any worse class, and by itself after `giveWayMinutes` with no load job for it;
   - each load job has a ceiling of 20 minutes, whatever its workflow says, so a running load job can hold a slot for 20 minutes at most.

   So one real job at a time always gets a VM at once. A second real job at the same moment may wait for a running load job to end: the report shows that cost. With one slot, only `--only` can serve the test repo. Load is served only while the box can see the queue; without a view, waiting load VMs give way after `giveWayMinutes`, and `taskbox load` and `taskbox status` say test jobs wait.
5. **On, beside, or instead.**
   - As `ci`, `taskbox load on` serves the test repo beside the real one, for at most 4 hours (`--for 2h` sets less). Then it ends by itself.
   - `taskbox load on --only` serves the test repo alone for that time: the real repo's jobs wait on GitHub, as during `taskbox stop`. While real jobs or a real merge_group run wait, it names them and asks for `yes`, and it warns that a merge queue drops a pull request whose checks wait past the queue's timeout, 60 minutes by default.
   - `taskbox load off` ends it.
   - The window's end is a time in the state file, so it survives a restart. It is never more than 4 hours after the start, whatever the file says, and a clock that goes back more than 5 minutes past the start ends the session. The loop records each end, so a session stays ended when the clock comes forward again. The commands write the sessions file and the loop writes its own file of what it saw, so neither can undo the other's change. When it ends, running load jobs finish. No new load VM starts, and the box lists any test repo runs still queued, for the owner to cancel: the box's App is read-only.
   - When a load VM can't start because the test repo's runner group is missing or lists another repo, the box ends the session itself, keeps why, and `taskbox load`, `taskbox status` and the report say it. It doesn't try again each minute, and the real repo carries on.
   - While load is off, no load VM starts. The test repo's jobs only run when the owner starts them, so none should be waiting then; if some are, `taskbox status` names them.
   - Load never holds up an update: an update waits for running jobs, real or load, as always, and ends waiting load VMs.
6. **Sessions and the report.** Each `taskbox load on` starts a numbered session, kept in the state file with its start and end. `taskbox load report` scores the last session, or `--session N` an earlier one, from its start to its end. The 48 hours of `taskbox timings` don't apply, and `timings` leaves the test repo's jobs and its VMs' give-ways out:
   - the acceptance criteria, for the real repo's jobs and the load repo's jobs apart;
   - each side's give-ways apart, from a give-way log that marks a load VM's;
   - **real jobs a load VM went ahead of**, which must be 0: a load VM asked for while a real job had waited more than a minute with no VM. With a job source only;
   - **real jobs that waited for a running load job**, a real job whose wait passed a boot and 2 minutes while a load job ran. This is the cost of running beside, shown with no limit;
   - test jobs still queued when the session ended, which the scores leave out;
   - the checklist's box items as they stood at `load on`;
   - how many reads of GitHub the session took, or not known when the loop restarted during it.

   `--json` gives the same. Each pattern says which criteria it measures. `day`, the full pattern, measures them all.
7. **The workflow.** `templates/taskbox-load.yml`, beside v2.5.0's templates, which the owner copies into the test repo. It has no concurrency group, so runs may overlap. It runs only on the box's labels, so it uses no GitHub-hosted minutes, and starts only on `workflow_dispatch` and, for the `merge` pattern, `merge_group`. `taskbox load workflow` prints it, made from the box's settings with v2.5.0's generator (`canaryLabels` and `fingerprint` in `src/watchdog.ts`), so the owner never edits labels by hand. A dispatch takes a pattern, with fixed counts so each run of a pattern is comparable:
   - `canary`: one tiny job per kind, on each kind's own label, as `taskbox canary` asks for: each kind's boot and wait on a quiet box;
   - `burst`: 12 Linux jobs at once, each sleeping a random 30 to 240 s;
   - `push`: one macOS job of 6 minutes with 9 Linux jobs, as a real push;
   - `day`: six `push`es' worth at once, with 6 macOS jobs and 54 Linux jobs, enough for every criterion;
   - `merge`, after the trial: K throwaway pull requests in the test repo, put in its merge queue, so their gate jobs run as `merge_group` runs. Its driver job opens and queues them; it isn't a sleep job, and the report leaves it out of the scores.

   To space pushes apart, the owner starts `push` again; the laptop controller can do that later. Beside the real repo, `day` needs 3 or more VMs at once to finish well inside 4 hours. A job that sleeps to space them would hold a slot.
   Every job other than the driver only sleeps. Nothing builds, fetches or keeps anything.

## The merge pattern's trial

GitHub may not allow the pattern as written. The owner runs this trial once, in the test repo, before agents build the pattern.
- **Merge queues on private repos** need GitHub Enterprise Cloud. Without it, the pattern is left out, and merge priority is tested on the real queue only.
- **No pull request checks.** Pull requests opened with `GITHUB_TOKEN` start no `pull_request` runs. So the test repo's ruleset requires the merge queue and no status check on the pull request. The `gate` job runs on `merge_group` only.
- **The token's permissions.** Queueing needs the GraphQL `enqueuePullRequest` call. The workflow asks for `contents: write` and `pull-requests: write`.
- **The approval setting.** The setting that lets Actions create pull requests also lets them approve. Turn it on for the test repo only, never for the organisation. Check by hand that it is off on the real repo: the box's App can't read that setting.

The trial passes when one dispatch of `merge` with K = 2 gives two `merge_group` runs whose `gate` jobs wait for the box. Until it passes, `merge` is not in the workflow.

## Security

- The test repo is the owner's own and private, with the same trust as the real repo: its jobs run in the same sealed VMs, under the same Softnet rules and ceilings.
- Separate runner groups mean GitHub itself keeps load jobs off real VMs and real jobs off load VMs.
- Load never passes real jobs: it ranks after every real item, never holds the last slot beside the real repo, and the report counts any real job that waited behind it.
- The `merge` pattern's driver job opens and queues pull requests in the test repo only, with that repo's own `GITHUB_TOKEN`. The owner approved this, and starts each run. Agents never open, queue or merge pull requests: their "never queue" rule stands for every repo. The setting that allows it is on for the test repo only.
- `taskbox load on --only` stops the real repo's jobs for up to 4 hours, like `taskbox stop`. Only `ci` may type it, it asks first while real jobs wait, and it ends by itself.

## The owner's steps

The README's Load test section holds them, one at a time with a pass each: setting up the test repo, running a load test, and removing the test repo. Their order follows the App check:
- the App must be on `jobsFrom`, may be on the test repo when `taskbox.json` names one, and must be on no other repo;
- so setting up changes `taskbox.json` and updates the box first, and adds the test repo to the App last;
- removing takes the test repo off the App first, then out of `taskbox.json`.

`taskbox check` has a `Test repo` row, which proves the test repo's runner group exists, is limited to selected private repos, and lists the test repo alone. The `merge` pattern adds the trial above.

## Order

1. v2.4.0 (#28): the engine and its acceptance criteria.
2. v2.5.0 (away-ready): its watchdog template and checklist.
3. This, v2.6.0, its own PR (#29), built beside v2.5.0. It merges v2.5.0 in, by merge commit, when v2.5.0's PR is up, and wires in the two hooks then. The `merge` pattern follows the owner's trial.

## Laptop controller later

The controller can run the per-test steps for the owner: `taskbox load on` over SSH, the dispatch through the GitHub API with the owner's sign-in, spaced `push`es, and the report's `--json` on its screen.
