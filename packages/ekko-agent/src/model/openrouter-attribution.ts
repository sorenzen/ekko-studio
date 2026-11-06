/** Empty unless the operator opts in with HERMES_OPENROUTER_APP_* variables. */
export function openRouterAttributionHeaders(baseUrl: string, provider?: string): Record<string, string> {
  let hostname = ''
  try { hostname = new URL(baseUrl).hostname.toLowerCase() } catch { /* Provider ID may identify a proxy. */ }
  const providerId = provider?.trim().toLowerCase().replace(/^custom[:_]/, '')
  if (hostname !== 'openrouter.ai' && !hostname.endsWith('.openrouter.ai') && providerId !== 'openrouter') return {}
  const headers: Record<string, string> = {}
  const referer = process.env.HERMES_OPENROUTER_APP_REFERER?.trim()
  const title = process.env.HERMES_OPENROUTER_APP_TITLE?.trim()
  const categories = process.env.HERMES_OPENROUTER_APP_CATEGORIES?.trim()
  if (referer) headers['HTTP-Referer'] = referer
  if (title) headers['X-OpenRouter-Title'] = title
  if (categories) headers['X-OpenRouter-Categories'] = categories
  return headers
}
