// A fake macOS local directory: users, groups, and who is an admin. It answers dscl, id,
// dseditgroup, sysadminctl, pgrep and pkill as macOS does, for the pool account's tests. nobody is
// there, as on every Mac, in the groups every account is in: everyone and localaccounts.
import { FakeSys, type Responder } from "./fake.ts";

const STAFF_GID = 20;
type User = { uid?: number; attrs: Record<string, string>; admin?: boolean };
type Group = { gid?: number; members: string[]; attrs: Record<string, string> };

// The box's local directory: users, groups and who is an admin.
export class Dir {
  users: Record<string, User> = { nobody: { uid: 4294967294, attrs: { PrimaryGroupID: "4294967294" } } };
  groups: Record<string, Group> = { staff: { gid: STAFF_GID, members: ["root"], attrs: {} }, nobody: { gid: 4294967294, members: [], attrs: {} }, everyone: { gid: 12, members: [], attrs: {} }, localaccounts: { gid: 61, members: [], attrs: {} } };
  // Each user ID's processes, for pgrep and pkill: how many signals each takes to stop.
  procs: Record<number, { left: number; signals: string[] }> = {};
  failCreate?: string;
  onCreate?: (path: string, key: string | undefined) => void;
  user(name: string, u: User): this {
    this.users[name] = u;
    return this;
  }
  group(name: string, gid: number): this {
    this.groups[name] = { gid, members: [], attrs: {} };
    return this;
  }
  sys(): FakeSys {
    const sys = new FakeSys();
    sys.responders.unshift(this.responder());
    return sys;
  }
  responder(): Responder {
    return (cmd, args) => {
      const out = (stdout: string, code = 0, stderr = "") => ({ code, stdout, stderr });
      if (cmd === "/usr/bin/id" && args[0] === "-nu") {
        const n = Object.entries(this.users).find(([, u]) => u.uid !== undefined && String(u.uid) === args[1]);
        return n ? out(`${n[0]}\n`) : out("", 1, `id: ${args[1]}: no such user\n`);
      }
      if (cmd === "/usr/bin/dscacheutil" && args[1] === "group" && args[3] === "gid") {
        const g = Object.entries(this.groups).find(([, x]) => x.gid !== undefined && String(x.gid) === args[4]);
        return out(g ? `name: ${g[0]}\npassword: *\ngid: ${args[4]}\n\n` : "");
      }
      if (cmd === "/usr/bin/id") {
        const u = this.users[args[1]!];
        if (u?.uid === undefined) return out("", 1, "no such user");
        if (args[0] === "-u") return out(`${u.uid}\n`);
        const primary = Number(u.attrs.PrimaryGroupID ?? STAFF_GID);
        const gids = [primary, 12, 61, ...Object.values(this.groups).filter((g) => g.members.includes(args[1]!) && g.gid !== primary && g.gid !== 12 && g.gid !== 61).map((g) => g.gid!)];
        if (args[0] === "-G") return out(`${gids.join(" ")}\n`);
        const nameOf = (gid: number) => Object.entries(this.groups).find(([, g]) => g.gid === gid)?.[0] ?? String(gid);
        return out(`${gids.map(nameOf).join(" ")}\n`);
      }
      if (cmd === "/usr/sbin/dseditgroup" && args[1] === "checkmember") {
        const [user, group] = [args[3]!, args[4]!];
        if (group === "admin") return out("", this.users[user]?.admin ? 0 : 67);
        const g = this.groups[group];
        const u = this.users[user];
        return out("", g && (g.members.includes(user) || (u && u.attrs.PrimaryGroupID === String(g.gid))) ? 0 : 67);
      }
      if (cmd === "/usr/bin/pgrep" && args[0] === "-U") return out("", (this.procs[Number(args[1])]?.left ?? 0) > 0 ? 0 : 1);
      if (cmd === "/usr/bin/pkill") {
        const p = this.procs[Number(args[2])];
        if (p) {
          p.signals.push(args[0]!);
          if (args[0] === "-KILL" || p.left <= 1) p.left = 0;
          else p.left--;
        }
        return out("");
      }
      if (cmd === "/usr/sbin/dseditgroup" && args[1] === "edit" && args[2] === "-d") {
        const g = this.groups[args[6]!];
        if (g) g.members = g.members.filter((m) => m !== args[3]);
        return out("");
      }
      if (cmd === "/usr/sbin/sysadminctl" && args[0] === "-deleteUser") {
        delete this.users[args[1]!];
        return out("");
      }
      if (cmd === "/usr/bin/who" || (cmd === "/bin/ps" && args[0] === "-axo")) return out("");
      if (cmd !== "/usr/bin/dscl") return undefined;
      if (args[1] === "-list" && args[2] === "/Users" && args[3] === "PrimaryGroupID") return out(Object.entries(this.users).filter(([, u]) => u.attrs.PrimaryGroupID !== undefined).map(([n, u]) => `${n} ${u.attrs.PrimaryGroupID}`).join("\n"));
      if (args[1] === "-list" && args[2] === "/Users") return out(Object.entries(this.users).filter(([, u]) => u.uid !== undefined).map(([n, u]) => `${n} ${u.uid}`).join("\n"));
      if (args[1] === "-list" && args[2] === "/Groups") return out(Object.entries(this.groups).filter(([, g]) => g.gid !== undefined).map(([n, g]) => `${n} ${g.gid}`).join("\n"));
      const path = args[2] ?? "";
      const key = args[3];
      const notFound = out("", 56, "<dscl_cmd> DS Error: -14136 (eDSRecordNotFound)");
      if (path.startsWith("/Groups/")) {
        const name = path.slice(8);
        const g = this.groups[name];
        if (args[1] === "-read") {
          if (!g) return notFound;
          if (key === "PrimaryGroupID") return g.gid !== undefined ? out(`PrimaryGroupID: ${g.gid}\n`) : out("No such key: PrimaryGroupID\n");
          if (key === "GroupMembership") return out(g.members.length ? `GroupMembership: ${g.members.join(" ")}\n` : "No such key: GroupMembership\n");
          return out("");
        }
        if (args[1] === "-create") {
          this.onCreate?.(path, key);
          if (key === undefined) this.groups[name] ??= { members: [], attrs: {} };
          else if (!g) return out("", 56);
          else if (key === "PrimaryGroupID") g.gid = Number(args[4]);
          else g.attrs[key] = args[4]!;
          return out("");
        }
        if (args[1] === "-delete" && key === undefined) {
          if (!g) return notFound;
          delete this.groups[name];
          return out("");
        }
        return undefined;
      }
      if (!path.startsWith("/Users/")) return undefined;
      const name = path.slice(7);
      const u = this.users[name];
      if (args[1] === "-read") {
        if (!u) return notFound;
        if (key === "GeneratedUID") return u.uid !== undefined ? out(`GeneratedUID: 0F0F0F0F-0000-0000-0000-${String(u.uid).padStart(12, "0")}\n`) : out("No such key: GeneratedUID\n");
        if (key === "RecordName") return out(`RecordName: ${name}\n`);
        if (key === "UniqueID") return u.uid !== undefined ? out(`UniqueID: ${u.uid}\n`) : out("No such key: UniqueID\n");
        return u.attrs[key!] !== undefined ? out(`${key === "IsHidden" || key === "ShadowHashData" ? "dsAttrTypeNative:" : ""}${key}: ${u.attrs[key!]}\n`) : out(`No such key: ${key}\n`);
      }
      if (args[1] === "-create") {
        this.onCreate?.(path, key);
        if (key !== undefined && key === this.failCreate) return out("", 1);
        if (key === undefined) {
          this.users[name] ??= { attrs: {} };
          return out("");
        }
        if (!u) return out("", 56);
        if (key === "UniqueID") u.uid = Number(args[4]);
        else u.attrs[key] = args[4]!;
        return out("");
      }
      if (args[1] === "-delete" && key === undefined) {
        if (!u) return notFound;
        delete this.users[name];
        return out("");
      }
      if (args[1] === "-delete") {
        if (!u || u.attrs[key!] === undefined) return out("", 1);
        delete u.attrs[key!];
        return out("");
      }
      return undefined;
    };
  }
}

