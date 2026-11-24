# Away-ready design (v2.5.0)

The owner leaves the box and works from somewhere else for days. Today taskbox needs someone at the box too often, and some of its failures look like Ready. This design makes every failure it can fix fix itself, makes every other failure show as Failing or Needs you to every reader with who acts and whether it can be done from away, and tells the owner even when the box is dead. It is a product design: nothing in it names an owner, an org, a repo or a machine. Those are settings.

Built on v2.4.0 (`taskbox/v2.4.0-scheduling`). Facts about today's code are read from that branch, with file and line. Where the build differs, the text says "Built so".

Built so, in short:
- The restart plan row is in `taskbox away` only: a box nobody leaves needs no plan, so `taskbox check` doesn't fail on it.
- Screen Sharing on is a FAIL in `taskbox away` that says why and when to keep it: it is also the owner's way to reach the box's screen.
- The new check rows are in their own module, `src/awaychecks.ts`, with one line in `src/checks.ts`.
- The loop restarts itself when a beat is stale: a timer reads the beats of the slots whose workers are live once a minute, skips the tick after a sleep or a clock jump, and never restarts a loop that is ending (an update, or Softnet running as root). Three restarts within 6 hours read Failing, "At the box". A frozen process runs no timer, so the guard, root's LaunchDaemon, also reads the beats from outside the loop on its full pass each minute, and restarts a loop that is still stale 3 minutes past the loop's own bound (scenario 3, "Built so").
- A slot waiting at the start gate beats for the gate's ceiling, and "starting a VM" and "proving Linux" take limits built from their real waits.
- The watchdog and canary are made by `taskbox watchdog` and `taskbox canary` from the box's settings. Once an hour the loop, as ci, checks the copies in the jobs repo and keeps the result, so remote's `taskbox away` reads it.

## The outcome

- The owner runs `taskbox away` before leaving. Every line says OK, or says what to do at the box before leaving.
- Away, the owner looks at nothing unless GitHub emails them. Then `taskbox status` from the laptop, as `remote`, says what is wrong, who acts, and whether it can be done from away.
- No failure reads Ready. A loop that stops moving reads Failing within its own deadline plus 5 minutes, to every reader.
- What software can't fix (a restart at the FileVault screen, a power cut with no UPS, a dead router) still reaches the owner, through a check that runs off the box. The time it takes is stated below.

## Who acts, in every Failing line

Today every Failing state says "Nothing to do: agents fix it" (src/state.ts:19, 53-57). Away, that hides what only the owner can do. Each Failing state from this design names one of three:

- **Waits by itself:** nothing to do; it says when it tries again.
- **From away:** a step on GitHub or the laptop, such as installing the App again.
- **At the box:** a step that needs the box's keyboard; status says so, so the owner can plan.

## Each failure as a scenario

Each scenario says what happens today, what should happen, what `status`, `watch` and `check` say, and how the owner learns of it. "Away" means the owner reads `taskbox status` or `check` from a laptop as `remote`, and email from GitHub.

### 1. A restart stops at the FileVault screen

- **Today.** macOS installs an update itself, the power goes, or the kernel panics. The box restarts to the FileVault screen. tailscaled is on the encrypted volume, so Tailscale goes too. Nothing runs and nothing can be reached.
- **Should.** Restarts are rarer, and the owner learns of one within the alert's detection time.
- **status, watch, check.** None can be reached. The laptop's `taskbox status` says the box is offline in Tailscale.
- **Owner learns.** The watchdog workflow fails, and GitHub emails (section "Alerts").
- **Fixes in software.** check rows for automatic macOS updates and security responses, and for restart after power loss. Recovery itself needs an owner option (section "FileVault restarts").

### 2. GitHub refuses the box before a VM is cloned

