// The guard's settings pass, by the one writer only (settings/op.ts). Each tick it reads the state
// file, which is small: an admin's answer from confirm applies at once, and a read asked for (settings
// repo) runs now. Otherwise the settings repo's head commit is read hourly, and once at the start.
import { eventLog } from "../core/events.ts";
import type { PlacedMaker } from "../core/passes.ts";
import { rootStateOf } from "../core/paths.ts";
import { readState, settingsFiles } from "../settings/inforce.ts";
import { READ_EVERY_MS, readHead, takeConfirmed, takeDeferred } from "../settings/op.ts";
import { settingsDepsOf } from "../settings/repo.ts";

export const settingsPass: PlacedMaker = {
  name: "settings",
  order: 1400,
  make(c) {
    if (!c.writer) return undefined;
    const state = rootStateOf(c.p);
    const root = c.rootUid ?? 0;
    const events = eventLog("guard", { dir: state.events, owner: root }, c.sys);
    const d = settingsDepsOf({ sys: c.sys, p: c.p, state, rootUid: root, events, log: (l) => c.log.write(l) });
    const files = settingsFiles(state.dir);
    let last = 0;
    const said = (lines: string[]) => lines.filter(Boolean).forEach((l) => c.log.write(l));
    const read = async () => {
      said(await takeConfirmed(d));
      last = c.sys.now();
      said([await readHead(d)]);
      said([await takeDeferred(d)]);
    };
    return {
      name: "settings",
      at: "after",
      start: () => read,
      next(now) {
        const s = readState(files, root);
        const v = s.kind === "ok" ? s.value : undefined;
        if (v?.confirmed?.length) return async () => said(await takeConfirmed(d));
        if (v?.readNow || now - last >= READ_EVERY_MS) return read;
        if (v?.deferred) return async () => said([await takeDeferred(d)]);
        return undefined;
      },
    };
  },
};
