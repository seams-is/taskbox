// What the bake runs inside its one trusted boot, and what each job VM's runner is told. Every value
// in these scripts is a hash, or a name checked here again against the settings' own patterns
// (tools/settings.ts) as one path part, and single-quoted, so no value can add a shell word or a path.
import type { Kind } from "../settings/kinds.ts";
import { ARCH, archiveOf, NAME, TOOL, VERSION } from "./settings.ts";
import type { Manifest } from "./store.ts";

// Where the bake puts the tools in the guest, and the mount tag of its one share.
export const GUEST_TOOLS = "/opt/taskbox-tools";
export const SHARE_TAG = "taskbox-tools";
const MOUNT = "/private/var/taskbox-tools-src";
const LINUX_MOUNT = "/mnt/taskbox-tools-src";
// The runner's tool cache when the image's login shell names none: GitHub's hosted runners' place.
export const DEFAULT_TOOL_CACHE = "/opt/hostedtoolcache";
const HEX = /^[0-9a-f]{64}$/;
const PATH = /^\/[A-Za-z0-9._\/-]{1,200}$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;

const fail = (what: string, v: unknown): never => {
  throw new Error(`not a value the bake takes: ${what} ${String(v).replace(/[^\x20-\x7e]/g, "").slice(0, 40)}`);
};
// One path part, quoted: the pattern, no slash, and never . or ..
const part = (v: string, re: RegExp, what: string): string => (typeof v === "string" && re.test(v) && !v.includes("/") && v !== "." && v !== ".." ? `'${v}'` : fail(what, v));
const hex = (v: string) => part(v, HEX, "hash");
// A whole path the code itself names, quoted.
const path = (v: string): string => (PATH.test(v) && !v.split("/").slice(1).some((x) => x === "" || x === "." || x === "..") ? `'${v}'` : fail("path", v));

// Ubuntu's image has no unzip, so Linux unpacks a zip with Python's zipfile, which refuses absolute
// and parent paths, and keeps each file's mode so a tool stays runnable.
const UNZIP_PY = `'import sys, os, zipfile
z = zipfile.ZipFile(sys.argv[1])
for i in z.infolist():
    p = z.extract(i, sys.argv[2])
    m = (i.external_attr >> 16) & 0o777
    if m and not i.is_dir():
        os.chmod(p, m)'`;

// The tool cache the guest's runner uses: what the image's login shell says, when it is a plain path
// of at least two parts under /opt, /Users or /home; else GitHub's place. Never /., /usr or the like,
// where the bake's chown would reach the system.
const CACHE_TOPS = ["opt", "Users", "home"];
export function toolCacheOf(said: string): string {
  const t = said.trim();
  const parts = t.split("/").slice(1);
  const plain = PATH.test(t) && parts.length >= 2 && parts.every((x) => x !== "" && x !== "." && x !== "..") && CACHE_TOPS.includes(parts[0]!);
  return plain ? t : DEFAULT_TOOL_CACHE;
}

// The command that prints the image's own RUNNER_TOOL_CACHE, run as the guest user in its login shell.
export const TOOL_CACHE_PROBE = 'printf %s "${RUNNER_TOOL_CACHE:-}"';

// Where the macOS seal keeps each service's IPv6 setting until the bake's end.
const IPV6_SAVED = "/private/var/taskbox-ipv6-saved";
const SERVICES = "/usr/sbin/networksetup -listallnetworkservices | /usr/bin/tail -n +2 | /usr/bin/sed 's/^\\*//'";

