import type { Socket } from 'socket.io'
import type { BusinessEvent } from './business-events'

/** Mobile App notification projection is removed. The signature stays for existing socket setup. */
export function bindLegacyAppEvents(_socket: Socket, _kind: 'chat' | 'group' | 'workflow', _canReceive: (event: BusinessEvent) => boolean): void {
}
