// The shortest password the app takes: it is also the MCP's bearer token. Apart from auth.ts, so
// the pages (bundled for the browser) can say it without importing node:crypto.
export const MIN_PASSWORD_LENGTH = 12
