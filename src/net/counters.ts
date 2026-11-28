// TCP counters: the guest's own, read once after its runner ends (labelled "as the guest reports",
// since the job had root in it), and the box's, before and after each job (box-wide, labelled so).
// Each parser reads at most COUNTERS_MAX bytes and keeps only whole numbers it recognises.

export const COUNTERS_MAX = 64 * 1024;

export interface TcpCounters {
  opens: number; // connections the side started
  failed: number; // of those, the ones that never opened
  timeouts?: number; // retransmit timeouts
  synRetrans?: number; // SYNs sent again
  resetsSent?: number;
}

// What the guest runs: fixed commands, nothing from the job.
export const GUEST_COUNTERS: Record<"linux" | "macos", string[]> = {
  linux: ["/bin/cat", "/proc/net/snmp", "/proc/net/netstat"],
  macos: ["/usr/sbin/netstat", "-s", "-p", "tcp"],
};

const num = (v: string | undefined) => (v !== undefined && /^\d{1,15}$/.test(v) ? Number(v) : undefined);

// Linux's /proc/net/snmp and /proc/net/netstat: a header line and a value line per family.
export function linuxCounters(text: string): TcpCounters | undefined {
  const lines = text.slice(0, COUNTERS_MAX).split("\n");
  const fam: Record<string, Record<string, number>> = {};
  for (let i = 0; i + 1 < lines.length; i++) {
    const h = /^(Tcp|TcpExt): ([A-Za-z0-9 ]+)$/.exec(lines[i]!.trim());
    const v = h ? new RegExp(`^${h[1]}: ([-0-9 ]+)$`).exec(lines[i + 1]!.trim()) : undefined;
    if (!h || !v) continue;
    const names = h[2]!.split(/\s+/);
    const vals = v[1]!.split(/\s+/);
    if (names.length !== vals.length) continue;
    fam[h[1]!] = Object.fromEntries(names.flatMap((n, j) => (num(vals[j]) !== undefined ? [[n, num(vals[j])!]] : [])));
    i++;
  }
  const t = fam.Tcp;
  if (!t || t.ActiveOpens === undefined || t.AttemptFails === undefined) return undefined;
  const x = fam.TcpExt ?? {};
  return { opens: t.ActiveOpens, failed: t.AttemptFails, ...(x.TCPTimeouts !== undefined ? { timeouts: x.TCPTimeouts } : {}), ...(x.TCPSynRetrans !== undefined ? { synRetrans: x.TCPSynRetrans } : {}), ...(t.OutRsts !== undefined ? { resetsSent: t.OutRsts } : {}) };
}

// macOS's netstat -s -p tcp.
export function macCounters(text: string): TcpCounters | undefined {
  const t = text.slice(0, COUNTERS_MAX);
  const get = (re: RegExp) => num(re.exec(t)?.[1]);
  const opens = get(/^\s*(\d+) connection requests?$/m);
  const failed = get(/^\s*(\d+) embryonic connections? dropped$/m);
  if (opens === undefined || failed === undefined) return undefined;
  const timeouts = get(/^\s*(\d+) retransmit timeouts?$/m);
  return { opens, failed, ...(timeouts !== undefined ? { timeouts } : {}) };
}

export const countersOf = (kind: "linux" | "macos", text: string) => (kind === "linux" ? linuxCounters(text) : macCounters(text));

// The box's change over a job: after less before, each counter both have.
export function delta(before: TcpCounters | undefined, after: TcpCounters | undefined): Partial<TcpCounters> | undefined {
  if (!before || !after) return undefined;
  const out: Partial<TcpCounters> = {};
  for (const k of ["opens", "failed", "timeouts", "synRetrans", "resetsSent"] as const) {
    const a = after[k];
    const b = before[k];
    if (a !== undefined && b !== undefined && a >= b) out[k] = a - b;
  }
  return out;
}
