// taskbox self trials: the trials before rc.1 (spec 1.3), one after another in one guided session.
// Each says what to do and what to look for, then records its result in this controller's event log
// (trial.passed, trial.failed, trial.skipped), so a re-run starts at the first trial not passed.
import { EXIT } from "../command.ts";
import { appendEvent, readEvents } from "./events.ts";
import type { Home } from "./home.ts";
import { footer } from "./screens.ts";

export interface Trial {
  name: string;
  what: string; // what to do
  look: string; // what passing looks like
}

export const TRIALS: readonly Trial[] = [
  { name: "release-key", what: "On the signing Mac, sign a draft release: taskbox sign VERSION.", look: "Touch ID asks once, the release publishes, and taskbox sign --fingerprint shows the key the boxes pin." },
  { name: "github-run", what: "Run taskbox connect github for a box against a throwaway org, then one job there.", look: "Both Apps are made and installed, the box takes the job, and taskbox job list shows it succeeded." },
  { name: "runner-group", what: "Set runnerGroup.workflows in that box's settings, and wait for the guard's hourly pass.", look: "taskbox check shows the Runner group row OK, with the workflows the settings name." },
  { name: "claude-checks", what: "In Claude Code, try taskbox mcp's logs tool in each permission mode, and break the status line command once.", look: "logs asks you each time in every mode, the rule's name is the one tool, and a broken status line shows nothing worse than a blank." },
  { name: "metal-unreal", what: "On the box, run the Metal and Unreal spike in a macOS VM.", look: "The spike's own result says passed." },
];

export type TrialResult = "passed" | "failed" | "skipped";

// Each trial's last recorded result, from the event log.
export function trialResults(h: Home): Record<string, { result: TrialResult; at: string; note: string } | null> {
  const out: Record<string, { result: TrialResult; at: string; note: string } | null> = Object.fromEntries(TRIALS.map((t) => [t.name, null]));
  for (const e of readEvents(h)) {
    const m = /^trial\.(passed|failed|skipped)$/.exec(e.type);
    const name = typeof e.data.trial === "string" ? e.data.trial : "";
    if (m && name in out) out[name] = { result: m[1] as TrialResult, at: e.at, note: typeof e.data.note === "string" ? e.data.note : "" };
  }
  return out;
}

export interface TrialsDeps {
  home: Home;
  now: () => number;
  tty: boolean;
  ask: (prompt: string) => Promise<string>;
}

export async function selfTrials(d: TrialsDeps, json: boolean, out: (l: string) => void): Promise<{ code: number; result: Record<string, unknown>; lines: string[] }> {
  const lines: string[] = [];
  const say = (l: string) => (lines.push(l), json || out(l));
  const summary = () => {
    const r = trialResults(d.home);
    return { r, left: TRIALS.filter((t) => r[t.name]?.result !== "passed") };
  };
  let { r, left } = summary();
  if (json || !d.tty) {
    for (const t of TRIALS) say(`${t.name.padEnd(14)} ${r[t.name] ? `${r[t.name]!.result} at ${r[t.name]!.at.slice(0, 16).replace("T", " ")}${r[t.name]!.note ? `: ${r[t.name]!.note}` : ""}` : "not tried"}`);
    if (!json && left.length) say("The trials take a terminal: type taskbox self trials in one.");
    for (const l of footer(`${TRIALS.length - left.length} of ${TRIALS.length} trials passed.`, "Read the trials.", left.length ? "taskbox self trials" : "Nothing to do.")) say(l);
    return { code: left.length ? EXIT.failed : EXIT.ok, result: { trials: TRIALS.map((t) => ({ name: t.name, ...(r[t.name] ?? { result: null }) })) }, lines };
  }
  say(`${left.length} of ${TRIALS.length} trials to go. Each says what to do; type passed, failed or skip, then a few words if you like.`);
  for (const t of left) {
    say("");
    say(`${t.name}: ${t.what}`);
    say(`  It passes when: ${t.look}`);
    const a = (await d.ask("  passed, failed, skip, or stop: ")).trim().toLowerCase();
    if (a === "stop" || a === "") break;
    const result: TrialResult | undefined = a === "passed" || a === "p" ? "passed" : a === "failed" || a === "f" ? "failed" : a === "skip" || a === "s" ? "skipped" : undefined;
    if (!result) {
      say("  That isn't passed, failed or skip. Nothing was recorded; the trial waits.");
      continue;
    }
    const note = result === "passed" ? "" : (await d.ask("  What happened, in a few words: ")).replace(/[^\x20-\x7e]/g, " ").trim().slice(0, 200);
    appendEvent(d.home, d.now(), `trial.${result}`, `The ${t.name} trial ${result}.`, { trial: t.name, note });
    say(`  Recorded: ${result}.`);
  }
  ({ r, left } = summary());
  for (const l of footer(`${TRIALS.length - left.length} of ${TRIALS.length} trials passed.`, "Recorded the trials.", left.length ? "taskbox self trials goes on from the first not passed." : "Nothing to do.")) say(l);
  return { code: left.length ? EXIT.failed : EXIT.ok, result: { trials: TRIALS.map((t) => ({ name: t.name, ...(r[t.name] ?? { result: null }) })) }, lines };
}
