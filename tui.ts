// V2 TUI entrypoint for local-directory loading (the CLI resolves `tui` beside `server`).
// The extension is required: OpenTUI's runtime-rewrite loader only attaches to resolved
// paths with a known extension, and without the rewrite the plugin would get its own
// copies of @opentui/solid and solid-js (whose renderer context differs from the host's).
export { default } from "./src/tui.ts"
