// The configured service account's name, for the lines the owner reads: "as ci, type taskbox start"
// on a box whose accounts.service is ci. Set once by the CLI when the box's names are read
// (cli.ts), so every line names the same account. Before that, the role is named.
let service: string | undefined;

export function setServiceName(name: string | undefined): void {
  service = name;
}

export function serviceName(): string {
  return service ?? "the service account";
}
