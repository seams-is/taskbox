// The controller's template apply, self trials, workspace connect --screen and box install, through
// dispatch against a v3 stand-in box.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOST, lanOptions } from "../src/controller/boxinstall.ts";
import { writeConfig } from "../src/controller/home.ts";
import { screenUrl } from "../src/controller/screenshare.ts";
import { TRIALS, trialResults } from "../src/controller/trials.ts";
import type { Gh } from "../src/hold.ts";
import { ADDRESS, CEILING, controllerConfig, deps, INSTALL_ID, pairing, runLine, StandIn, type TestDeps, World } from "./controller-fake.ts";

function v3(answers: string[] = []): { w: World; d: TestDeps; box: StandIn } {
  const w = new World();
  const box = new StandIn(INSTALL_ID);
  w.standIns[ADDRESS] = box;
  const d = deps(w, answers);
  writeConfig(d.home, controllerConfig([pairing()]));
  return { w, d, box };
}

// GitHub for one jobs repo with no copies yet: template apply opens its pull request.
function jobsGh() {
  const calls: string[][] = [];
  const gh: Gh = async (args) => {
    calls.push(args);
    const a = args.filter((x) => x !== "api" && x !== "--input" && x !== "-");
    const method = a[0] === "--method" ? a[1] : "GET";
    const path = a[0] === "--method" ? a[2]! : a[0]!;
    const out = (v: unknown) => ({ code: 0, stdout: JSON.stringify(v), stderr: "" });
    if (method === "GET" && path === "repos/example-org/app") return out({ default_branch: "main" });
    if (method === "GET" && path.includes("/contents/")) return { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
    if (method === "GET" && path.includes("/pulls?")) return out([]);
    if (method === "GET" && path.includes("/git/ref/heads/main")) return out({ object: { sha: "a".repeat(40) } });
    if (method === "POST" && path.endsWith("/pulls")) return out({ html_url: "https://github.com/example-org/app/pull/9" });
    return out({});
  };
  return { gh, calls };
}

describe("taskbox template apply", () => {
  test("reads the box's values and jobs repo, and opens one pull request through the owner's gh", async () => {
    const { d, box } = v3();
    const f = jobsGh();
    Object.assign(d, { gh: f.gh });
    const r = await runLine(d, ["template", "apply"]);
    expect(r.code).toBe(0);
    expect(box.sent.some((l) => l.startsWith("template show box-check --json"))).toBe(true);
    expect(r.lines.join("\n")).toContain("Opened https://github.com/example-org/app/pull/9 in example-org/app");
    expect(f.calls.some((c) => c.includes("repos/example-org/app/pulls"))).toBe(true);
  }, CEILING);

  test("with --json, one envelope; template list and show still go to the box", async () => {
    const { d, box } = v3();
    Object.assign(d, { gh: jobsGh().gh });
    const r = await runLine(d, ["template", "apply", "--json"]);
    expect(r.lines).toHaveLength(1);
    expect(JSON.parse(r.lines[0]!)).toMatchObject({ command: "template.apply", ok: true });
    expect((await runLine(d, ["template", "list"])).code).toBe(0);
    expect(box.sent.some((l) => l.startsWith("template list"))).toBe(true);
  }, CEILING);

  test("without gh on this Mac, nothing is asked of the box", async () => {
    const { d, box } = v3();
    const r = await runLine(d, ["template", "apply"]);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toContain("gh isn't on this Mac");
    expect(box.sent).toEqual([]);
  }, CEILING);
});

describe("taskbox self trials", () => {
  test("walks the trials in order, records each, and a re-run starts at the first not passed", async () => {
    const { d } = v3(["passed", "failed", "the PATCH was refused", "stop"]);
    const r = await runLine(d, ["self", "trials"]);
    expect(r.code).toBe(1);
    const got = trialResults(d.home);
    expect(got["release-key"]?.result).toBe("passed");
    expect(got["github-run"]).toMatchObject({ result: "failed", note: "the PATCH was refused" });
    expect(got["runner-group"]).toBeNull();
    const again = await runLine(d, ["self", "trials", "--json"]);
    const e = JSON.parse(again.lines[0]!);
    expect(e.command).toBe("self.trials");
    expect(e.result.trials.map((t: { name: string }) => t.name)).toEqual(TRIALS.map((t) => t.name));
    expect(e.exit).toBe(1);
  }, CEILING);

  test("with every trial passed it exits 0", async () => {
    const { d } = v3(TRIALS.map(() => "passed"));
    expect((await runLine(d, ["self", "trials"])).code).toBe(0);
  }, CEILING);
});

describe("taskbox workspace connect --screen", () => {
  test("opens Screen Sharing to the account the box names, at the box's Tailscale address", async () => {
    const { w, d, box } = v3();
    box.over.set("workspace connect nova-3 --screen --json --answers 4", { stdout: `${JSON.stringify({ answers: 4, command: "workspace.connect", box: { name: "taskbox-1", installId: INSTALL_ID, release: "3.0.0" }, at: "2026-11-17T12:00:00Z", ok: true, exit: 0, changed: false, op: null, result: { id: "nova-3", account: "pat", state: "ready", size: "whole", screen: true }, lines: ["nova-3 runs as pat."], error: null, next: [], final: true })}\n`, code: 0 });
    const opened: string[][] = [];
    const run = w.run;
    d.run = async (argv, o) => (argv[0] === "/usr/bin/open" ? (opened.push(argv), { code: 0, stdout: "", stderr: "", timedOut: false, tooBig: false }) : run(argv, o));
    const r = await runLine(d, ["workspace", "connect", "nova-3", "--screen"]);
    expect(r.code).toBe(0);
    expect(opened).toEqual([["/usr/bin/open", `vnc://pat@${ADDRESS}`]]);
    expect(r.lines[0]).toContain("Opened Screen Sharing to pat on taskbox-1.");
  }, CEILING);

  test("only a macOS short name and a Tailscale address make a URL", () => {
    expect(screenUrl("pat", "100.64.0.7")).toBe("vnc://pat@100.64.0.7");
    expect(screenUrl("pat", "fd7a:115c:a1e0::7")).toBe("vnc://pat@[fd7a:115c:a1e0::7]");
    for (const [a, h] of [["pat@evil", "100.64.0.7"], ["-oProxy", "100.64.0.7"], ["pat", "192.168.1.5"], ["pat", "evil.example.com"]]) expect(screenUrl(a!, h!)).toBeUndefined();
  });

  test("a workspace that isn't Whole is refused at the box", async () => {
    const { d } = v3();
    const r = await runLine(d, ["workspace", "connect", "nova-3", "--screen"]);
    expect(r.code).toBe(1);
  }, CEILING);
});

describe("taskbox box install", () => {
  test("takes ADMIN@HOST and an ORG/REPO, nothing shaped like an ssh flag", () => {
    expect(HOST.test("admin@mac-mini.local")).toBe(true);
    for (const bad of ["-oProxyCommand=x@h", "admin@-oProxy", "admin@h;rm", "admin", "Admin@h"]) expect(HOST.test(bad)).toBe(false);
    const o = lanOptions("/Users/x/known_hosts.lan").join(" ");
    expect(o).toContain("StrictHostKeyChecking=ask");
    expect(o).toContain("ForwardAgent=no");
    expect(o).toContain("ControlPath=none");
  });

  test("without a terminal it stops before anything is fetched", async () => {
    const { d } = v3();
    d.tty = false;
    const r = await runLine(d, ["box", "install", "admin@mac-mini.local", "--settings", "example-org/settings"]);
    expect(r.code).toBe(2);
    expect(r.lines[0]).toContain("runs in your terminal");
    expect(d.fetched).toEqual([]);
  }, CEILING);

  test("a release that does not verify reaches no Mac; one that does is copied, installed and closed", async () => {
    const { d, w } = v3();
    const terms: string[][] = [];
    Object.assign(d, { term: async (a: string[]) => (terms.push(a), 0) });
    writeConfig(d.home, { ...controllerConfig([pairing()]), source: { owner: "example-org", repo: "taskbox" } });
    const { symlinkSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(d.home.releases, "v3.0.0"), { recursive: true });
    symlinkSync(join("releases", "v3.0.0"), d.home.current);
    writeFileSync(join(d.home.dir, "allowed_signers"), "x\n");
    const api = "https://api.github.com/repos/example-org/taskbox/releases/tags/v3.0.0";
    const asset = (n: string) => `https://github.com/example-org/taskbox/releases/download/v3.0.0/${n}`;
    d.web.set(api, { status: 200, body: JSON.stringify({ tag_name: "v3.0.0", draft: false, prerelease: false, assets: ["statement.json", "statement.json.sig", "taskbox-v3.0.0.tar.gz"].map((name) => ({ name, browser_download_url: asset(name) })) }) });
    for (const n of ["statement.json", "statement.json.sig", "taskbox-v3.0.0.tar.gz"]) d.web.set(asset(n), { status: 200, body: "x" });
    const r = await runLine(d, ["box", "install", "admin@mac-mini.local"]);
    expect(r.code).toBe(1);
    // Verified, it copies, installs under ssh -t with the settings repo, and turns Remote Login off.
    d.verdict = { ok: true } as never;
    const run = w.run;
    d.run = async (argv, o) => (argv[0] === "/usr/bin/ssh" ? { code: 255, stdout: "", stderr: "Connection refused", timedOut: false, tooBig: false } : run(argv, o));
    const ok = await runLine(d, ["box", "install", "admin@mac-mini.local", "--settings", "example-org/settings"]);
    expect(ok.code).toBe(0);
    expect(terms.map((t) => t[0])).toEqual(["/usr/bin/ssh", "/usr/bin/scp", "/usr/bin/ssh", "/usr/bin/ssh"]);
    expect(terms[2]).toContain("-t");
    expect(terms[2]!.at(-1)).toBe("cd taskbox-install && /bin/rm -rf taskbox && /usr/bin/tar -xzf taskbox-v3.0.0.tar.gz && /bin/sh taskbox/install.sh --settings example-org/settings");
    expect(terms[3]!.at(-1)).toContain("launchctl disable system/com.openssh.sshd");
    expect(ok.lines.join("\n")).toContain("Remote Login is off at mac-mini.local.");
    terms.length = 0;
    d.verdict = { ok: false, code: "signature", why: "bad" } as never;
    expect(r.lines.join("\n")).toContain("Not installed");
    expect(d.verified).toHaveLength(2);
    expect(d.verified[0]).toMatchObject({ installed: null, want: "v3.0.0" });
    expect(terms).toEqual([]);
    expect(w.calls.some((c) => c[0] === "/usr/bin/scp")).toBe(false);
  }, CEILING);
});