// The bake's first step, as root, before anything is copied in: SSH off, as every job VM's seal does,
// so the image's known password reaches nothing, and IPv6 off for the boot, whose Softnet rules are
// IPv4's. The password stays the image's: each job VM's seal needs it to set a new one.
// Linux's sysctl lasts for this boot only. macOS puts each service's own setting back at the end of
// the bake script, so job VMs keep the image's.
export function sealScript(kind: Kind): string {
  const lines =
    kind === "linux"
      ? ["set -eu", "/usr/bin/systemctl mask --now ssh.socket ssh.service", "/usr/sbin/sysctl -q -w net.ipv6.conf.all.disable_ipv6=1 net.ipv6.conf.default.disable_ipv6=1"]
      : [
          "set -eu",
          "/bin/launchctl disable system/com.openssh.sshd",
          // 3 is No such process: SSH wasn't running.
          'rc=0; /bin/launchctl bootout system/com.openssh.sshd 2>/dev/null || rc=$?; [ "$rc" -eq 0 ] || [ "$rc" -eq 3 ]',
          // Each service's own IPv6 setting is saved first, so the bake's end puts back exactly that.
          // One set by hand can't be put back, so the bake stops before it changes anything.
          `: > ${IPV6_SAVED}`,
          // getinfo says "IPv6: Automatic" or "IPv6: Off"; link-local only prints no such line, only its
          // address lines (Tart proof, macOS 27.2).
          `${SERVICES} | while IFS= read -r s; do i=$(/usr/sbin/networksetup -getinfo "$s"); v=$(printf '%s\\n' "$i" | /usr/bin/sed -n 's/^IPv6: //p' | /usr/bin/head -n 1); if [ -z "$v" ] && printf '%s\\n' "$i" | /usr/bin/grep -q '^IPv6 IP address'; then v="Link-local only"; fi; case "$v" in Automatic|Off|"Link-local only") ;; "") v=default ;; *) echo "$s has IPv6 set by hand ($v), which the bake can't put back" >&2; exit 5;; esac; printf '%s|%s\\n' "$v" "$s" >> ${IPV6_SAVED}; done`,
          `${SERVICES} | while IFS= read -r s; do /usr/sbin/networksetup -setv6off "$s"; done`,
        ];
  return `${[...lines, "echo sealed"].join("\n")}\n`;
}

// The bake's one script, as root in the guest: mount the share read-only, copy every file in and check
// its hash, the manifest's too, unpack each toolcache entry where actions/tool-cache looks, mark it
// complete, write the generation, unmount, and on Linux clear what makes each clone its own. Run with
// sh -s, the script on stdin. Any failure exits non-zero.
export function bakeScript(kind: Kind, genId: string, m: Manifest, toolCache: string, user: string): string {
  if (!HEX.test(genId)) throw new Error("not a generation id");
  const mount = kind === "linux" ? LINUX_MOUNT : MOUNT;
  const sum = kind === "linux" ? "/usr/bin/sha256sum" : "/usr/bin/shasum -a 256";
  const u = part(user, USER, "user");
  const lines = [
    "set -eu",
    "umask 022",
    `M=${path(mount)}`,
    `D=${path(GUEST_TOOLS)}`,
    `TC=${path(toolCache)}`,
    '/bin/mkdir -p "$M"',
    kind === "linux" ? `/usr/bin/mount -t virtiofs -o ro '${SHARE_TAG}' "$M"` : `/sbin/mount_virtiofs -r '${SHARE_TAG}' "$M"`,
    'trap \'/sbin/umount "$M" 2>/dev/null || /usr/bin/umount "$M" 2>/dev/null || true\' EXIT',
    '/bin/rm -rf "$D.new"',
    '/bin/mkdir -p "$D.new/sha256" "$D.new/by-name"',
    'check() { got=$(' + sum + ' "$1" | /usr/bin/cut -c1-64); [ "$got" = "$2" ] || { echo "$1 does not match its hash" >&2; exit 3; }; }',
    // The manifest is the generation: its hash is the id.
    '/bin/cp "$M/manifest.json" "$D.new/manifest.json"',
    `check "$D.new/manifest.json" ${hex(genId)}`,
  ];
  const hexes = [...new Set(m.entries.map((e) => e.sha256))];
  for (const h of hexes) lines.push(`/bin/cp "$M/sha256/"${hex(h)} "$D.new/sha256/"${hex(h)}`, `check "$D.new/sha256/"${hex(h)} ${hex(h)}`);
  for (const e of m.entries) lines.push(`/bin/ln "$D.new/sha256/"${hex(e.sha256)} "$D.new/by-name/"${part(e.name, NAME, "name")}`);
  const tools: string[] = [];
  const versions: string[] = [];
  for (const e of m.entries) {
    if (!e.toolcache) continue;
    const t = e.toolcache;
    const arc = archiveOf(e.name);
    if (!arc) throw new Error(`${e.name} isn't an archive the bake unpacks`);
    const strip = t.strip ?? 0;
    if (!Number.isInteger(strip) || strip < 0 || strip > 3) fail("strip", strip);
    const tool = `"$TC/"${part(t.tool, TOOL, "tool")}`;
    const ver = `${tool}/${part(t.version, VERSION, "version")}`;
    const dir = `${ver}/${part(t.arch, ARCH, "arch")}`;
    const file = `"$D.new/sha256/"${hex(e.sha256)}`;
    lines.push(`/bin/rm -rf ${dir} ${dir}.complete`, `/bin/mkdir -p ${dir}`);
    if (arc === ".zip") {
      lines.push(
        "T=$(/usr/bin/mktemp -d)",
        kind === "linux" ? `/usr/bin/python3 -I -c ${UNZIP_PY} ${file} "$T"` : `/usr/bin/unzip -q ${file} -d "$T"`,
        'S="$T"',
        ...Array.from({ length: strip }, () => 'set -- "$S"/*; [ "$#" -eq 1 ] && [ -d "$1" ] || { echo "the archive does not have one folder to strip" >&2; exit 4; }; S="$1"'),
        `/bin/cp -R "$S"/. ${dir}/`,
        '/bin/rm -rf "$T"',
      );
    } else lines.push(`/usr/bin/tar -xf ${file} -C ${dir} --strip-components=${strip} --no-same-owner`);
    lines.push(`/usr/bin/touch ${dir}.complete`);
    if (!tools.includes(tool)) tools.push(tool);
    if (!versions.includes(ver)) versions.push(ver);
  }
  const chown = kind === "linux" ? "/bin/chown" : "/usr/sbin/chown";
  lines.push(
    `printf '%s\\n' ${hex(genId)} > "$D.new/GENERATION"`,
    `printf '%s\\n' "$TC" > "$D.new/TOOL_CACHE"`,
    '/bin/chmod -R a+rX,go-w "$D.new"',
    '/bin/rm -rf "$D"',
    '/bin/mv "$D.new" "$D"',
    // The guest user owns what the bake made in the tool cache, so setup actions can add beside it:
    // the cache folder and each tool's folder, and each version's tree. Nothing else.
    ...(tools.length ? [`${chown} ${u} "$TC"`, ...tools.map((d) => `${chown} ${u} ${d}`), ...versions.map((d) => `${chown} -R ${u} ${d}`)] : []),
  );
  if (kind === "linux")
    lines.push(
      // Each clone its own: no machine-id and no saved random seed in the base. Stopping the seed's
      // service saves it now, so the shutdown doesn't write it again. macOS keeps neither on disk:
      // its identity is in Tart's config.json, which every clone of the image or a base copies alike.
      "/usr/bin/systemctl stop systemd-random-seed.service 2>/dev/null || true",
      "/bin/rm -f /var/lib/systemd/random-seed",
      ": > /etc/machine-id",
      "[ -L /var/lib/dbus/machine-id ] || /bin/rm -f /var/lib/dbus/machine-id",
      // cloud-init is left as the image had it. Cleaned, it ran again in each clone (Tart proof: new
      // SSH host keys, and 1.2 s more to boot); uncleaned, its instance id, the same in every
      // clone, keeps it from running again.
    );
  // macOS: each service's IPv6 back to what the seal saved, so job VMs have the image's own setting.
  // A setting that read empty ("default") goes back to macOS's own default, Automatic. "|" splits
  // the record: a tab is IFS white space, so an empty first field would be lost.
  else lines.push(`while IFS='|' read -r v s; do case "$v" in Automatic|default) /usr/sbin/networksetup -setv6automatic "$s";; "Link-local only") /usr/sbin/networksetup -setv6LinkLocal "$s";; esac; done < ${IPV6_SAVED}`, `/bin/rm -f ${IPV6_SAVED}`);
  lines.push("/bin/sync", "echo baked");
  return `${lines.join("\n")}\n`;
}

