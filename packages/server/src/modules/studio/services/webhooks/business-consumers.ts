import { businessEvents } from './business-events'
import { getChatWebhookDispatcher } from './dispatcher'

let initialized = false
export function ensureBusinessConsumers(): void {
  if (initialized) return
  initialized = true
  businessEvents.subscribe('http-webhook', event => event.chat ? getChatWebhookDispatcher().enqueue(event.chat) : false)
}
