import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTartLine, PullRecorder, pullLine, readPull } from "../src/progress.ts";
import { clock, screen } from "../src/watch.ts";

const dir = () => mkdtempSync(join(tmpdir(), "taskbox-progress-"));

// A recorder fed Tart's real line shapes on a fake clock.
function feed(lines: [number, string][]) {
  let t = 0;
  const file = join(dir(), "pull.json");
  const rec = new PullRecorder(file, "macos-tahoe-xcode 26.5", () => t);
  for (const [at, l] of lines) {
    t = at;
    rec.line(l);
  }
  return { rec, file };
}

describe("Tart's lines", () => {
  test("total and percent, with or without escape codes; anything else is no line", () => {
    expect(parseTartLine("pulling disk (69.3 GB compressed)...")).toEqual({ totalGB: 69.3 });
    expect(parseTartLine("45%")).toEqual({ percent: 45 });
    expect(parseTartLine("\x1b[1A\x1b[K45%\r")).toEqual({ percent: 45 });
    expect(parseTartLine('Error pulling image: "The network connection was lost.", attempting to re-try...')).toBeNull();
    expect(parseTartLine("pulling NVRAM...")).toBeNull();
  });
});

describe("what the owner reads", () => {
  test("downloading: done of total and the percent, and nothing of speed or time left", () => {
    const { file } = feed([[0, "pulling disk (77.0 GB compressed)..."], [1000, "53%"]]);
    expect(pullLine(readPull(file), 1000, true)).toBe("Downloading macos-tahoe-xcode 26.5: 40.8 of 77.0 GB (53%).");
  });

  test("failed and ready lines; a stop starts again from the beginning", () => {
    const f = feed([[0, "pulling disk (3.1 GB compressed)..."], [1000, "40%"]]);
    f.rec.finish(false, "connection reset by peer");
    expect(pullLine(readPull(f.file), 2000)).toBe("The download of macos-tahoe-xcode 26.5 stopped at 1.2 of 3.1 GB (40%): connection reset by peer. It starts again within a minute.");
    const g = feed([[0, "pulling disk (3.1 GB compressed)..."]]);
    g.rec.finish(true);
    expect(pullLine(readPull(g.file), 1)).toBe("Image ready: macos-tahoe-xcode 26.5.");
  });

  test("a stopped loop shows where the download stopped, with the step", () => {
    const { file } = feed([[0, "pulling disk (3.1 GB compressed)..."], [1000, "40%"]]);
    expect(pullLine(readPull(file), 1000, false)).toBe("Stopped at 1.2 of 3.1 GB (40%): the loop isn't running. Log out and log in as the service account, and the download starts again.");
  });

  test("three stops in a row say agents fix it; a stop for an update isn't counted", () => {
    const file = join(dir(), "pull.json");
    for (let i = 0; i < 3; i++) new PullRecorder(file, "x", () => i).finish(false, "unauthorized");
    expect(pullLine(readPull(file), 10)).toContain("It has stopped 3 times in a row: agents fix it");
    const other = join(dir(), "pull.json");
    new PullRecorder(other, "x", () => 0).finish(false, "an update was installed", false);
    expect(readPull(other)!.failures).toBe(0);
  });

  test("a new digest under the same name is a new download, with no failures carried over", () => {
    const file = join(dir(), "pull.json");
    new PullRecorder(file, "x", () => 0, "img@sha256:1").finish(false, "e");
    expect(new PullRecorder(file, "x", () => 1, "img@sha256:2").state.failures).toBe(0);
  });

  test("control characters never reach the screen, and odd fields in the file are dropped", () => {
    const f = feed([[0, "pulling disk (3.1 GB compressed)..."]]);
    f.rec.finish(false, "bad\x1b]0;owned\x07 thing\x9b2J");
    expect(pullLine(readPull(f.file), 1)).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    const d = dir();
    writeFileSync(join(d, "loop.json"), JSON.stringify({ slot: "running a job", job: "evil\x1b[2Jjob", slotAt: 0 }));
    expect(screen({ pullFile: f.file, loopFile: join(d, "loop.json"), now: 1 }).join("\n")).not.toMatch(/\x1b/);
    writeFileSync(join(d, "bad.json"), JSON.stringify({ image: "x", state: "downloading", percent: "lots", failures: "x" }));
    expect(readPull(join(d, "bad.json"))).toMatchObject({ percent: undefined, failures: 0 });
    writeFileSync(join(d, "worse.json"), JSON.stringify({ image: 3, state: "downloading" }));
    expect(readPull(join(d, "worse.json"))).toBeUndefined();
  });

  test("no download yet", () => expect(pullLine(undefined, 0)).toContain("No download yet"));

  test("watch shows the download, the VM, the checks and the last job, and no network line", () => {
    const d = dir();
    const f = feed([[0, "pulling disk (3.1 GB compressed)..."]]);
    f.rec.finish(true);
    const lines = screen({ pullFile: f.file, loopFile: join(d, "none.json"), now: 1000, loopRunning: true }).join("\n");
    expect(lines).toContain("Download:  Image ready");
    expect(lines).toContain("Loop:      running");
    expect(lines).toContain("Last job:  none yet");
    expect(lines).not.toContain("Network:");
  });

  test("watch shows a running job's size, and no hold line for a hold left from before v2.2.0", () => {
    const d = dir();
    const now = Date.UTC(2026, 10, 16, 14, 0);
    writeFileSync(join(d, "loop.json"), JSON.stringify({ slot: "running a job", job: "check", slotAt: now - 60_000, vmSize: "4 CPUs, 8 GB", beside: ["pat"], hold: { until: now + 3600_000, at: now, by: "pat", reason: "Cycles render" } }));
    const lines = screen({ pullFile: join(d, "none.json"), loopFile: join(d, "loop.json"), now }).join("\n");
    expect(lines).not.toContain("Hold:");
    expect(lines).not.toContain("Cycles render");
    expect(lines).toContain("VM:        Running a job: check, 4 CPUs, 8 GB, beside pat");
  });
});

describe("watch's clock", () => {
  test("each frame says when it was drawn, so a frozen screen shows", () => {
    const d = dir();
    const at = new Date(2026, 10, 13, 1, 7, 5).getTime();
    expect(clock(at)).toBe("01:07:05");
    const lines = screen({ pullFile: join(d, "none.json"), loopFile: join(d, "none2.json"), now: at });
    expect(lines[2]).toBe("taskbox watch, redrawn every 2 s. Last drawn 01:07:05. Ctrl-C stops watching; the box carries on.");
  });
});
