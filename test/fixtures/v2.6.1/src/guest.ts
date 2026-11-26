// What differs inside the guest between the VM kinds: the user's home, the login shell the runner
// starts from, how SSH is turned off and the password replaced, and the ports the box tries.
// Every call into the guest goes through the VM engine's exec (src/vm.ts), never over SSH: for Tart,
// tart exec over the VM's control socket.
import type { Kind } from "./config.ts";
import { LINUX_USAGE, MACOS_USAGE, parseLinuxUsage, parseMacUsage, type UsageSample } from "./usage.ts";

export interface UsageProbe {
  cmd: string[];
  parse(out: string): UsageSample | undefined;
}

// Cirrus Labs' images ship admin with the password admin and SSH on, macOS and Linux alike.
export const GUEST_USER = "admin";
export const GUEST_IMAGE_PASSWORD = "admin";

export interface GuestStep {
  cmd: string[];
  stdin?: string;
  // Exit codes besides 0 that still count as done.
  alsoOk?: number[];
}

export interface Guest {
  home: string;
  // The runner's command starts in a login shell, so jobs get the image's own PATH, as on GitHub.
  loginShell: string[];
  // Turns SSH off and gives admin a password nobody keeps. pw is new for every VM.
  seal(pw: string): GuestStep[];
  // The ports the box tries once the guest is sealed. Softnet must drop every one.
  probePorts: number[];
  // A command that answers 0 once the guest is ready for its runner, beyond the agent itself.
  ready?: string[];
  // v2.5.0: how the guest reports its memory and CPUs (usage.ts), read during a job.
  usage: UsageProbe;
}

const MACOS: Guest = {
  home: "/Users/admin",
  loginShell: ["/bin/zsh", "-l", "-c"],
  seal: (pw) => [
    { cmd: ["/usr/bin/sudo", "-n", "/bin/launchctl", "disable", "system/com.openssh.sshd"] },
    // bootout says 3 (No such process) when SSH wasn't running: that's fine.
    { cmd: ["/usr/bin/sudo", "-n", "/bin/launchctl", "bootout", "system/com.openssh.sshd"], alsoOk: [3] },
    // dscl wants the old password even as root. It's the image's known one.
    { cmd: ["/usr/bin/sudo", "-n", "/usr/bin/dscl", ".", "-passwd", "/Users/admin", GUEST_IMAGE_PASSWORD, pw] },
  ],
  probePorts: [22, 5900],
  usage: { cmd: MACOS_USAGE, parse: parseMacUsage },
};

// Softnet gives each VM a random /29 from 10.0.0.0/8, 172.16.0.0/12 and 192.168.0.0 to 192.168.99.255
// (Softnet 0.25.0, lib/subnet_finder/mod.rs, read), and its gateway is the VM's DNS. Docker's default
// bridge is 172.17.0.0/16, and its other networks come from 172.17 to 172.31 and 192.168. When the
// VM's /29 falls inside one, that network's containers take the DNS address for one of their own,
// and their lookups time out, as in a buildkit build on a box on 17 November 2026.
// Container traffic leaves through the VM's own
// address, so Softnet's rules see only that. The image's own settings, such as its MTU, are kept.
// 198.18.0.0/15 is set aside for network tests (RFC 2544), outside every Softnet range and every
// home or office LAN, so the Linux proof's tries at the box's LAN never leave through Docker's bridge.
export const DOCKER_BIP = "198.18.0.1/24";
export const DOCKER_BRIDGE_SUBNET = "198.18.0.0/24";
export const DOCKER_POOLS = [{ base: "198.19.0.0/16", size: 24 }];
export const DOCKER_NETS_SCRIPT = `import json, os
p = "/etc/docker/daemon.json"
try:
    with open(p) as f:
        c = json.load(f)
except FileNotFoundError:
    c = {}
if not isinstance(c, dict):
    raise SystemExit("daemon.json is not an object")
# A fixed-cidr from the image would sit outside the new bridge and stop Docker.
c.pop("fixed-cidr", None)
c["bip"] = ${JSON.stringify(DOCKER_BIP)}
c["default-address-pools"] = ${JSON.stringify(DOCKER_POOLS)}
os.makedirs("/etc/docker", exist_ok=True)
with open(p + ".new", "w") as f:
    json.dump(c, f, indent=2)
os.replace(p + ".new", p)
`;

// Ubuntu 24.04 starts sshd from ssh.socket. mask stops both units now and keeps them from starting
// again, and it works for a unit the image doesn't have. chpasswd reads the new password on stdin, so
// it never appears in a process list on the box or in the guest.
const LINUX: Guest = {
  home: "/home/admin",
  loginShell: ["/bin/bash", "-l", "-c"],
  seal: (pw) => [
    { cmd: ["/usr/bin/sudo", "-n", "/usr/bin/systemctl", "mask", "--now", "ssh.socket", "ssh.service"] },
    { cmd: ["/usr/bin/sudo", "-n", "/usr/sbin/chpasswd"], stdin: `${GUEST_USER}:${pw}\n` },
    // Ubuntu's daily package updates fetch unpinned packages and hold apt's lock, which a job's own
    // apt-get would wait on. mask stops them now and for the VM's life.
    { cmd: ["/usr/bin/sudo", "-n", "/usr/bin/systemctl", "mask", "--now", "apt-daily.timer", "apt-daily-upgrade.timer", "apt-daily.service", "apt-daily-upgrade.service", "unattended-upgrades.service"] },
    // Docker's networks move out of every range Softnet picks the VM's own subnet from (v2.2.1).
    { cmd: ["/usr/bin/sudo", "-n", "/usr/bin/python3", "-I", "-"], stdin: DOCKER_NETS_SCRIPT },
    { cmd: ["/usr/bin/sudo", "-n", "/usr/bin/systemctl", "restart", "docker.service"] },
  ],
  // SSH, and Docker's own TCP ports in case an image turns them on.
  probePorts: [22, 2375, 2376],
  usage: { cmd: LINUX_USAGE, parse: parseLinuxUsage },
  // Docker's daemon answers as admin, with no sudo: jobs run docker and services containers as admin.
  // From v2.2.1 it also checks that Docker took the new bridge, so a setting that didn't apply stops the VM.
  ready: ["/bin/sh", "-c", `/usr/bin/docker network inspect bridge --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' | /usr/bin/grep -qw '${DOCKER_BRIDGE_SUBNET}'`],
};

export const GUESTS: Record<Kind, Guest> = { macos: MACOS, linux: LINUX };
export const guestOf = (kind: Kind | undefined): Guest => GUESTS[kind ?? "macos"];