- **Today.** The App's key is revoked, the runner group changes, a JIT config is refused, the clock drifts outside the token's window, or GitHub rate-limits. `startAndRun` calls `gh.token("runners")`, `runnerGroupId` and `gh.jitConfig` before its only `try` (src/loop.ts:659-665, try at 682). The error reaches `slotWorker`, which logs it, sets outcome `prestart-failed` and sleeps 60 s (loop.ts:1289-1308). The state written before them (loop.ts:650: `slot: "starting a VM"`, `failing` cleared) stays, and computeState reads it as Ready (src/state.ts:93-94). No counter exists for this outcome (src/kinds.ts:39). `GitHub.call` has no time limit (src/github.ts:62-73).
- **Should.**
  - The runner chain (the runners token, the group, the JIT config) is counted as one operation, for the whole box. Only a JIT config that GitHub gives clears the count; the `contents` token minted for `head` before it (loop.ts:654) neither counts nor clears.
  - Each failure is classed: `key` (401: the App's key or JWT is refused), `gone` (404: the App's installation or the runner group is gone), `refused` (403 with no rate-limit header, or 422), `rate` (429, or 403 with `Retry-After` or `x-ratelimit-remaining: 0`), `timeout`, `network`, or `server` (5xx).
  - `rate` is one wait for every slot, until `Retry-After` (seconds or an HTTP date) or `x-ratelimit-reset`, worked out against the response's Date header and capped at 15 minutes. It reads Waiting and is not counted.
  - `server`, `timeout` and `network` are counted, and wait 60 s as today.
  - After `githubFailures` in a row (default 3), the box reads Failing, with the class, the first failure's time and who acts.
  - The clock: a `key` failure whose response Date header differs from the box's clock by more than 60 s is reported as the clock instead, "fast" or "slow". The App's JWT is valid from 60 s before to 540 s after its mint (github.ts:19), so a fast clock fails within a minute and a slow one only after about 9.
  - Every GitHub call has a 30 s limit, inside `GitHub.call`, so every caller gets it.
- **status, by class.**
  - `key`: `Failing: GitHub refuses the App's key (401), 3 times since 14:02.` Next: `At the box: make a new key for the App and install it (README, the key step).`
  - `gone`: `Failing: GitHub says the App's installation or the runner group is gone (404).` Next: `From away: on GitHub, check the App is installed on the repo and the runner group exists.`
  - `refused`: Next: `From away: on GitHub, check the App's permissions and the runner group's repos.`
  - clock: `Failing: the box's clock is 4 min fast, so GitHub refuses its key.` Next: `At the box: turn on "Set time and date automatically".`
  - `server`, `timeout`, `network`: `Failing: GitHub didn't answer 3 times since 14:02.` Next: `Waits by itself: it tries again every minute.`
- **check.** A new `GitHub` row. As ci or root it mints an installation token (one read-only call) and reports OK, or the class, with the clock's offset. `remote` can't read the App key, so as `remote` the row shows the loop's last recorded result for the runner chain and its age.
- **Owner learns.** Failing on status; jobs wait, so the watchdog fails after its wait.

### 3. The loop stops moving

- **Today.** A fetch with no time limit hangs, or a slot worker waits on something that never ends. Loop state has no heartbeat; `slotAt` changes only when the slot does (loop.ts:1190). As ci, status asks launchctl whether the loop runs (src/stopstart.ts:26-35), which a hung process passes. As anyone else the loop's state is unknown. Six fetches have no time limit: github.ts:62, 133 and 141, src/install.ts:109, and `sys.fetch` (src/sys.ts:105-107), which the public address and others use.
- **Should.** A heartbeat with deadlines.
  - Each beat is `{ at, phase, until }`: the time, what the writer is doing, and the latest time its next beat can come. The writer sets `until` from the longest single wait it is about to make: 30 s for a GitHub call, 10 min plus a minute for the proof's guest script (loop.ts:546), the job's own ceiling for a job's run, the wait it was given for a rate limit or for room on the disk (loop.ts:318).
  - The loop writes a box beat from `runLoop` before the slot workers start, through `cleanLeftovers` and the first image's pull (loop.ts:1092-1095). Each slot worker writes its own beat on every pass and before every long wait.
  - A pull's beat lasts to the pull's own 6-hour ceiling (loop.ts:247). While it runs, status reads Downloading, which the pull's record already marks when no bytes arrive ("No progress for N min"), so a stuck pull shows there. (Built so: a beat on each byte count would rewrite the state file every 10 s for hours.)
  - A timer never writes a beat, so a hung await stops it.
  - A beat is stale when the time is past its `until` plus `heartbeatGraceMinutes` (default 5).
