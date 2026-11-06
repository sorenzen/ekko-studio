import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function desktopUpdateChannel(platform = process.platform, arch = process.arch): string {
  return platform === 'win32' && arch === 'arm64' ? 'latest-arm64' : 'latest'
}

export type DesktopUpdateSource =
  | { channel: 'disabled' }
  | { channel: 'opt-in'; url: string }
  | { channel: 'test'; url: string }

function optInFeedUrl(): string {
  return process.env.EKKO_STUDIO_UPDATE_FEED_URL?.trim() || ''
}

export function validateTestUpdateUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\t]/.test(value)) {
    throw new Error('A test update feed directory URL is required')
  }
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('Invalid test update feed URL') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Test update feeds require HTTPS without credentials, query parameters or fragments')
  }
  const path = decodeURIComponent(url.pathname).replace(/\/+$/, '').toLowerCase()
  if (path.endsWith('.yml') || path.endsWith('.yaml')) {
    throw new Error('Use the feed directory URL, not the update manifest URL')
  }
  if (url.hostname === 'download.ekkolearnai.com' || url.hostname.endsWith('.ekkolearnai.com') || url.hostname === 'ekkostudio.xyz' || url.hostname.endsWith('.ekkostudio.xyz')) {
    throw new Error('Official Ekko update hosts are not used')
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
  return url.href
}

export function resolveDesktopUpdateSource(metadata: unknown): DesktopUpdateSource {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Invalid desktop package metadata')
  }
  // Only package metadata can select a test feed. No runtime environment or UI
  // setting can switch a production installation to a test server.
  if (!Object.prototype.hasOwnProperty.call(metadata, 'desktopUpdate')) {
    const url = optInFeedUrl()
    if (!url) return { channel: 'disabled' }
    return { channel: 'opt-in', url: validateTestUpdateUrl(url) }
  }
  const config = (metadata as { desktopUpdate: unknown }).desktopUpdate
  if (!config || typeof config !== 'object' || !('channel' in config) || config.channel !== 'test' || !('url' in config)) {
    throw new Error('Invalid packaged test update configuration; refusing to use production feeds')
  }
  return { channel: 'test', url: validateTestUpdateUrl(config.url) }
}

export function readDesktopUpdateSource(appPath: string): DesktopUpdateSource {
  // Read/parse errors deliberately propagate: broken test metadata must not
  // silently turn a test installation back into a production installation.
  return resolveDesktopUpdateSource(JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8')))
}
