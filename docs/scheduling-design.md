# Scheduling design

How taskbox decides what each VM slot does. It is a product design: nothing in it is one owner's, one org's, one repo's or one App's. Those are settings. The scenarios in [scheduling-scenarios.md](scheduling-scenarios.md) are its test cases.

Status: built in v2.4.0. Where the build differs from this design:
- The box-wide gates (the guard, memory, disk, an update, a stop, the Linux proof) stay in the loop, which already checks them before every start inside the start gate. The scheduler sees their effect: a paused kind isn't open, a slot proving or held back isn't free.
- The loop keeps one worker per slot. Each worker asks `decide()` for its own slot's decision when it is free, and again every 15 s while its VM waits, to see whether it should give way. One call decides for every slot, and a claim records a start in the same step, so two slots asking at once never start two VMs for one job.
- `taskbox timings` needs 10 jobs of a kind before it suggests. `floorMinutes`, `busyForMinutes` and `sourcePollSeconds` are kept as set: a later version can measure the gaps between a burst's jobs.
- One source and one repo: `sources` takes one source, its `repos` exactly one repo, `jobsFrom`, and only that source is read. The load test design lifts it.
- Labels: any label in GitHub's shape, except the ones every runner has. The code names none. A job is the box's only when every label it asks for is its kind's, or one GitHub gives that kind's runners itself.
- From the two reviews: give-way counts from when a VM is ready, and only a ready VM gives way for idleness; a kind isn't busy after one of its VMs gave way, until a VM takes a job fast again; only a slot that asks is free; with a source, a kind with no VM goes first within a class, a VM no job needs may give way while it boots, and a job a VM took since the snapshot was read is counted as taken.

## What it must do

- Run jobs from a job source on a fixed set of VM slots, as many at once as the box can hold.
- Put the jobs that matter most first, by rules the owner sets, and give priority only to jobs the source vouches for.
- Work well with no view of the queue at all.
- Never let one kind of job starve another.
- Decide in a part with no side effects, so every scenario is a table test and a real day's jobs can be replayed.
- Measure every job's phases, so the timings the rules use come from the box's own numbers.
- Let a new owner set it up from scratch on their own GitHub org, App and repos, step by step.

It doesn't:
- run jobs for more than one owner on one box;
- pick VM sizes per job (each kind has one size, as today);
- talk to any CI system but GitHub Actions in the first build. The interfaces allow another.

## The parts

```
 job source ──snapshot──▶ ┌───────────┐ ──decisions──▶ the loop ──▶ VM engine (Tart)
 (adapter)                │ scheduler │                  │      ──▶ runner provider (GitHub JIT)
 slots, history, waits ──▶└───────────┘ ◀──events───────┘
                               ▲
                         settings: kinds, classes, timings
```

- **Job source**: what is waiting. An adapter: GitHub Actions, or none.
- **Priority classes**: rules from settings that rank waiting jobs.
- **Scheduler**: a function. State in, decisions out, each with a reason.
- **The loop**: does what the scheduler decides, and reports what happened as events. It owns every side effect: VMs, runners, files, the log.
- **Runner provider**: how a VM takes a job. For GitHub, a just-in-time runner with the labels the decision names. It is separate from the job source: the box can run jobs with no source.
- **Measurement**: every phase of every job, stored, with medians that set the timings.

## 1. The job source

```ts
interface JobSource {
  readonly id: string;                 // "github-actions" or "none"
  read(now: number): Promise<Snapshot>;
}

type Snapshot =
  | { known: true; at: number; items: WaitingItem[] }
  | { known: false; at: number; why: string };   // no source, or it couldn't be read

interface WaitingItem {
  key: string;            // opaque and stable while it waits, such as the job's ID
  labels: string[];       // what the job asks a runner for, less the provider's own default labels
  queuedAt: number;       // when it started waiting
  origin: { event?: string; trusted: boolean };  // what the source vouches for about where it came from
}
```

- `known: false` is a full answer: the scheduler then uses its no-source rules. "No source" is an adapter that always answers it, with the reason "no job source is set".
- A source never decides priority. It reports, and the classes rank.
- A source reads at most once every `sourcePollSeconds` (15), however many slots ask, as v2.2.0 does today.

### The GitHub Actions adapter

Settings, all the owner's own:

```json
"sources": [{
  "type": "github-actions",
  "appId": 123456,
  "repos": ["example-org/app"]
}]
```

- It reads as a GitHub App with Actions read only, installed on the repos named, and nothing else. Its key is in root's key folder, as the second App's key is today. The App that registers runners never gets the repos: its key could then mint tokens for their source.
- On each read: the queued and in-progress runs of each repo (at most 30 runs per read), then each run's jobs, with ETags, so an unchanged list costs nothing.
- Each queued job becomes one item. `labels` are the job's labels less GitHub's own runner defaults (`self-hosted` and the OS and architecture labels), which every runner has.
- **The trust check.** `origin.event` is the run's `event`, from the same run list, so it costs no extra read. `origin.trusted` is true. Labels come from the workflow, which a PR can change in its own copy. The run's event comes from GitHub, and a PR can't change that. So the classes match a trusted event for priority, and a label alone never gives priority.
- Several repos: one App installation can cover several. The runner group must let each of them use the box's runners. The first build keeps one repo, as `jobsFrom` today, and the shape allows more.

