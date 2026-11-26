// taskbox hello: what the laptop reads first when it pairs, and where the two agree an answers
// version. Internal: help leaves it out. No hostname, serial number, user name or path in the answer.
import type { BoxCtx, CommandSpec } from "../command.ts";

async function facts(c: BoxCtx) {
  const { existsSync } = await import("node:fs");
  const { readJson } = await import("../config.ts");
  const { readInstallId } = await import("../answers.ts");
  const { RELEASE_TAG } = await import("../github.ts");
  let installed: { tag?: unknown } | undefined;
  try {
    installed = existsSync(c.own.installed) ? readJson<{ tag?: unknown }>(c.own.installed) : undefined;
  } catch {
    return undefined;
  }
  const tag = typeof installed?.tag === "string" && RELEASE_TAG.test(installed.tag) ? installed.tag : null;
  return { installed, tag, installId: readInstallId(c.own.installId) ?? null };
}

export const commands: CommandSpec[] = [
  {
    path: ["hello"],
    summary: "What the laptop reads when it pairs: the release, the install ID, the answers version.",
    who: ["anyone"],
    flags: ["json"],
    shell: true,
    internal: true,
    did: "Said hello.",
    async run(c) {
      const { READS } = await import("../envelope.ts");
      const f = await facts(c);
      if (!f) {
        c.say("The box's install record can't be read. Nothing to do: agents fix it.");
        return 1;
      }
      c.say(`taskbox ${f.tag ?? "(release not known)"}, install ${f.installId ?? "(none)"}. Answers in versions ${READS.join(" and ")}.`);
      return 0;
    },
    answer: async (c) => {
      const { helloAnswer } = await import("../answers.ts");
      const { READS, WRITES } = await import("../envelope.ts");
      const f = await facts(c);
      if (!f) return { v3: { answers: 3, kind: "error", error: "unreadable" }, exit: 1 };
      const v3 = helloAnswer(f.installed as Parameters<typeof helloAnswer>[0], f.installId ?? undefined) as unknown as Record<string, unknown>;
      return { v3, exit: 0, result: { role: "box", release: f.tag, installId: f.installId, answers: c.answers, reads: [...READS], writes: [...WRITES] } };
    },
  },
];
