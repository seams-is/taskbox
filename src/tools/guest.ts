// What the bake runs inside its one trusted boot, and what each job VM's runner is told. Every value
// in these scripts is a hash, or a name the settings' checks hold to a small alphabet
// (tools/settings.ts), and is single-quoted again here, so no setting can add a shell word.
import type { Kind } from "../settings/kinds.ts";
import { archiveOf } from "./settings.ts";
import type { Manifest } from "./store.ts";

// Where the bake puts the tools in the guest, and the mount tag of its one share.
export const GUEST_TOOLS = "/opt/taskbox-tools";
export const SHARE_TAG = "taskbox-tools";
const MOUNT = "/private/var/taskbox-tools-src";
const LINUX_MOUNT = "/mnt/taskbox-tools-src";
// The runner's tool cache when the image's login shell names none: GitHub's hosted runners' place.
export const DEFAULT_TOOL_CACHE = "/opt/hostedtoolcache";
const SAFE = /^[A-Za-z0-9._+\/-]+$/;
const ABSOLUTE = /^\/[A-Za-z0-9._\/-]{1,200}$/;

const q = (s: string): string => {
  if (!SAFE.test(s)) throw new Error(`not a value the bake takes: ${s.replace(/[^\x20-\x7e]/g, "").slice(0, 40)}`);
  return `'${s}'`;
};

// Ubuntu's image has no unzip, so Linux unpacks a zip with Python's zipfile, which refuses absolute
// and parent paths, and keeps each file's mode so a tool stays runnable.
const UNZIP_PY = `'import sys, os, zipfile
z = zipfile.ZipFile(sys.argv[1])
for i in z.infolist():
    p = z.extract(i, sys.argv[2])
    m = (i.external_attr >> 16) & 0o777
    if m and not i.is_dir():
        os.chmod(p, m)'`;

// The tool cache the guest's runner uses: what the image's login shell says, if it is a plain path.
export function toolCacheOf(said: string): string {
  const t = said.trim();
  return ABSOLUTE.test(t) && !t.includes("..") ? t : DEFAULT_TOOL_CACHE;
}

// The command that prints the image's own RUNNER_TOOL_CACHE, run as the guest user in its login shell.
export const TOOL_CACHE_PROBE = 'printf %s "${RUNNER_TOOL_CACHE:-}"';

// The bake's one script, as root in the guest: mount the share read-only, copy every file in and check
// its hash, unpack each toolcache entry where actions/tool-cache looks, mark it complete, write the
// generation, and unmount. Run with sh -s, the script on stdin. Any failure exits non-zero.
export function bakeScript(kind: Kind, genId: string, m: Manifest, toolCache: string, user: string): string {
  if (!/^[0-9a-f]{64}$/.test(genId)) throw new Error("not a generation id");
  const mount = kind === "linux" ? LINUX_MOUNT : MOUNT;
  const sum = kind === "linux" ? "/usr/bin/sha256sum" : "/usr/bin/shasum -a 256";
  const lines = [
    "set -eu",
    "umask 022",
    `M=${q(mount)}`,
    `D=${q(GUEST_TOOLS)}`,
    `TC=${q(toolCache)}`,
    '/bin/mkdir -p "$M"',
    kind === "linux" ? `/usr/bin/mount -t virtiofs -o ro ${q(SHARE_TAG)} "$M"` : `/sbin/mount_virtiofs -r ${q(SHARE_TAG)} "$M"`,
    'trap \'/sbin/umount "$M" 2>/dev/null || /usr/bin/umount "$M" 2>/dev/null || true\' EXIT',
    '/bin/rm -rf "$D.new"',
    '/bin/mkdir -p "$D.new/sha256" "$D.new/by-name"',
    'check() { got=$(' + sum + ' "$1" | /usr/bin/cut -c1-64); [ "$got" = "$2" ] || { echo "$1 does not match its hash" >&2; exit 3; }; }',
  ];
  const hexes = [...new Set(m.entries.map((e) => e.sha256))];
  for (const h of hexes) lines.push(`/bin/cp "$M/sha256/"${q(h)} "$D.new/sha256/"${q(h)}`, `check "$D.new/sha256/"${q(h)} ${q(h)}`);
  for (const e of m.entries) lines.push(`/bin/ln "$D.new/sha256/"${q(e.sha256)} "$D.new/by-name/"${q(e.name)}`);
  lines.push('/bin/cp "$M/manifest.json" "$D.new/manifest.json"');
  for (const e of m.entries) {
    if (!e.toolcache) continue;
    const t = e.toolcache;
    const arc = archiveOf(e.name);
    if (!arc) throw new Error(`${e.name} isn't an archive the bake unpacks`);
    const strip = t.strip ?? 0;
    const dir = `"$TC/"${q(t.tool)}/${q(t.version)}/${q(t.arch)}`;
    const file = `"$D.new/sha256/"${q(e.sha256)}`;
    lines.push(`/bin/rm -rf ${dir} ${dir}.complete`, `/bin/mkdir -p ${dir}`);
    if (arc === ".zip") {
      lines.push(
        'T=$(/usr/bin/mktemp -d)',
        kind === "linux" ? `/usr/bin/python3 -I -c ${UNZIP_PY} ${file} "$T"` : `/usr/bin/unzip -q ${file} -d "$T"`,
        'S="$T"',
        ...Array.from({ length: strip }, () => 'set -- "$S"/*; [ "$#" -eq 1 ] && [ -d "$1" ] || { echo "the archive does not have one folder to strip" >&2; exit 4; }; S="$1"'),
        `/bin/cp -R "$S"/. ${dir}/`,
        '/bin/rm -rf "$T"',
      );
    } else lines.push(`/usr/bin/tar -xf ${file} -C ${dir} --strip-components=${strip} --no-same-owner`);
    lines.push(`/usr/bin/touch ${dir}.complete`);
  }
  lines.push(
    `printf '%s\\n' ${q(genId)} > "$D.new/GENERATION"`,
    `printf '%s\\n' "$TC" > "$D.new/TOOL_CACHE"`,
    '/bin/chmod -R a+rX,go-w "$D.new"',
    '/bin/rm -rf "$D"',
    '/bin/mv "$D.new" "$D"',
    `if [ -d "$TC" ]; then /usr/sbin/chown -R ${q(user)} "$TC" 2>/dev/null || /bin/chown -R ${q(user)} "$TC"; fi`,
    "/bin/sync",
    "echo baked",
  );
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
  if (!ABSOLUTE.test(runnerDir)) throw new Error("not a runner folder");
  return [
    `G=${q(GUEST_TOOLS)}/GENERATION`,
    '[ -f "$G" ] || exit 0',
    `g=$(/usr/bin/tr -cd 0-9a-f < "$G" | /usr/bin/head -c 64)`,
    `t=$(/usr/bin/tr -cd 'A-Za-z0-9._/-' < ${q(GUEST_TOOLS)}/TOOL_CACHE 2>/dev/null | /usr/bin/head -c 200)`,
    `{ printf 'TASKBOX_TOOLS=%s\\nTASKBOX_TOOLS_GEN=%s\\n' ${q(GUEST_TOOLS)} "$g"; [ -n "$t" ] && printf 'RUNNER_TOOL_CACHE=%s\\n' "$t"; true; } >> ${q(runnerDir)}/.env`,
    "",
  ].join("\n");
}