### The no-source adapter

- Always `known: false`. The scheduler then follows the jobs it sees its own VMs take (section 3).

### Later adapters

- Another CI system brings its own source and runner provider. Neither the scheduler nor the classes change.

## 2. Priority classes

Settings rank what waits. The first class whose rule matches wins. The last class has no rule and takes everything else.

```json
"classes": [
  { "name": "merge", "when": { "event": ["merge_group"], "label": { "endsWith": "-merge" } } },
  { "name": "jobs" }
]
```

- `when.event`: the item's `origin.event` is one of these, and the source marked it trusted.
- `when.label`: one of the item's labels matches. `equals`, `endsWith` or `startsWith`.
- Both in one rule: both must match.
- Inside a class, the oldest first.
- A rule that names an event a source never reports matches nothing. `taskbox check` says so.

The owner's answer (a), as rules: a PR job that names a merge label matches no event, so it lands in `jobs`. It runs in its turn, on a VM registered for the labels it asks for, since GitHub gives a job only to a runner with every label it asks for.

What a class gives:
- **Order.** A free slot goes to the first waiting item of the best class that no waiting VM can take.
- **Its own VM.** A VM started for a class with a rule registers only the item's labels, so no item of a lower class can take it.
- **Give-way.** When every slot is taken, a waiting VM gives way for an item of a better class that can't get a slot.

With no source, there is nothing to rank: classes do nothing, and `taskbox check` says the classes wait for a job source.

## 3. The scheduler

```ts
function decide(s: SchedulerInput): Decision[];

interface SchedulerInput {
  now: number;
  settings: { kinds: KindSettings[]; classes: ClassRule[]; timings: Timings; slots: number };
  slots: SlotState[];          // each slot: free, starting, waiting, running, proving or cleaning, with its kind, labels and times
  snapshot: Snapshot;          // the source's last answer
  history: KindHistory[];      // per kind: last job taken and how fast, last give-way, failures, pause
  gates: Gate[];               // box-wide: the guard, memory, disk, an update, a stop, the Linux proof
}

type Decision =
  | { slot: number; do: "start"; kind: string; labels: string[]; why: string }
  | { slot: number; do: "give-way"; why: string }
  | { slot: number; do: "prove"; why: string }
  | { slot: number; do: "wait"; until?: number; why: string };
```

- No clock, no files, no network: everything it reads is in its input. The loop calls it on every event and every `tickSeconds` (5).
- Every decision has a `why`, in words a person reads. watch, status and the log show it.
- The loop checks each decision against the facts once more before it acts. A start still goes through the gate: one start at a time, the memory and disk checks for one more VM, and the guard's read. A gate that says no turns the start into a wait, and the next call sees why.

### Rules, in order

