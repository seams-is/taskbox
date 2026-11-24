# VM engines

taskbox runs every job in a fresh VM. The program that makes and runs those VMs is the VM engine. Tart is the one engine (`src/tart.ts`). `taskbox.json`'s `engine` is `"tart"`, the default and the only value allowed.

Everything taskbox asks of an engine is one interface, `VmEngine` in `src/vm.ts`. The loop, the Linux proof, the guest steps, the checks and the install use only that interface. Nothing but `src/vm.ts` imports `src/tart.ts`. Swapping in another engine, such as Lume, means a new file beside `tart.ts` and one line in `src/vm.ts`'s factory. It also means everything below.

## What an engine must give

The VM is the security boundary between a job and the box. A job is root in its VM, and on Linux it runs Docker as root too. So an engine must give all of these, on the box, before it may run a job:

1. **A fresh clone per job.** `clone` makes a new VM from the cached image, copy-on-write, with nothing from an earlier job in it. `size` sets CPUs and memory on the clone, never on the image.
2. **A delete after every job.** `stop` and `delete` remove the VM and its disk, whatever the job did. A VM left over is found by `list` and removed at the loop's start.
3. **An image pinned by digest and checked before each clone.** `pull` takes `host/repo@sha256:<digest>`, and `imageProblem` says whether the cached image is still exactly that digest. Tart's check reads the cached OCI manifest's SHA-256.
4. **Exec without SSH.** `exec` and `execStream` run commands in the guest over a channel the network can't reach. For Tart that is the guest agent over the VM's control socket. SSH in the guest is turned off before the runner starts, and the box then tries its ports and must be refused.
5. **Network isolation equal to Softnet's.** `start(vm, net)` takes a `NetPolicy` and must enforce all of it:
   - the box itself is blocked, both ways, but DNS to the box;
   - the box's public address is blocked, so a job can't reach the router through it;
   - the LAN is blocked: the box's LAN addresses, the router, every private range;
   - the tailnet is blocked: `100.64.0.0/10`, the box's tailnet address and `100.100.100.100`;
   - it is stateful, so nothing on the box can open a connection into the VM;
   - the VM reaches the internet;
   - the engine's own network process runs with no more rights than it needs. For Tart, Softnet must not run as root once the guest is up (`runtimeProblem`).
6. **Its own checks.** `checks` lists the engine's rows for `taskbox check` and the pre-start checks, such as Softnet's setuid bit.
7. **A record of its rules.** `netRecord` gives the status file what the engine applied. box-check reads Tart's `softnetBlock` and `softnetAllow`.
8. **Install and undo.** `pins` names the engine's tools in `versions.json`, each pinned by SHA-256. `place` and `finish` put them in a new install; `inert` makes a kept install's tools unusable, and undo runs `finish` again.

Whatever the engine, a job on the box is untrusted code, and the box never runs a job that holds secrets: no deploy keys, no signing keys, no release tokens, no environment secrets. Jobs that need them stay on GitHub's hosted runners, and the box's runner group should allow only the workflows meant for the box (README, What taskbox is for, and not for). An engine's isolation protects the box and the network from a job. It never makes a job safe to hold a secret.

The loop's own proofs run on whichever engine is set:

- every VM start: SSH off, a new password, and the box's tries at the guest dropped;
- before any Linux job: the Linux Softnet proof (`src/proof.ts`), from inside a sealed Linux VM.

A new engine passes both at the box before any job runs.

## What a new engine needs before it ships

- Its own threat model, in the PR that adds it.
- Its licence, and the licences of anything it bundles, raised with the owner.
- The macOS and Linux proofs passing at the box, typed by the owner, with what a pass looks like written down first.
- An independent review given only the code.
- No telemetry, or telemetry turned off and checked.

## Lume (Cua), not built

Read, not ran: [trycua/cua](https://github.com/trycua/cua), `libs/lume`, version 0.7.2, on 17 November 2026. MIT. Its network gateway, `cua-netgw`, bundles gvisor-tap-vsock, Apache 2.0.

What it would need, against the list above:

- **Network isolation: the main question.** Lume has three network modes: NAT, the default; bridged; and gateway (`src/VM/NetworkMode.swift`).
  - NAT and bridged give nothing like Softnet: the VM can reach the LAN.
  - Gateway mode connects the VM's network device to `cua-netgw`, a user-space gateway that decides, for each connection the guest opens, whether to dial it (`libs/cua/netgw/internal/policy/policy.go`). Its comments say it always refuses the host's loopback, the cloud metadata addresses, multicast and its own subnet. By default it also refuses the host's own interface addresses. A rules file then allows or denies by network, port and name.
  - That could give Softnet's isolation, and it is the path to look at. Not checked:
    - whether it refuses every private range and the tailnet by default, or only by rules;
    - whether anything on the host can open a connection into the guest;
    - whether DNS to the host works while the host is blocked;
    - which user it runs as;
    - how the rules file is protected, since its comments say it "may be replaced at any time".
  - A Lume engine would write the rules from the `NetPolicy`, hold the rules file where only root can write it, and pass the Linux proof and a macOS equivalent at the box.
- **Exec.** `lume ssh` runs commands over SSH, with the default user and password `lume`/`lume` (`src/Commands/SSH.swift`). That fails rule 4. A Lume engine needs exec over a channel the network can't reach, or SSH reachable only over a socket the box alone holds, with SSH off on the guest's network. Not checked: whether Lume has a guest agent.
- **Images.** `lume pull` takes `name:tag` from a registry (`src/Commands/Pull.swift`). Not checked: whether it accepts a digest reference, or how a cached image can be checked against one.
- **Telemetry.** `lume pull` records a telemetry event. A Lume engine must turn telemetry off, and check that it is off.
- **Clone, size, stop and delete.** Lume has `clone`, `set`, `stop` and `delete` commands. Not checked: whether a clone is copy-on-write and how long it takes.
- **The cached images on the box.** Tart's images would not carry over. A switch is a new 77 GB download for macOS, and the image would need to be in Lume's format.

So a Lume engine is a release of its own: its threat model, its licences raised with the owner, and the Linux and macOS proofs passing at the box before any job.
