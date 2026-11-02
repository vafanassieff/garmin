import { SCOPE } from './oauth.ts'

// The OAuth server's HTTP answers (see routes/oauth/, routes/[.]well-known.$.ts)

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

// RFC 9728: the MCP, and who issues its tokens
export const resourceMetadata = (origin: string) => ({
  resource: `${origin}/mcp`,
  authorization_servers: [origin],
  scopes_supported: [SCOPE],
  bearer_methods_supported: ['header'],
  resource_name: 'Garmin',
})

// RFC 8414: how to register, authorize and get tokens
export const serverMetadata = (origin: string) => ({
  issuer: origin,
  authorization_endpoint: `${origin}/authorize`,
  token_endpoint: `${origin}/oauth/token`,
  registration_endpoint: `${origin}/oauth/register`,
  revocation_endpoint: `${origin}/oauth/revoke`,
  scopes_supported: [SCOPE],
  response_types_supported: ['code'],
  response_modes_supported: ['query'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['none'],
  revocation_endpoint_auth_methods_supported: ['none'],
  code_challenge_methods_supported: ['S256'],
  authorization_response_iss_parameter_supported: true,
})

// A registration's JSON, 16 KiB at most, unread past that. As application/json only: a web page
// cannot send that from another site without a preflight, which fails (no CORS).
const MAX_JSON = 16_384
export const readJson = async (request: Request): Promise<unknown> => {
  const type = request.headers.get('content-type') ?? ''
  if (!/^application\/json\s*(?:;|$)/iu.test(type)) return undefined
  const length = Number(request.headers.get('content-length'))
  if (!Number.isInteger(length) || length <= 0 || length > MAX_JSON) return undefined
  try {
    return (await request.json()) as unknown
  } catch {
    return undefined
  }
}

export const escapeHtml = (value: string) =>
  value.replaceAll(
    /[&<>"']/gu,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character
  )

// The OAuth pages: plain HTML from the server, styled like the app (light and dark). Every value
// in them goes through escapeHtml.
const STYLE = `
:root{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink-2:#52514e;--axis:#c3c2b7;--ring:rgba(11,11,11,.1);--accent:#2a78d6;--critical:#d03b3b;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink-2:#c3c2b7;--axis:#383835;--ring:rgba(255,255,255,.1);--accent:#3987e5}}
body{margin:0;background:var(--page);color:var(--ink)}
.shell{max-width:440px;margin:0 auto;padding:12vh 16px 32px}
.card{background:var(--surface);border-radius:12px;box-shadow:0 0 0 1px var(--ring);padding:20px}
h1{font-size:20px;margin:0 0 6px}
p{color:var(--ink-2);font-size:14px;line-height:1.5;margin:8px 0}
strong{color:var(--ink)}
ul{color:var(--ink-2);font-size:14px;line-height:1.5;padding-left:18px;margin:8px 0}
code{font-size:13px}
.actions{display:flex;gap:8px;margin-top:16px}
button{font:inherit;font-weight:550;padding:9px 14px;border-radius:8px;cursor:pointer;border:0}
.primary{background:var(--accent);color:#fff}
.secondary{background:transparent;color:var(--ink);box-shadow:inset 0 0 0 1px var(--axis)}
.error{color:var(--critical)}
a{color:var(--accent)}`

export const page = (
  title: string,
  body: string,
  { status = 200, head = '' }: { readonly status?: number; readonly head?: string } = {}
) =>
  new Response(
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">${head}<title>Garmin · ${escapeHtml(title)}</title><style>${STYLE}</style></head><body><div class="shell"><div class="card">${body}</div></div></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } }
  )

// Back to the client (its loopback redirect, out of this site): a page that goes there, as a
// redirect answering the consent form would be stopped by the CSP's form-action 'self'. Denied,
// only a local app is gone back to at once: a web address gets a link to follow, or not.
export const backTo = (location: string, allowed: boolean) => {
  const href = escapeHtml(location)
  const title = allowed ? 'Accès autorisé' : 'Accès refusé'
  const at_once = allowed || new URL(location).protocol === 'http:'
  return page(
    title,
    at_once
      ? `<h1>${title}</h1><p>Retour vers l'application… <a href="${href}">Continuer</a></p>`
      : `<h1>${title}</h1><p>L'application n'a reçu aucun accès. <a href="${href}">Le lui dire</a> · <a href="/">Retour à l'app</a></p>`,
    at_once ? { head: `<meta http-equiv="refresh" content="0;url=${href}">` } : {}
  )
}