1. **Gates first.** An update, a stop or a halt: no starts, and waiting VMs end. The guard closed: no starts while Screen Sharing is on. Memory or disk for one VM only: one start, for the best item, or the busy kind. The Linux proof due: a slot proves, as today.
2. **Pauses.** A kind whose VMs failed `failsToPause` (3) times in a row starts nothing for `pauseMinutes` (60).
3. **With a known source:**
   - A free slot starts a VM for the first item, best class then oldest, that no waiting VM can take, within the kind's cap (macOS at most 2).
   - With nothing that no waiting VM can take: one waiting VM of each kind (the owner's answer 3).
   - A waiting VM gives way when every slot is taken, an item can't get a slot, and no item needs this VM. One VM gives way: of that item's kind first, else the highest slot.
4. **With no source (option C):**
   - A kind is **busy** when one of its VMs took a job within `busyWithinSeconds` (60) of being ready, and that was within the last `busyForMinutes` (10).
   - Quiet: one waiting VM of each kind.
   - A free slot goes to a busy kind first.
   - A waiting VM gives way after `giveWayMinutes` (3) with no job, when every slot is taken and another kind is busy.
   - The floor: no kind goes without a VM for more than `floorMinutes` (8) while the box is busy. Then the next free slot starts it.
5. **One slot:** the turns of v2.1.0, unchanged.

### Tests

- **Table tests:** each scenario in [scheduling-scenarios.md](scheduling-scenarios.md) is a row: input, expected decisions and their `why`.
- **Replays:** a list of jobs with their queue times and lengths, run through `decide` and a model of the loop on a fake clock. Each job gets a slot and a wait, checked against bounds. The 17 Nov list and the 18 Nov stall come first, under each rule set: today's, C, and the known source.
- **Properties:** a random load of both kinds, checked so that no kind waits past its floor, no slot runs two VMs, macOS is never above 2, and every wait is bounded.

## 4. Measurement first

Every job records when each phase began, from when its slot was asked for a VM:

| phase | from |
|---|---|
| `queued` | the source's `queuedAt` for the item it was started for; absent with no source |
| `asked` | the decision to start |
| `cloned` | the engine's clone returned |
| `guestUp` | the guest agent answered |
| `sealed` | the seal and the box's tries passed |
| `runnerStarted` | the runner started in the guest, ready for a job |
| `jobStarted` | the runner's "Running job" line |
| `jobDone` | the runner ended |
| `deleted` | the engine deleted the VM |

- Stored in the job's line in `jobs.jsonl` as `phases`, milliseconds after `asked`. A line stays version 1: older readers, such as the release before after an undo, skip the new field.
- `taskbox jobs` shows a phases line: `Boot 72 s, waited 4 s from queued, ran 2 min 30 s, cleanup 9 s.` With no source, `took a job 4 s after it was ready` in place of the wait.
- `taskbox jobs --json` gives `phases` in each job. That is a new field, so the answers' version goes to 3.
- `taskbox timings` gives, per kind, over the last 50 jobs: the median and the 90th percentile of boot (`asked` to `runnerStarted`), job wait (`queued` to `jobStarted`), run and cleanup, and how many VMs gave way. Then it lists each timing setting beside what the numbers suggest, in one line each.
- `taskbox check` has a `Timings:` line: the settings in force, and whether the last 50 jobs support them.
- **Timings are settings with defaults.** `taskbox timings` suggests; the owner, or an agent's PR, changes them. The box never changes its own settings: what it does stays predictable and in git.

| setting | default | set from |
|---|---|---|
| `giveWayMinutes` | 3 | the median macOS boot, with the median Linux job length |
| `floorMinutes` | 8 | how long a macOS job may wait in a burst |
| `busyWithinSeconds` | 60 | the median wait of a VM whose job was already queued |
| `busyForMinutes` | 10 | the gaps between jobs within one push |
| `sourcePollSeconds` | 15 | GitHub's rate limit, with ETags |

## 5. Setup from scratch

What a new owner does to connect a job source, in their own org. It replaces the README's "second App" steps, and names nothing of ours.

1. On GitHub, in your org's settings, make a GitHub App. Name it what you like, such as `<your org>-taskbox-queue`. No webhook. Repository permissions: Actions, Read-only. Nothing else. Installable on this account only.
2. Install it on your org, on the repos whose jobs the box runs, and only those.
3. Put its App ID and those repos in your `taskbox.json` under `sources`, in a PR to your copy of taskbox.
4. At the box, as your admin user, make a private key for the App. It lands in Downloads.
5. Type `taskbox update`. It checks with GitHub that the key is that App's, that the App can read Actions and nothing else, and that it is installed on exactly those repos. Then it places the key and deletes the Downloads copy. Anything else stops it with one line saying why.
6. As `ci`, type `taskbox check`. A pass: `OK   Job source: github-actions, App <id>, 1 repo, read 12 s ago`, and `Choosing: by the job source`.

Without steps 1 to 6, the box runs on the no-source rules.

**The laptop controller later** (v2.4.0, SSH setup): the controller runs the same steps for the owner. It opens the App page with the settings filled in, waits for the install, writes `sources` in the owner's settings PR, and runs `taskbox update` over SSH. `taskbox sources --json` gives what each source read last, for its screen. Nothing in the box's code changes for that.

## 6. On today's box, and the upgrade

What changes on a box already running v2.3.0 when this is installed:

- **Settings.** `sources`, `classes` and `timings` are new. Each kind gets `labels`, the labels its VMs may register, in place of `label` and `mergeLabel`.
  - The release before reads the new `taskbox.json` with its own rules during the update. So the new file keeps the old keys (`label`, `mergeLabel`, `actionsAppId`, `jobsFrom`, `slots` 1, `vmsAtOnce`) beside the new ones until a later release. The new `loadConfig` reads the new keys and checks the old ones agree. I will run the release before's `loadConfig` on the new file, as for `slots` in v2.2.0.
  - With no `sources` and an `actionsAppId`, the new code reads the old settings as one GitHub source. So a box that hasn't moved works the same.
- **Jobs.** Linux jobs spread over both slots in a burst, with or without the source. With the source, merge-queue gate jobs go first.
- **Screens.** watch and status show each slot's `why`. `taskbox jobs` shows phases. `taskbox timings` and the `Timings:` and `Job source:` lines are new. `--json` goes to version 3; the controller (#12) adds `phases`.
- **The update.** One `taskbox update`, as usual. Waiting VMs end, running jobs finish, the loop restarts. The Linux proof runs again for the new install, about 5 min.
- **Undo.** The release before ignores the new keys and the `phases` field. Its scheduling comes back with it.

## Not decided here

- Moving to a single `labels` list per kind changes the settings shape. An alternative keeps `label` and `mergeLabel` as they are and adds `classes` only. I recommend `labels`, since it is the general shape.
- Whether `taskbox timings` should also live in the controller's screens. Probably, at v2.4.0.
