# Scheduling scenarios (v2.2.2, before any code)

What the box does with its two slots today (v2.2.1), what it should do, and what `taskbox watch` should say, for a real CI load (anonymised). Written before the fix, for the owner's yes.

The design these scenarios test is [scheduling-design.md](scheduling-design.md). Each scenario below is one of its table tests, and the 17 Nov list and the 18 Nov stall are its replays.

The owner's answers: the second App, yes, being made; give way after 3 min and the floor at 8 min as starting guesses, measured from the box's own numbers; a waiting VM of each kind in a quiet hour; and a PR job that names a merge label runs at PR priority, option (a).

## The miss

On 17 Nov, v2.2.0 ran a real CI load (anonymised; the owner's `taskbox jobs`, 20:52 to 21:21 UTC):

- 18 Linux jobs, all in slot 1, one at a time, 0 to 4 min each.
- 2 macOS jobs in slot 2: one cancelled after 2 min at 20:52, one for 8 min at 21:08.
- Between them, slot 2 held a macOS VM waiting for a job, while Linux jobs queued.

Why: there is no second App yet, so the box can't see GitHub's queue. Without it, the rule is one waiting VM of each kind, and neither gives way. When a slot comes free, a kind with no VM at all goes first. While slot 1 runs a Linux job, macOS has no VM, so slot 2 always starts macOS. The v2.2.0 review's finding 2 put that rule in to stop Linux starving. It made this the normal case instead. My PR said a waiting VM never gives way without the queue. Nobody, me included, checked that against the real mix, which is about 9 Linux jobs to 1 macOS job per push.

What it cost: the Linux work was about 23 min of jobs plus a boot each. On one slot it took about 28 min. On two slots it would have taken about half that, less the 8 min slot 2 spent on the macOS job. That is an estimate: the list gives start times and lengths, and no queue times.

## What the box can know without the queue

- When each of its own VMs came up, and when its runner took a job (`jobAt`).
- A VM that takes a job within a minute of coming up means jobs of that kind were already waiting. Call that kind **busy**.
- A VM that waits minutes with no job means that kind is **quiet**.
- It can't know that a job of a kind with no VM is waiting. GitHub hands a job only to a runner whose labels match, and the first App can't read the repo's queue.

With the second App the box reads the queue every 15 s, and v2.2.0's queue rule already does the right thing: free slots go to queued jobs, merge jobs first, then the oldest, and a waiting VM gives way when every slot is taken and a queued job can't get one.

## The options without the queue

Costs use these guesses, to be measured (see Open questions): a Linux VM is ready about 1 min after it starts, a macOS VM about 2 to 3 min.

### A. An idle VM gives way after N minutes when the other slot runs the other kind

- Linux burst: the idle macOS VM gives way after N min, and the slot then starts... the kind with no VM, which is macOS again. A needs a memory of which kind gave way last, or it loops. With that memory, slot 2 turns Linux after N min.
- Cost: a macOS job that arrives after macOS gave way waits until a slot frees (a Linux job, 0 to 4 min) and then for a macOS boot, if anything ever starts macOS again. A alone never does while Linux keeps both slots busy: macOS starves.

### B. Start the kind that last took a job

- Linux burst: every free slot goes to Linux, since Linux took the last job. Good for the burst.
- Cost: once both slots are Linux, macOS starts only when a Linux VM gives way, and in B none does. In a quiet hour after a burst, both slots hold Linux VMs, and a macOS job waits forever. B needs a give-way and a floor for the other kind.

### C. Hybrid: follow the jobs, keep a floor (recommended)

1. **Quiet box** (no kind busy): one waiting VM of each kind, as today. A job of either kind starts with no boot.
2. **A free slot goes to a busy kind first.** In a Linux burst, a slot that frees, from Linux or from the macOS job, starts Linux again.
3. **A waiting VM gives way** after `giveWayMinutes` (3) with no job, when every slot is taken and the other kind is busy. So an idle macOS VM yields to a Linux burst after 3 min.
4. **A floor for the other kind.** No kind goes without a VM for more than `floorMinutes` (8) while the box is busy. After that, the next free slot starts it, and it waits `giveWayMinutes` before giving way again. That bounds how long a macOS job waits in a Linux burst: at most 8 min, plus the rest of a Linux job, plus a macOS boot.
5. **A paused kind** (3 failures in a row) leaves both slots to the other kind.
6. **Memory for one VM only:** it goes to the busy kind.

Costs of C:
- In a Linux burst, a macOS job that arrives after macOS gave way waits up to about 8 min plus a boot, against about 0 today. Today it waits 0 because slot 2 is held for it; Linux pays instead.
- Each give-way is a VM that booted for nothing: at most one every 8 min while busy, none while quiet.
- Two timings for the owner to read in `taskbox check`, both in `taskbox.json`.

C on 17 Nov, estimated: slot 2 runs the macOS job when its macOS VM takes it, and Linux the rest of the time. The Linux work ends about 10 min sooner. The 20:52 the macOS job starts as it did, since the box was quiet before it. The 21:08 the macOS job likely waits a few minutes: it was queued with the second push, while both slots ran Linux.

### Recommendation

C, as the no-queue rule, with the timings above until the owner's `taskbox jobs --json` gives real boot and wait times. And the second App, which only the owner can make (README, "The second App, for queued jobs", about 10 minutes on GitHub once). With it, the box needs no guessing: every scenario below is better with it. taskbox's rule is no hand steps beyond setup; this is a setup step, once.

## The scenarios

Each: what v2.2.1 does, what it should do (C without the queue, v2.2.0's queue rule with it), and what `taskbox watch` says. Today's watch lines are as they are; the new ones are proposals.

### 1. The real mix: a burst of short Linux jobs while one macOS job runs

- **Today, no queue:** Linux one at a time in slot 1. Slot 2 runs the macOS job, then holds an idle macOS VM.
- **Should, no queue (C):** slot 2 runs the macOS job; when it ends, slot 2 starts Linux, since Linux is busy. Both slots run Linux until the burst ends. Then one VM of each kind waits.
- **Should, with the queue:** the same, without the guess: the macOS job gets a slot because it is queued; the other slot, and slot 2 after the macOS job, take the oldest Linux jobs.
- **Watch, today:** `VM 2: macOS: Ready, waiting for a job from GitHub. (for 6 min)` while Linux jobs wait unseen.
- **Watch, should:** `VM 2: Linux: Running a job: check (for 1 min)`, and the `Choosing:` line in status says `following the jobs: Linux busy, a VM took a job within a minute`.

### 2. The same with the second App, and without it

- **With:** as above. Merge jobs first, then the oldest, both slots on Linux when only Linux waits, macOS the moment the macOS job is queued.
- **Without, today:** as in "The miss".
- **Without, C:** within about 3 min of the burst, both slots run Linux. the macOS job waits up to about 8 min plus a boot if it arrives mid-burst.
- **Watch:** `Choosing:` says `by GitHub's queued jobs` with the App, and `following the jobs, since there is no second App` without it.

### 3. Merge-queue jobs arriving mid-burst

- **Today, no queue:** every waiting VM registers both its kind's label and its merge label. A merge job lands on the next VM that comes up, behind no one, but GitHub may give that VM a PR job first. The box can't put merge jobs first.
- **Should, no queue:** the same. Without the queue the box can't see which job is a merge job.
- **Should, with the queue:** a free slot starts a VM with the merge label only, so the merge job gets the next slot before older PR jobs. A waiting PR VM gives way for it if every slot is taken. Only a job whose run is a `merge_group` run counts as a merge job (scenario 14).
- **Watch:** `VM 1: Linux: Running a job: check (merge queue)`, if the runner's job name says so. Not checked: whether the runner's "Running job" line shows the merge group.

### 4. A macOS job arriving while both slots run Linux

- **Today, no queue:** can't happen: slot 2 is always macOS while slot 1 runs Linux.
- **Should, no queue (C):** the job waits. When a slot frees, it starts Linux while Linux is busy, unless macOS has had no VM for 8 min; then it starts macOS. Worst case today's job lengths give: 8 min, plus a Linux job's end, plus a macOS boot.
- **Should, with the queue:** the next slot to free starts macOS, since the macOS job is the oldest job no VM can take.
- **Watch, should:** `VM 1: Linux: Running a job: <job> (for 1 min)` and `VM 2: Linux: Running a job: <job> (for 2 min)`, and status says `macOS: no VM for 5 min, one starts by 8 min`.

### 5. Nothing queued for an hour

- **Today:** one waiting VM of each kind, for up to `vmMaxHours` (24). 16 GB of memory committed to VMs doing nothing. A waiting VM goes if free memory falls under 4 GB, so the box's users get it back.
- **Should:** the same. One VM of each kind is what makes the next job start with no boot, and the memory rule already gives way to the box's users. An option I don't recommend: after 30 min quiet, keep only the Linux VM, saving 8 GB, at the cost of a macOS boot for the next the macOS job.
- **Watch:** `VM 1: macOS: Ready, waiting for a job from GitHub. (for 52 min)`, `VM 2: Linux: Ready, ...`. State: Ready.

### 6. A person's heavy app on the box using most of the memory

- **Today:** a start needs 12.2 GB free at normal pressure, and with a VM running, both VMs and 12 GB for the box within its 34.4 decimal GB, a 32 GB box. So with a heavy app holding 20 GB, one VM runs and slot 2 waits: `VM 2: No new VM: 8.1 GB of memory is free, and a VM needs 12.2 GB.` A waiting VM goes once free memory is under 4 GB. A running job goes on, and ends only at the top pressure level. On 17 Nov, `engine` ran at high pressure, beside the box's admin user.
- **Should:** the same rules. With room for one VM only, it goes to the busy kind. Today it goes to the kind with no VM.
- **Watch:** as today for the waiting slot. Status adds who else is logged in, as today.

### 7. A job arriving while a VM boots

- **Today:** GitHub holds the job until a runner with its label comes online. The booting VM's runner registers once the guest is sealed, then takes it. The wait is the rest of the boot.
- **Should:** the same. In C, a booting VM counts as waiting for its kind, so the box doesn't start a second VM of that kind for the same job.
- **Watch:** `VM 2: Linux: Starting a fresh VM. (for 40 s)`.

### 8. An update mid-queue

- **Today:** waiting VMs end at once. Running jobs finish, each within its own ceiling (`jobTimeoutMinutes` and 10). Then the loop restarts. Linux waits for the new install's proof, about 5 min, with a macOS VM up beside it for the VM-to-VM try. Jobs queue on GitHub meanwhile.
- **Should:** the same, and watch should say what the update waits for.
- **Watch, should:** `Update: installed v2.2.2, the loop restarts once 1 job finishes (<job>, for 2 min).` Then `VM 1: Linux: Proving a Linux VM ...`.

### 9. The Linux proof due mid-burst

- **Today:** the proof is due only after an update or a new image, so Linux jobs are already waiting on it. It takes a slot when one frees, waits up to 30 min for another job VM to try, and runs about 5 min. Linux jobs run once it passes.
- **Should:** the same. The proof gates Linux; it can't be skipped. With C, the other slot runs macOS if the macOS job waits, else it holds a macOS VM, which the proof tries.
- **Watch:** `VM 1: Linux: Proving a Linux VM under Softnet reaches nothing on the box or the LAN. It runs no job. (for 2 min)`. Status should add `Linux jobs wait for it`.

### 10. GitHub's queue unreadable

- **Today:** with the second App in place, a failed read falls back to one waiting VM per kind for that choice. A waiting VM reads again every 15 s.
- **Should:** fall back to C, the same as no App, and go back to the queue at the next good read.
- **Watch:** `Choosing: following the jobs, since GitHub's queued jobs couldn't be read`.

### 11. One kind failing three times

- **Today:** the kind is paused for an hour, and the box reads Failing. The other kind gets both slots: one VM waits, and when it takes a job, the other slot starts the next waiting VM. This case already works; only a quiet box keeps a single waiting VM.
- **Should:** the same (C rule 5 keeps it).
- **Watch:** `Now: Failing. macOS VMs ended 3 times in a row (no-guest), so the box starts no macOS VM for an hour`, and both VM lines show Linux.

### 12. 1 slot and 3 slots

- **1 slot (`vmsAtOnce` 1):** v2.1's turns, unchanged: a VM waits 5 min for a job of its kind, then gives way to the other kind, 30 min once both are quiet, at most 3 jobs of one kind in a row. C doesn't apply.
- **3 slots:** macOS at most 2. Today: one waiting VM of each kind, and the third slot starts another waiting VM only when a kind has none. With C: quiet, one of each and the third empty; busy, the busy kind takes every free slot it can, with the macOS cap of 2. Not on a 32 GB box: three 8 GB VMs don't fit its memory rule.

### 13. The 18 Nov stall, 23:28 to 23:59: merge-queue gate jobs waiting while later PR jobs ran

There is no job list for it here, so the details are as reported.

- **What happened:** the repo's merge queue put its three gate jobs in the queue at about 23:28. PR jobs queued after them ran first, on the one Linux slot the no-queue rule left, and the gate jobs waited about 31 min. The merge queue waits on those three, so every merge waited too.
- **Why, today:** two causes. First, the no-queue rule ran Linux one at a time, as in scenario 1. Second, without the queue the box can't order jobs at all: a waiting VM takes whichever job GitHub gives it, and GitHub doesn't promise to give the oldest, or a merge job, first.
- **Should, no queue (C):** two Linux slots in a burst, so the gate jobs wait about half as long. They still aren't first: the box can't tell them apart.
- **Should, with the queue:** the gate jobs are first. Each gets a VM registered for the merge label alone, which no PR job can take, and the next free slot goes to them before any PR job, however old. If every slot is taken by a waiting VM, one gives way for them. Their longest wait is the rest of one running job plus a boot.
- **Watch, should:** `VM 1: Linux: Running a job: check (merge queue)`, and status says `merge queue: 2 jobs waiting, first in line`.
- **A replay test:** this case goes in the replay test beside the 17 Nov list, so the fix shows the gate jobs starting first.

### 14. A PR job that names the merge label to jump the queue

A PR runs its own copy of the workflow, so a PR can put any job on `taskbox-linux-merge`. With the second App, that job would get merge priority and its own VM.

- **Today:** the queue rule trusts the label. A PR job on the merge label goes first, and gets a merge-only VM.
- **Should:** a job counts as a merge job only when its workflow run's event is `merge_group`. The queue reader already reads each queued and in-progress run in its run lists, and GitHub's run lists carry `event`. So this costs no extra read: the reader keeps `event` with each run's ID, and runs it hasn't listed aren't read at all. A job on a merge label from any other run is ordered as a PR job.
- **What its VM registers:** GitHub gives a job only to a runner that has every label the job names. So a VM with the plain label never takes this job. The owner chooses:
  - **(a) recommended:** start its VM at PR priority with both labels, the kind's and the merge label. The job runs, in its place in line. It gains nothing by its label. That VM could also take a real merge job, which only helps.
  - **(b):** never start a VM for it. The job waits on GitHub until it times out, and that PR's check fails. That is stricter, and a workflow mistake in the repo then shows up as a stuck check.
- **The repo's own check:** a check in the repo could refuse the merge label outside merge_group jobs. A PR can change that check too, so the box can't rely on it. It helps catch mistakes.
- **Not checked:** that a merge_group run's jobs list returns `merge_group` as the run's event while queued. GitHub's docs say so. The second App, once made, will show it.
- **Watch:** nothing new. A PR job on the merge label shows as any PR job.

## Open questions for the owner

1. Make the second App? It is about 10 minutes on GitHub once, and the box then needs no guessing.
2. C's two timings: `giveWayMinutes` 3 and `floorMinutes` 8. Real boot and wait times would set them better: `taskbox jobs --json` on the box, as remote, gives each job's VM start and job start.
3. In a quiet hour, keep a VM of each kind (recommended), or only Linux to free 8 GB?
4. A PR job that names the merge label: run it at PR priority (recommended), or never run it (scenario 14)?

## When it's built

- A test replays the 17 Nov list and the 18 Nov stall through the scheduler with a fake clock, and checks each job's slot and its wait, today's rule against C, with and without the queue, and with a PR job on the merge label.
- A threat model, and two independent reviews: security, and product with edge cases and UX.
