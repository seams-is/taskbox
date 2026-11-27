// Every file of commands, by static import, so the engine compiles to one binary with nothing read
// from disk. A noun adds src/cmd/<noun>.ts, which exports `commands`, and one line in each list
// below, sorted by file. A test checks that every file in this folder is named here, so a helper
// that exports no commands lives outside src/cmd.
// The imports make a cycle: registry.ts imports this file, which imports each command file, and some
// import ops.ts, which imports registry.ts. It holds because each entry keeps the module itself, read
// when loadRegistry runs. So nothing in src/cmd calls registry() or loadRegistry at a module's top
// level: there it would meet a module not yet finished.
import type { CommandFile } from "../registry.ts";
import * as broker from "./broker.ts";
import * as check from "./check.ts";
import * as confirm from "./confirm.ts";
import * as connect from "./connect.ts";
import * as daemons from "./daemons.ts";
import * as drain from "./drain.ts";
import * as guardwatch from "./guardwatch.ts";
import * as hello from "./hello.ts";
import * as image from "./image.ts";
import * as install from "./install.ts";
import * as job from "./job.ts";
import * as key from "./key.ts";
import * as load from "./load.ts";
import * as logins from "./logins.ts";
import * as logs from "./logs.ts";
import * as netwatch from "./netwatch.ts";
import * as nonce from "./nonce.ts";
import * as op from "./op.ts";
import * as pause from "./pause.ts";
import * as policy from "./policy.ts";
import * as poll from "./poll.ts";
import * as prune from "./prune.ts";
import * as release from "./release.ts";
import * as remove from "./remove.ts";
import * as resume from "./resume.ts";
import * as rollback from "./rollback.ts";
import * as settings from "./settings.ts";
import * as size from "./size.ts";
import * as source from "./source.ts";
import * as start from "./start.ts";
import * as status from "./status.ts";
import * as stop from "./stop.ts";
import * as template from "./template.ts";
import * as tool from "./tool.ts";
import * as unlock from "./unlock.ts";
import * as update from "./update.ts";
import * as workspace from "./workspace.ts";

export const commandFiles: readonly CommandFile[] = [
  { file: "broker.ts", module: broker },
  { file: "check.ts", module: check },
  { file: "confirm.ts", module: confirm },
  { file: "connect.ts", module: connect },
  { file: "daemons.ts", module: daemons },
  { file: "drain.ts", module: drain },
  { file: "guardwatch.ts", module: guardwatch },
  { file: "hello.ts", module: hello },
  { file: "image.ts", module: image },
  { file: "install.ts", module: install },
  { file: "job.ts", module: job },
  { file: "key.ts", module: key },
  { file: "load.ts", module: load },
  { file: "logins.ts", module: logins },
  { file: "logs.ts", module: logs },
  { file: "netwatch.ts", module: netwatch },
  { file: "nonce.ts", module: nonce },
  { file: "op.ts", module: op },
  { file: "pause.ts", module: pause },
  { file: "policy.ts", module: policy },
  { file: "poll.ts", module: poll },
  { file: "prune.ts", module: prune },
  { file: "release.ts", module: release },
  { file: "remove.ts", module: remove },
  { file: "resume.ts", module: resume },
  { file: "rollback.ts", module: rollback },
  { file: "settings.ts", module: settings },
  { file: "size.ts", module: size },
  { file: "source.ts", module: source },
  { file: "start.ts", module: start },
  { file: "status.ts", module: status },
  { file: "stop.ts", module: stop },
  { file: "template.ts", module: template },
  { file: "tool.ts", module: tool },
  { file: "unlock.ts", module: unlock },
  { file: "update.ts", module: update },
  { file: "workspace.ts", module: workspace },
];