// The guest's shutdown, once the bake is done, so its disk is whole before the VM stops.
export const SHUTDOWN: Record<Kind, string[]> = {
  macos: ["/usr/bin/sudo", "-n", "/sbin/shutdown", "-h", "now"],
  linux: ["/usr/bin/sudo", "-n", "/usr/bin/systemctl", "poweroff"],
};

// The lines each job's runner gets in its .env, from the guest's own files: the tools' folder, the
// generation, and the tool cache the bake filled. A guest with no tools (a VM cloned from the image)
// gets none. Only hex and plain path characters are kept from what the guest's files say.
export function runnerEnvScript(runnerDir: string): string {
  const dir = path(runnerDir);
  return [
    `G=${path(GUEST_TOOLS)}/GENERATION`,
    '[ -f "$G" ] || exit 0',
    `g=$(/usr/bin/tr -cd 0-9a-f < "$G" | /usr/bin/head -c 64)`,
    `t=$(/usr/bin/tr -cd 'A-Za-z0-9._/-' < ${path(GUEST_TOOLS)}/TOOL_CACHE 2>/dev/null | /usr/bin/head -c 200)`,
    `{ printf 'TASKBOX_TOOLS=%s\\nTASKBOX_TOOLS_GEN=%s\\n' ${path(GUEST_TOOLS)} "$g"; [ -n "$t" ] && printf 'RUNNER_TOOL_CACHE=%s\\n' "$t"; true; } >> ${dir}/.env`,
    "",
  ].join("\n");
}
