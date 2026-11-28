// settings: the guard's read of a new settings commit, applied as far as it may be, and waiting for
// the owner's settings apply and the box's confirm for its widening guarded keys. Taken by the guard
// itself, so who starts it is the owner's signed settings apply. A cancel passes the commit over:
// what applied stays, and its held changes stay held until a newer commit.
import type { OpDecl } from "./decl.ts";

export const SETTINGS_PHASES = ["fetching", "validating", "needs-owner", "needs-confirm", "waiting", "draining", "applying"];

export const optypes: OpDecl[] = [
  {
    type: "settings",
    phases: SETTINGS_PHASES,
    // A restart keeps it waiting: the state on disk says what waits, and confirm lapses on its own.
    onBoot: (op) => (op.phase === "needs-owner" || op.phase === "needs-confirm" ? "resume" : "fail"),
    who: ["owner", "admin"],
    wayBack: "A settings PR that reverts the commit puts it back.",
    async cancel(c, op, actor) {
      const { endAsCancelled } = await import("../opcancel.ts");
      const ended = await endAsCancelled(c, op, actor);
      if (!ended.ok) return ended;
      const { settingsDepsOf } = await import("../settings/repo.ts");
      const { passOver } = await import("../settings/op.ts");
      await passOver(settingsDepsOf(c), `the op was cancelled by ${actor}`).catch(() => undefined);
      return ended;
    },
  },
];
