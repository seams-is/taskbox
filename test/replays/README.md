# Saved days, for calibrating the simulator

Each `*.json` here is one day of the box's own jobs, from `taskbox jobs --all --json` typed as remote, with `vmKind`, `className`, `jobAt`, `endedAt` and `phases` kept and every job's name dropped (`replayFromJobs` in `test/sim.ts` drops them anyway). `test/acceptance.test.ts` replays each one with that day's measured boot times and checks that the simulator's waits match the box's within 3 min, and that the acceptance criteria come out the same. A day where they don't is a fix to the simulator before any fix to the rules.
