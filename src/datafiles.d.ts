// The data files src/embedded.ts reads in as text when the engine is built.
declare module "*/allowed_signers" {
  const text: string;
  export default text;
}
declare module "*.plist" {
  const text: string;
  export default text;
}
