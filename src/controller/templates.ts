// taskbox template apply on the controller: the box gives its values and its jobs repo (template show
// --json); this release's own templates, filled with them, go in one pull request in the jobs repo
// through the owner's own GitHub session (templateapply.ts). The owner merges; taskbox never does.
import { EXIT } from "../command.ts";
import { REPO_NAME } from "../hold.ts";
import { applyTemplates } from "../templateapply.ts";
import { boxResult, type LoadDeps, ownerGh, sel } from "./load.ts";
import { isStop } from "./reach.ts";
import { footer } from "./screens.ts";

export async function templateApply(d: LoadDeps, box: string | undefined, out: (l: string) => void): Promise<number> {
  const stop = (line: string, next: string, code: number = EXIT.failed) => {
    for (const l of [line, ...footer("Nothing changed.", "Nothing changed.", next)]) out(l);
    return code;
  };
  const gh = d.gh ?? ownerGh(d);
  if (!gh) return stop("template apply opens its pull request through your own GitHub session, and gh isn't on this Mac.", "Install gh with Homebrew and sign in once: gh auth login.");
  const r = await boxResult(d, ["template", "show", "box-check", ...sel(box)]);
  if (isStop(r)) return stop(r.stop, r.next);
  const repo = typeof r.repo === "string" && REPO_NAME.test(r.repo) ? r.repo : undefined;
  if (!repo) return stop("The box names no jobs repo taskbox reads.", "Update taskbox on the box and this controller.");
  const a = await applyTemplates(gh, repo, r.values);
  if (a.kind === "failed") return stop(`The templates weren't applied: ${a.why}.`, "Type gh auth status: gh must be signed in as someone who can write to the jobs repo.");
  if (a.kind === "current") {
    for (const l of [`${repo}'s copies of the box check and the test job match this box.`, ...footer("Up to date.", "Read the jobs repo.", "Nothing to do.")]) out(l);
    return EXIT.ok;
  }
  const lines = [a.kind === "opened" ? `Opened ${a.url} in ${repo}: ${a.changed.join(", ")}.` : `A pull request for these changes is open already: ${a.url}.`, "Merge it, and taskbox check --away then shows the copies match."];
  for (const l of [...lines, ...footer("A pull request waits for you.", a.kind === "opened" ? "Opened the pull request." : "Nothing changed.", `Merge ${a.url}.`)]) out(l);
  return EXIT.ok;
}
