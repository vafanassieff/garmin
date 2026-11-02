import { escapeHtml, page } from './http.ts'
import type { AuthorizeRequest, Authorization, Refusal } from './oauth.ts'

// /authorize's page: who asks, what for, allow or deny (posted to /oauth/authorize)

export const AUTHORIZE_FIELDS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'state',
  'scope',
  'resource',
] as const

// The request's fields, from a query or a form (checked by OAuth.check)
export const authorizeRequest = (field: (name: string) => string | null): AuthorizeRequest =>
  Object.fromEntries(
    AUTHORIZE_FIELDS.flatMap((name) => {
      const value = field(name)
      return value === null ? [] : [[name, value]]
    })
  )

const REFUSALS: Record<Refusal, string> = {
  client: "Cette application n'est pas enregistrée (ou plus) : reconnecte-la depuis son côté.",
  redirect: "L'adresse de retour ne correspond pas à celle que l'application a enregistrée.",
  response_type: 'Seul le flux « code » est accepté.',
  pkce: 'La demande doit porter un défi PKCE (S256).',
  resource: 'La demande vise un autre serveur que ce MCP.',
  state: 'Le paramètre state est trop long.',
}

export const refusedPage = (refusal: Refusal) =>
  page(
    'demande refusée',
    `<h1>Demande refusée</h1><p class="error">${escapeHtml(REFUSALS[refusal])}</p><p><a href="/">Retour à l'app</a></p>`,
    { status: 400 }
  )

export const consentPage = (request: AuthorizeRequest, authorization: Authorization) => {
  const hidden = AUTHORIZE_FIELDS.flatMap((name) => {
    const value = request[name]
    return value === undefined
      ? []
      : [`<input type="hidden" name="${name}" value="${escapeHtml(value)}">`]
  }).join('')
  const back = new URL(authorization.redirect_uri)
  return page(
    'autoriser une application',
    `<h1>Autoriser ${escapeHtml(authorization.client_name)} ?</h1>
<p><strong>${escapeHtml(authorization.client_name)}</strong> demande l'accès au MCP Garmin.</p>
<ul>
<li>Il pourra lire toutes tes données : activités, sommeil, santé, synchronisations.</li>
<li>Lecture seule : il ne peut rien modifier, ni sur Garmin ni ici.</li>
<li>Jusqu'à ce que tu le révoques sur <a href="/access">Accès MCP</a>, ou changes le mot de passe.</li>
</ul>
<p>Retour vers <code>${escapeHtml(back.host)}</code>. Si tu n'as pas lancé cette connexion, refuse.</p>
<form method="post" action="/oauth/authorize">${hidden}<div class="actions"><button class="primary" type="submit" name="decision" value="allow">Autoriser</button><button class="secondary" type="submit" name="decision" value="deny">Refuser</button></div></form>`
  )
}
