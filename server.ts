// V2 server entrypoint for local-directory loading (opencode resolves `server` beside `index`).
// Keep the explicit extension: fully resolved local paths let the host's module-rewrite
// loaders attach, so shared runtime modules come from the host instead of plugin-local copies.
export { default } from "./src/server.ts"
