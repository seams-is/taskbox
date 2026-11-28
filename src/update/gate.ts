// When a settings commit may apply (the settings op's waiting and draining phases), pure: keys
// that change what a job VM is (kinds, sizes, images, accounts, tools) wait for the update window
// when the box updates itself, then for a drain; every other key applies at once, between the
// loop's ticks. With update.auto off there is no window: they apply after a drain, at once.
import { changeControl, readControl, requestOf } from "../availability.ts";
import type { EventLog } from "../core/events.ts";
import type { RootState } from "../core/paths.ts";
import type { WriteRules } from "../core/rootfile.ts";
import { loadConfig, type Paths } from "../config.ts";
import type { SettingsHold } from "../settings/op.ts";
import { DEFAULT_UPDATE, inWindow, updateOf, type UpdateSettings } from "../settings/update.ts";
import type { Sys } from "../sys.ts";

export const DRAIN_KEYS = ["image", "imageName", "imageGB", "linux", "sizes", "maxAtOnce", "warmSize", "label", "labels", "mergeLabel", "accounts", "tools", "vmCpus", "vmMemoryMB", "vmsAtOnce", "vmsAtMost", "cpuBudget"];

export type Gate = { phase: "applying" } | { phase: "waiting"; until: string } | { phase: "draining" };

export function settingsGate(o: { keys: string[]; u: UpdateSettings; now: number; offsetMin: number; drained: boolean }): Gate {
  const needs = o.keys.filter((k) => DRAIN_KEYS.includes(k.split(".")[0]!));
  if (!needs.length) return { phase: "applying" };
  if (o.u.auto && !inWindow(o.u.window, o.now, o.offsetMin).open) return { phase: "waiting", until: `the update window, ${o.u.window}` };
  return o.drained ? { phase: "applying" } : { phase: "draining" };
}

// The settings op's hold on the box (settings/op.ts SettingsHold): the window from the update
// settings in force, and a drain through control.json that the op ends with a resume. A box that was
// already paused or drained isn't drained again, nor resumed after.
export interface HoldCtx {
  sys: Pick<Sys, "run" | "now">;
  p: Paths;
  state: RootState;
  rootUid: number;
  chown?: WriteRules["chown"];
  events: Pick<EventLog, "write">;
  log(line: string): void;
}

export function settingsHold(c: HoldCtx): SettingsHold {
  const ctl = () => ({ sys: c.sys, state: c.state, rootUid: c.rootUid, ...(c.chown ? { chown: c.chown } : {}), events: c.events, log: c.log });
  const availability = () => {
    const r = readControl(c.state.control, c.rootUid);
    return r.kind === "ok" ? r.value.availability : r.kind === "missing" ? "active" : "unknown";
  };
  return {
    gate(keys, drained) {
      let u = DEFAULT_UPDATE;
      try {
        u = updateOf(loadConfig(c.p.app, c.p.boxSettings, c.rootUid));
      } catch {}
      return settingsGate({ keys, u, now: c.sys.now(), offsetMin: -new Date(c.sys.now()).getTimezoneOffset(), drained });
    },
    drained: () => ["drained", "stopped"].includes(availability()),
    async drain(op) {
      if (availability() !== "active") return undefined;
      const r = await changeControl(ctl(), requestOf("drain", { reason: `settings ${op}` }, `settings ${op}`));
      return r.ok ? undefined : r.said;
    },
    async resume(op) {
      const r = readControl(c.state.control, c.rootUid);
      if (r.kind === "ok" && r.value.actor === `settings ${op}` && (r.value.availability === "drained" || r.value.availability === "draining")) await changeControl(ctl(), { kind: "resume", actor: `settings ${op}` });
    },
  };
}
