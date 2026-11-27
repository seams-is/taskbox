// The settings op's wiring on the box: its files in root's state, the guard's socket to the GitHub
// key keeper, this box's name and box.json, for the guard's pass, the signed handlers and confirm.
import { hostname } from "node:os";
import { join } from "node:path";
import { askerFor, type Asker } from "../broker.ts";
import { readBoxFile } from "../boxsettings.ts";
import type { Paths } from "../config.ts";
import { bootId, monoNow } from "../core/boot.ts";
import type { EventLog } from "../core/events.ts";
import type { RootState } from "../core/paths.ts";
import { safeParse, type WriteRules } from "../core/rootfile.ts";
import { brokerPathsOf } from "../keys.ts";
import type { Sys } from "../sys.ts";
import { hopSettings } from "../migrate/v2settings.ts";
import { settingsFiles } from "./inforce.ts";
import type { SettingsDeps } from "./op.ts";
import { readFileSync } from "node:fs";

export const BOX_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
// This Mac's name as MagicDNS gives it: its host name's first label, lower case.
export function thisBox(name: string = hostname()): string {
  const n = name.split(".")[0]!.toLowerCase();
  if (!BOX_NAME.test(n)) throw new Error("this Mac's name isn't one a box can have in the tailnet");
  return n;
}

export interface SettingsCtx {
  sys: Pick<Sys, "now" | "run">;
  p: Paths;
  state: RootState;
  rootUid: number;
  chown?: WriteRules["chown"];
  events: Pick<EventLog, "write">;
  log(line: string): void;
}

export function settingsDepsOf(c: SettingsCtx, o: { ask?: Asker; box?: string } = {}): SettingsDeps {
  const files = settingsFiles(c.state.dir);
  return {
    now: () => c.sys.now(),
    files,
    state: c.state,
    rootUid: c.rootUid,
    ...(c.chown ? { chown: c.chown } : {}),
    events: c.events,
    log: (l) => c.log(l),
    ask: o.ask ?? askerFor(brokerPathsOf(c.p).guardSocket),
    box: o.box ?? thisBox(),
    boxKeys: () => readBoxFile(c.p.boxSettings, c.rootUid).settings,
    async setBoxKeys(set) {
      const { writeBoxKeys } = await import("../connectflow.ts");
      writeBoxKeys({ boxFile: c.p.boxSettings, rootUid: c.rootUid, ...(c.chown ? { chown: c.chown } : {}) }, set);
    },
    // v2.6.1's own file, from the install it ran as: the one read of it, for the hop's first commit.
    v2() {
      const hop = hopSettings(c.p.app, c.rootUid);
      if (hop) return hop;
      try {
        const v = safeParse(readFileSync(join(c.p.app, "taskbox.json"), "utf8"));
        return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
      } catch {
        return undefined;
      }
    },
    async moment() {
      const [boot, mono] = [await bootId(c.sys), await monoNow(c.sys)];
      return { wall: c.sys.now(), mono, boot };
    },
  };
}