- **Order in computeState.** A stale beat is read after Stopped, ci away and the loop not running (state.ts:59-71). So `taskbox stop`, a logged-out ci, and a loop that stopped itself (loop.ts:1302) keep their own words. (Built so, after the Tart test: it comes before a failed check and Downloading, since a hung loop leaves both as they were, and status would never read Failing.)
- **status.** `Failing: the loop hasn't moved since 14:02 (slot 1, starting a VM).` Next: `Waits by itself: launchd restarts the loop if it ends. If this stays, at the box: type taskbox stop, then taskbox start.` watch shows the same, redrawn.
- **check.** A `Loop heartbeat` row: OK with each beat's age, or FAIL naming the stale one.
- **Owner learns.** Failing on status; jobs wait, so the watchdog fails.
- **Built so: the guard watches the loop from outside (after the Tart test).** The loop's own check runs on a timer inside the loop, which a frozen process never runs. So the guard (src/guard.ts), root's LaunchDaemon that runs from boot, reads the beats on each full pass, once a minute (src/loopwatch.ts). It restarts the loop with `launchctl kickstart -k gui/<ci>/<the loop's label>` only when all of these hold:
  - the beat is stale 3 minutes past the loop's own bound, so the loop's own check goes first;
  - the slot is one the loop says it runs;
  - it found the same stale beat on its last pass too, so a loop that started a moment ago (at boot, with the last run's beats still in its file) writes its own beat first;
  - launchd says the loop runs now, with a process, so a loop that stopped (taskbox stop, an update, Softnet as root) is never started by it;
  - the loop hasn't written that it is ending on purpose;
  - its passes came a minute apart (no sleep or clock jump), and it hasn't restarted the loop in the last 15 minutes.
  - A worker that returns (for an update, say) clears its slot's beat, so on a box with two slots the guard never takes an ended worker for a frozen loop while the other slot runs a job.
  - The watch runs beside the guard's 2 s pf check, never holding it up, with 5 s and 10 s limits on `id` and launchctl. A clock that jumps back makes it wait a pass.
  - Each restart goes into root's own log, `/var/log/taskbox-guard.log`, and a root-owned record. The loop that starts next logs it ("the guard restarted the loop at 14:52: slot 1 hadn't moved since 13:30 (running a job)") and counts it with its own restarts, so three in 6 hours read Failing. A restart launchctl refused is logged and not counted.
  - Threats: it runs as root and can end the loop's running jobs. It acts on one label, a constant, in ci's own launchd domain; nothing it reads names what it acts on. It reads ci's loop state as root without following a link, without blocking on a FIFO, at most 1 MB, and only a regular file of ci's; anything else is no beat. A forged beat in ci's file can only make it restart ci's own loop, which ci can do anyway. It writes only its own record in /var/run.
  - Doesn't fix: a loop frozen while it is ending on purpose (status then gives the fix at the box, without a promise that it waits by itself); the guard itself frozen (launchd restarts it only if it exits); a loop that freezes again at once (it reads Failing after three restarts).

### 4. Tart prunes the image it needs

- **Today.** `TART_NO_AUTO_PRUNE` is set on pull only (src/tart.ts:73); clone runs with PATH, HOME and LANG only (tart.ts:36, sys.ts:44-49). A pruned image is caught before the clone, by `imageProblem` (loop.ts:634-639): "no manifest" sets `failing` and returns `failed`, so the kind pauses and the box sticks at Failing. A kind is held for good once `ensureImage` reads ready (loop.ts:1206-1211).
- **Should.** Clone runs with `TART_NO_AUTO_PRUNE=1`. When `imageProblem` says the image is missing, or a clone fails and the image is then missing, the kind stops being held and `failing` for it is cleared. The pull section, which already pulls a kind that isn't held, fetches it again. `startAndRun` never pulls, so it never holds the start gate through a pull.
- **status.** `Downloading ... again: the image went missing.`
- **Owner learns.** Nothing to do: it fixes itself. The log keeps a line.

### 5. Leaked job VMs fill the disk

- **Today.** `cleanLeftovers` deletes job VMs only at loop start (loop.ts:186-195, called at 1092). A VM whose delete fails is only logged (loop.ts:948, 564). Over days, the disk fills and every start waits for room.
- **Should.**
  - Every slot, and the Linux proof, records its VM's name in its `held` entry before it clones (today a slot's `vm` is set only after `guestReady`, loop.ts:710, and the proof's never, loop.ts:1225).
  - On every idle pass, a free slot lists the VMs and deletes each job VM (named `job-`, made from no image) whose name no `held` entry records.
  - As a second guard, it skips a VM whose name's time (loop.ts:180) is under 2 minutes old.
- **status.** Nothing while it works. The log keeps `Removed a VM left from a job.`
- **check.** The existing Free disk row; `taskbox away` also checks room for one more pull.
- **Owner learns.** Nothing to do.

### 6. ci's session ends

- **Today.** ci is logged out (a crash, a forced logout). The loop's LaunchAgent runs only in an Aqua session (launchd/local.taskbox.loop.plist:25-26). status reads Needs you (state.ts:63).
- **Should.** Unchanged in software: logging ci in needs the box's screen. Needs you says `At the box: log in as ci.` The watchdog catches the waiting jobs. An IP-KVM is the remote fix.
- **Owner steps.** Leave ci's session locked (Control-Command-Q), which keeps it running.

### 7. The network changes

- **Today.** The box reads its public address from one source, `https://1.1.1.1/cdn-cgi/trace`, with a 10 s limit (src/checks.ts:264-274). If that fails, no VM starts (loop.ts:641-646), and the box reads Waiting and tries again in a minute.
- **Should.**
  - Two sources, by name, in `publicAddress` (default the Cloudflare trace and an IPv4-only plain-text source). The box asks both.
  - Softnet blocks every address they return, one or two. A connection with two WAN links, or a carrier NAT that changes address, gives two different answers, and both are blocked.
  - An answer counts only if it is one IPv4 address on a line of its own (the trace's `ip=` line, or the whole plain-text body) and comes over checked TLS. A network that hijacks one source's address gives a failure, which the other source covers.
  - With no answer from either, no VM starts, as today.
- **Privacy.** The second source learns the box's public address at every VM start, as Cloudflare does today. The setting names which; the owner may keep one source.
- **status.** `Waiting: neither public-address source answered. It tries again in a minute.`
- **check.** The Public address row says which sources answered and what they said.
- **Owner steps.** Connect the box by Ethernet; `taskbox away` checks the default route's interface.

### 8. A Linux proof that couldn't run keeps Linux off for 6 hours

- **Today.** Any failed proof retries after 6 h (`PROOF_RETRY_MS`, src/proof.ts:17, loop.ts:1248), including runs that never got going: no public address (loop.ts:520), a failed clone (530), a guest that never answered (537), and a thrown error (1237). Only a held gate (loop.ts:526) and a failed pre-start check (1228-1231) retry after 10 minutes.
- **Should.** A proof result carries `infra: true` only when it couldn't run: the gate held (`notRun`), no public address, the clone or `set` failed, the guest never answered, or an error was thrown. Those retry in `proofRetryMinutes` (default 15), and hourly after 4 in a row; the count clears on any finished proof. Every other result, including the box reaching the VM (loop.ts:539), Softnet running as root (541), the guest reporting fewer tries than asked (proof.ts:115), and any reached address, keeps the 6 h wait and Failing.
- **status.** On the box's own word (Ready or Running for macOS), a detail line: `Linux: the proof couldn't run (the guest never answered). It tries again at 14:30.` A real proof failure stays Failing.

### 9. Other users' apps hold memory

- **Should.** Unchanged in software. `taskbox away` counts other logged-in users and says to log them out before leaving.

### 10. tailscaled wedges

- **v2.5.0.** Out of scope: an IP-KVM reaches the box regardless. A liveness probe in the guard is a later step.

### 11. The guard hangs while Screen Sharing is on

- **Should.** `taskbox away` says to turn Screen Sharing off while away, since the guard's rules matter only while it is on.

### 12. The runner version is retired by GitHub

- **Today and v2.5.0.** JIT runners update themselves when GitHub asks. A runner that can't register is a GitHub failure in scenario 2.

### 13. A week alone: smaller things

- **Tailscale key expiry.** A tagged node's key doesn't expire by default. `taskbox away` reads the box's own key expiry from the bundled Tailscale's status and FAILs if it falls within 30 days.
- **The clock.** `taskbox away` compares the box's clock with GitHub's Date header (as ci) and FAILs past 60 s.
- **Times on screens.** Box times are the box's own time zone, and the box's screens say so once, with the zone's name. The laptop shows its own.
- **The log in memory.** `Log.lines` grows with every line (src/log.ts:38). It keeps the last 10,000 lines.
- **launchd's own output** goes to `/dev/null` for every taskbox service (`StandardOutPath` in each plist), so no file grows. (Built so: no row is needed.)

## The fixes

Each fix has tests, and every number is a setting with a default. The settings go in one `away` object in `taskbox.json`, checked by a new `checkAway()` as `timings` is checked (src/config.ts:68, 137-141, 344-352): unknown keys refused, each number an integer in its bounds, `publicAddress` one or two distinct known names, `restartPlan` one of three words.

```json
"away": {
  "githubFailures": 3,
  "heartbeatGraceMinutes": 5,
  "proofRetryMinutes": 15,
  "publicAddress": ["cloudflare-trace", "ipify"],
  "restartPlan": "accept"
}
```

`publicAddress` takes names of sources taskbox knows, never URLs, so a setting can't point the box at an address of its choosing. Left out, `away` takes these defaults, except `restartPlan`, which is unset until the owner chooses.

1. **GitHub failures.**
   - `GitHub.call` gets its 30 s limit and throws a `GitHubError` with its class, the status, the wait GitHub asked for, and the Date header's offset.
   - The runner chain goes through one wrapper, `runnerChain(f)`, that takes the calls as a function, so any arguments `runnerGroupId` takes pass through. It counts box-wide in loop state (`github: { failures, since, last, offsetS }`), and a rate wait sets one `githubWaitUntil` for every slot.
   - computeState reads Failing at `githubFailures`, with the class's next step.
   - Tests: each class from fake responses, with 403 told apart by its headers; `Retry-After` in seconds and as a date; `x-ratelimit-reset` against the Date header; three runner failures read Failing while `head` succeeds; a JIT success clears; the clock class only with a 401; a fetch that never answers ends at 30 s; status reads Failing as ci and as `remote`.
2. **Heartbeat with deadlines.**
   - `beat(phase, untilMs)` for the box and each slot, in loop state and its shared copy.
   - computeState takes `now`, and reads a stale beat after Stopped, ci away, the loop not running and Downloading.
   - Every fetch gets a limit: GitHub 30 s, the install's downloads 10 min, the public address 10 s.
   - Tests: a worker hung on a fake fetch reads Failing after its deadline plus the grace; a 50-minute job, a 10-minute proof script and a 77 GB pull with steady progress never read stale; a pull with no bytes for its window does; a stopped loop, a logged-out ci and Downloading keep their words; the shared copy carries every beat; watch redraws Failing.
3. **Tart.** Clone's env adds `TART_NO_AUTO_PRUNE=1`. A missing image (from `imageProblem` or after a failed clone) drops the kind from `held` and clears its `failing`. Tests: the clone's env; a missing image re-pulls through the pull section and never inside `startAndRun`; with the image present, no pull.
4. **Leaked VMs.** `held` records a VM's name before its clone, for slots and the proof. A free slot's idle pass calls `cleanLeakedVms()`. Tests: an orphan is deleted; a slot's booting VM, the proof's VM and an image are kept; a VM under 2 minutes old is kept; two slots cleaning at once delete each orphan once.
5. **Linux proof.** `ProofResult` gains `infra`, set only for the listed causes. Tests: each listed cause retries in 15 min; the fifth in a row waits an hour; a finished proof clears the count; each security result waits 6 h and reads Failing; the detail line on Ready.
6. **Rows for restarts.**
   - `macOS updates` reads `AutomaticallyInstallMacOSUpdates` from the managed preferences first (`/Library/Managed Preferences/com.apple.SoftwareUpdate.plist`), then `/Library/Preferences/com.apple.SoftwareUpdate.plist`. It FAILs when the setting is on, and also when the key is missing, since macOS's default can be on. Security responses (`CriticalUpdateInstall`, `ConfigDataInstall`) are named on the row: they can restart the box too.
   - `Restart after power loss` reads `autorestart` from `pmset -g`. It is SKIP on a Mac that has no such setting. With FileVault on, it brings the box only to the unlock screen, so the row says so unless `restartPlan` is `kvm` or `filevault-off`.
   - Both run in check and `taskbox away` only; a VM's start doesn't wait on them. Tests: each value from fake `defaults` and `pmset` output, the managed file first, a missing key, a laptop.
7. **Public address.** Both known sources asked; every address returned is blocked; each answer must be one IPv4 address on its own line over checked TLS. Tests: both agree; two different answers both blocked; one fails; both fail; extra text; an IPv6 answer; a bad certificate.
8. **`taskbox away`**, in `src/away.ts`, one piece with `--json` that a later release can reuse.
   - One screen of checks for leaving, each OK or FAIL with its fix and where it is done, ending `Ready to leave.` or `N things to do before leaving.`
   - It runs every check row, plus:
     - the heartbeat is fresh, and the runner chain's last result;
     - the clock against GitHub;
     - automatic macOS updates are off, and restart after power loss is on;
     - sleep is off, and the default route is Ethernet;
     - Screen Sharing is off, and no other user is logged in;
     - each kind's image is held, and the Linux proof passed in the last day;
     - free disk is above the floor with room for one more pull;
     - the Tailscale key's expiry;
     - `restartPlan` is set.
   - `remote` may run it: it joins remote's shell commands (src/shell.ts) and prints the same rows with no user names, as check does for `remote` today. Rows that need ci or root (the App key, ci's files) show the loop's last recorded result and its age. The default route, `fdesetup isactive`, `pmset -g` and the preference files can be read by any user.
   - Tests: every row from fakes; the verdict; `remote`'s copy names no user; `--json` is one line in a versioned shape.
9. **Cap the log in memory** at 10,000 lines. Test: the 10,001st line drops the first.

`restartPlan` is `kvm`, `filevault-off` or `accept`. With `kvm` or `accept` it changes only what check and `taskbox away` say. With `filevault-off` it also lets the FileVault row (src/checks.ts:163-164, run before every VM) pass with FileVault off, which is that option's whole point, so the setting is the owner's written choice.

## What each job used (added to v2.5.0)

So VMs can later be sized per label, and three or four jobs run at once on a 32 GB box, each job's line records what it used.

- **How.** Once a job starts, the loop asks the VM engine for one sample every 30 seconds (`VmEngine.usage`), one at a time, each within 10 seconds. The guest's own probe (src/guest.ts) answers: on macOS, `vm_stat` (anonymous pages less purgeable, wired and compressed, as Activity Monitor counts memory used), `hw.memsize`, and `top`'s CPU line over one second; on Linux, `MemTotal` less `MemAvailable`, and `/proc/stat` a second apart, leaving out steal. Each probe's output is cut at 64 KB. A sample that fails, times out or can't be read is skipped; it never fails or slows the job. The guest is untrusted, so a sample counts only when its CPUs match the VM the box made and its memory total is within 10% of it; and a record out of shape is dropped when the line is read, keeping the line. The box's memory pressure is kept as before, its highest level in the job line.
- **The job line** gains `labels` (the labels the runner took, label first) and `usage`: the number of samples, memory at peak and its 90th percentile with the VM's total, and CPUs busy at peak and their 90th percentile with the VM's CPU count.
- **`taskbox jobs`** shows a "Used:" line for each job with a record. **`taskbox timings`** shows, per label (the runner's first label, with the job's class, such as merge) and VM size, over its last 50 jobs with a record, the median and 90th percentile of each job's peak memory and peak CPUs. `taskbox timings --json` gives the same under `usage`, in MB and CPUs, and `taskbox jobs --json` gives each job its `labels` and `usage`, or null. The answer version stays 3, since no field changes its meaning.

What it doesn't measure:
- disk use and disk speed, network, or a GPU;
- the VM's own memory on the box: it is the guest's view, which leaves out the hypervisor's overhead and the file cache the guest would give back;
- swap and paging inside the guest;
- time the host gave other VMs (steal on Linux), which is left out of CPU busy;
- anything between samples: a spike shorter than 30 seconds can be missed;
- CPU over more than the one second each sample watches;
- a job's memory apart from the guest's other processes (the runner, and the image's own services, are counted with it).

## Alerts that work when the box is dead

The box can't report its own death, so the alert runs elsewhere. Two ways were weighed.

**(a) A watchdog workflow, recommended.** Two workflows for the repo whose jobs the box runs, made from the box's own settings so their labels can't drift from the box. `taskbox watchdog` and `taskbox canary` print them, filled in from `templates/` (a shared home for workflow templates; later releases add theirs beside them). templates/README.md walks the owner through them.

- The watchdog runs on a GitHub-hosted runner, every `away.watchdogIntervalMinutes` (60 by default; 0 for by hand only), written as its cron line. It reads the repo's queued and running jobs with `gh api`, every page, and fails when a job asking for one of the box's labels has waited longer than `away.watchdogWaitMinutes` (30) while no job for the box is running, so a busy box doesn't raise an alarm. If GitHub's own API doesn't answer, it passes and says so. A run by hand with "Fail on purpose" ticked fails, so the owner can see the email arrive.
- The canary asks the box for one tiny job per kind of VM, every `away.canaryIntervalMinutes` (60), so the watchdog has a job to watch on a quiet day. At most one waits per label. The wait must be shorter than the canary's interval, or a quiet day's dead box is never seen; `checkAway` refuses it otherwise.
- Each run's name carries a fingerprint of the settings its file was made from. `taskbox away` reads each workflow's state and latest run through the job source's App (Actions read only) and says whether the copy in the repo was made from this box's settings, is turned on, and ran lately. The App can't read the file itself without Contents read, which this design doesn't add.

**Detection time.** A dead box is seen at the first watchdog run after a job for it has waited the wait: about 90 minutes on a busy day with the defaults, and up to about 2 and a half hours on a quiet day, which adds a canary interval. GitHub may run a scheduled workflow late or drop a run, so these are typical times.

**Notification.** GitHub emails a scheduled workflow's failures to the person who created it, or to whoever last changed its `cron:` line, or re-enabled it (GitHub's docs, "Notifications for workflow runs"). So the owner commits both files. A dead box fails every watchdog run until it is back: hourly with the defaults.

**Keeping the watchdog alive.** GitHub turns off scheduled workflows in a public repo after 60 days with no activity in it (GitHub's docs, "Disabling and enabling a workflow"). `taskbox away` reads the state and says when either is off.

**Cost.** Each watchdog run is one short job on a hosted runner, billed at least a minute: hourly, the default, is about 720 minutes a month; every 30 minutes about 1,440; none nothing. GitHub's free private-repo allowance is 2,000 minutes a month on the Free plan and 3,000 on Team (not checked against today's prices); a public repo pays nothing. The canary runs on the box and uses no hosted minutes, but each starts a VM and takes a slot for a few minutes. Permissions: `actions: read` on the watchdog's own token, and none for the canary; no secret and no App, and nothing reaches the box.

**(b) A status issue the box writes.** The loop keeps an issue up to date with its state (`State.notify` exists for this, src/state.ts:14, and nothing reads it). It needs `issues: write` on an App the box holds, which widens what a stolen box key can do. It costs no minutes. It can't report a dead box: a stale issue is only noticed by someone reading it.

**Recommendation.** Build (a). (b) adds detail for a box that is alive but stuck, which status from the laptop already gives; it is left out. Tailscale's device-offline emails, if the owner's plan has them, are a third, free signal (not checked).

These templates live in `templates/`. taskbox's own repo runs no workflow from them.

## FileVault restarts: the owner's choice

A restart for any reason stops at the FileVault screen. Three options. The software is the same for each, except the FileVault row under `filevault-off`; check and `taskbox away` say which plan is set and what it leaves open.

**1. Accept it, with precautions (`restartPlan: accept`). The recommended default.** FileVault stays on, and a restart waits for someone at the box to type the password.
- Precautions: automatic macOS updates off, so macOS doesn't restart the box by itself; a UPS for the box and the router, so a short power cut doesn't restart it; the watchdog, so GitHub emails the owner when a restart has left the box at the FileVault screen; someone near the box who can type the password after a cut longer than the UPS lasts.
- Threats: none added. Cost: the UPS, and downtime until someone is at the box.

**2. An IP-KVM on Tailscale (`restartPlan: kvm`). The later option.** A small device with the box's keyboard, screen and power, reached over Tailscale, types the FileVault password at the boot screen.
- Fixes: restarts, ci's session ending (6), a wedged tailscaled (10).
- Threats: whoever controls the device controls the box's keyboard and screen at the login window. Mitigations: tag it (`tag:kvm`) and let only the owner's user reach it in the tailnet policy; no vendor cloud account; its own login with a second factor; firmware updates; it never stores the FileVault password, which the owner types through it.
- Cost: the device, and one more node to keep updated.

**3. FileVault off, and ci logs in by itself (`restartPlan: filevault-off`).** The box restarts all the way to ci's session.
- Fixes: restarts, unattended.
- Threats: the disk can be read by whoever takes the box: the App's private key, ci's files and keychain, other users' work. Automatic login keeps ci's password in a reversible form on disk. A stolen box means revoking the App key and every token at once.
- Needs `restartPlan: filevault-off` for the FileVault row to pass.

Not checked: whether this macOS release can unlock FileVault over SSH at boot. If it can, it would need Remote Login on and a path to the box's LAN that doesn't go through Tailscale, which reopens what taskbox closes today.

The owner chooses, and the agents set it in the box's `taskbox.json` in a release. A box with no plan set reads FAIL in `taskbox away` until one is.

## Owner steps, one at a time

For the recommended plan, accept with precautions. At the box, as the admin user, before leaving:

1. Turn automatic macOS updates off. System Settings, General, Software Update, then the (i) beside Automatic updates: turn off "Install macOS updates". Leave "Download new updates when available" as you like: downloading doesn't restart the box. "Install Security Responses and system files" can still restart the box; leave it on for security fixes, or turn it off too if a restart is worse for you than a late security fix. `taskbox away`'s "macOS updates" line says which is set.
2. Fit the UPS (a purchase). Plug the box and the router into the outlets its battery backs: many UPSes also have outlets with surge protection only. If it has a USB cable, connect it to the box: macOS sees a UPS only over that cable, and then `taskbox away`'s UPS line shows it with its battery level. A UPS without a USB cable can't be seen.
3. System Settings, Energy: "Start up automatically after a power failure" on, where the Mac has it. After a cut longer than the UPS lasts, the box starts again as far as the FileVault screen, and someone near the box types the password.
4. System Settings, General, Date & Time: "Set time and date automatically" on.
5. Connect the box by Ethernet.
6. Log every user but ci out. Turn Screen Sharing off. Lock ci's session (Control-Command-Q); locked, it keeps running.
7. Type `taskbox update` as your admin user, so the box has its plan (`restartPlan: accept`).
8. Type `taskbox watchdog` and `taskbox canary`, save what each prints in `.github/workflows/` of the repo whose jobs the box runs, commit them yourself, and run the watchdog once with "Fail on purpose" ticked to see the email arrive (templates/README.md).
9. Confirm: type `taskbox away` as ci. Every line should say OK, WARN or SKIP, and it should end "Ready to leave.". It shows the restart plan as accepted and automatic macOS updates off. Its UPS line reads OK when it sees a UPS and the box runs on AC through it, with the battery level and whether it is charging; WARN when it sees none, since a UPS without a USB cable can't be seen: then check yours by its own light or screen. A WARN never stops "Ready to leave."; the verdict names it after the rest.
10. From the laptop, `taskbox status` and `taskbox away` reach the box over Tailscale.

For an IP-KVM later: set it up on Tailscale with the mitigations above, tell the agents, and they change `restartPlan` to `kvm` in a release. For FileVault off: System Settings, Privacy & Security, FileVault, off; and System Settings, Users & Groups, "Automatically log in as": ci; then the agents set `filevault-off`.

What software can't fix: a restart while FileVault is on and nobody is at the box; a power cut longer than the UPS lasts; the router or the ISP changing; hardware failing; Tailscale's own outages.

## What it does not do

- Restart the box, log ci in, or type a password, from anywhere.
- Unlock FileVault.
- Probe or restart tailscaled (a later step: a liveness probe in the guard).
- Write a status issue on GitHub.
- Count failures of the job source (src/queue.ts); a source that fails leaves the box running jobs without its view, as today.
- Update taskbox by itself.
- Run any job that holds a secret, or add a trusted runner.
- Change the macOS settings it checks. It says what to change, and the owner changes them.

## Not decided here

- The restart plan: the owner's.
- The watchdog's interval: hourly by default; `away.watchdogIntervalMinutes` changes it.
- The second public-address provider, among those that answer over TLS with one IPv4 address in plain text.
