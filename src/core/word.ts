// The --signed word's shape: two base64url parts, the statement and the signature, joined by a dot.
// Its own module with no imports, so the command line (command.ts) and the asking side read it
// without loading the guard's code.
export const WORD_MAX = 3000; // under the spool's 4 KB with a request's other fields
export const SIGNED_WORD = /^[A-Za-z0-9_-]{1,2800}\.[A-Za-z0-9_-]{1,2800}$/;
export const isSignedWord = (v: unknown): v is string => typeof v === "string" && v.length <= WORD_MAX && SIGNED_WORD.test(v);
// The agent spool's two kinds of the dispatcher's own (core/dispatch.ts).
export const SIGNED = "signed";
export const NONCE = "nonce";
