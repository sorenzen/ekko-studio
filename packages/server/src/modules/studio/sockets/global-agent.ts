import type { Server, Socket } from 'socket.io'
import { io as createClientSocket, type Socket as ClientSocket } from 'socket.io-client'
import { personNotificationRoom } from '../contracts/person-session'
import { logger } from '../public/logging'
import { authenticateUserToken, type AuthenticatedUser } from '../public/auth'
import { userCanAccessProfile } from '../public/users'
import { config } from '../public/config'

const GLOBAL_AGENT_NAMESPACE = '/global-agent'
const ALLOWED_SOCKET_NAMESPACES = new Set(['/chat-run'])
const ALLOWED_CHAT_RUN_CLIENT_EVENTS = new Set([
  'run',
  'resume',
  'abort',
  'cancel_queued_run',
  'insert_queued_run',
  'approval.respond',
  'clarify.respond',
])
const CHAT_RUN_SERVER_EVENTS = [
  'run.started',
  'message.delta',
  'message.interim',
  'reasoning.delta',
  'thinking.delta',
  'reasoning.available',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'workspace.diff.completed',
  'run.completed',
  'run.failed',
  'compression.started',
  'compression.completed',
  'abort.started',
  'abort.timeout',
  'abort.completed',
  'usage.updated',
  'agent.event',
  'subagent.event',
  'session.command',
  'session.title.updated',
  'run.queued',
  'run.queue_insertion.updated',
  'approval.requested',
  'approval.resolved',
  'clarify.requested',
  'clarify.resolved',
  'peer.user.message',
  'resumed',
]
const NON_STREAMING_SUPPRESSED_EVENTS = new Set([
  'message.delta',
  'message.interim',
  'reasoning.delta',
  'thinking.delta',
  'reasoning.available',
])
const SOCKET_IO_RESERVED_EVENTS = new Set([
  'connect',
  'connect_error',
  'disconnect',
  'disconnecting',
  'newListener',
  'removeListener',
])

interface StartGlobalAgentServerOptions {
  localBaseUrl?: string
}

interface LocalSocketBridge {
  id: string
  ownerSocketId: string
  namespace: string
  socket: ClientSocket
  stream: boolean
  output: string
  reasoning: string
}

interface RelaySocketResponse {
  id?: string
  ok?: boolean
  namespace?: string
  event?: string
  stream?: boolean
  error?: { code: string; message: string }
}

function socketRelayError(id: string | undefined, code: string, message: string): RelaySocketResponse {
  return { id, ok: false, error: { code, message } }
}

function normalizeSocketBridgeId(id?: string): string | null {
  const normalized = String(id || '').trim()
  if (!normalized || normalized.length > 128) return null
  return normalized
}

function normalizeSocketNamespace(namespace?: string): string | null {
  const normalized = String(namespace || '').trim()
  return ALLOWED_SOCKET_NAMESPACES.has(normalized) ? normalized : null
}

function streamMode(value: unknown, fallback = true): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Browser "全局" chat uses this namespace. It opens a loopback /chat-run
 * socket for the signed-in user. MCU devices and cloud relays are not part
 * of this path.
 */
export class GlobalAgentServer {
  private readonly nsp: ReturnType<Server['of']>
  private readonly frontendClients = new Map<string, Socket>()
  private readonly bridgeOwners = new Map<string, string>()
  private readonly localSocketBridges = new Map<string, LocalSocketBridge>()
  private readonly localBaseUrl: string
  private initialized = false

  constructor(io: Server, options: StartGlobalAgentServerOptions = {}) {
    this.nsp = io.of(GLOBAL_AGENT_NAMESPACE)
    this.localBaseUrl = (options.localBaseUrl || `http://127.0.0.1:${config.port}`).replace(/\/$/, '')
  }

  init(): void {
    if (this.initialized) return
    this.initialized = true
    this.nsp.use(async (socket, next) => {
      const auth = socket.handshake.auth || {}
      const token = String(auth.token || '')
      const user = await authenticateUserToken(token)
      if (!user) {
        next(new Error('Unauthorized'))
        return
      }
      const profile = String(auth.profile || socket.handshake.query?.profile || '').trim()
      if (profile && !this.canAccessProfile(user, profile)) {
        next(new Error('Profile access denied'))
        return
      }
      socket.data.user = user
      socket.data.userToken = token
      socket.data.profile = profile
      next()
    })
    this.nsp.on('connection', socket => this.onFrontendConnection(socket))
    logger.info('[global-agent] Socket.IO ready at %s', GLOBAL_AGENT_NAMESPACE)
  }

  getNamespace(): string {
    return GLOBAL_AGENT_NAMESPACE
  }

  private onFrontendConnection(socket: Socket): void {
    this.frontendClients.set(socket.id, socket)
    if (socket.data.user?.id) socket.join(personNotificationRoom(socket.data.user.id))
    logger.info('[global-agent] frontend connected socket=%s user=%s', socket.id, socket.data.user?.id)

    const bind = (event: string) => {
      socket.on(event, (payload: unknown) => {
        void this.emitFrontendChatEvent(socket, event, payload)
      })
    }
    for (const event of ALLOWED_CHAT_RUN_CLIENT_EVENTS) bind(event)

    socket.on('disconnect', () => {
      this.frontendClients.delete(socket.id)
      for (const [bridgeId, ownerSocketId] of this.bridgeOwners.entries()) {
        if (ownerSocketId !== socket.id) continue
        this.bridgeOwners.delete(bridgeId)
        this.closeInboundSocket(socket, { id: bridgeId })
      }
      logger.info('[global-agent] frontend disconnected socket=%s user=%s', socket.id, socket.data.user?.id)
    })
  }

  private openInboundSocket(owner: Socket, request: { id?: string; namespace?: string; stream?: boolean }): RelaySocketResponse {
    if (!owner.data.userToken) {
      return socketRelayError(request.id, 'unauthorized', 'A user login token is required')
    }
    const id = normalizeSocketBridgeId(request.id)
    if (!id) return socketRelayError(request.id, 'invalid_socket_id', 'Relay socket id is required')
    const namespace = normalizeSocketNamespace(request.namespace)
    if (!namespace) return socketRelayError(id, 'namespace_not_allowed', 'Relay socket namespace is not allowed')

    this.closeInboundSocket(owner, { id })
    const profile = this.frontendProfile(owner)
    const localSocket = createClientSocket(`${this.localBaseUrl}${namespace}`, {
      auth: { token: owner.data.userToken },
      query: profile ? { profile } : {},
      transports: ['websocket', 'polling'],
      reconnection: false,
      timeout: 30_000,
    })
    const bridge: LocalSocketBridge = {
      id,
      ownerSocketId: owner.id,
      namespace,
      socket: localSocket,
      stream: streamMode(request.stream),
      output: '',
      reasoning: '',
    }
    this.localSocketBridges.set(this.inboundBridgeKey(owner, id), bridge)
    for (const event of CHAT_RUN_SERVER_EVENTS) {
      localSocket.on(event, (payload: unknown) => {
        this.handleInboundLocalSocketEvent(owner, bridge, event, payload)
      })
    }
    localSocket.on('connect_error', (err: Error) => {
      owner.emit('run.failed', { event: 'run.failed', error: err.message })
    })
    return { id, ok: true, namespace, stream: bridge.stream }
  }

  private emitInboundSocketEvent(owner: Socket, request: { id?: string; event?: string; stream?: boolean; payload?: unknown }): RelaySocketResponse {
    const id = normalizeSocketBridgeId(request.id)
    if (!id) return socketRelayError(request.id, 'invalid_socket_id', 'Relay socket id is required')
    const event = String(request.event || '').trim()
    if (!ALLOWED_CHAT_RUN_CLIENT_EVENTS.has(event)) {
      return socketRelayError(id, 'event_not_allowed', 'Relay socket event is not allowed')
    }
    const bridge = this.localSocketBridges.get(this.inboundBridgeKey(owner, id))
    if (!bridge || bridge.ownerSocketId !== owner.id) {
      return socketRelayError(id, 'socket_not_open', 'Relay socket is not open')
    }
    if (typeof request.stream === 'boolean') bridge.stream = request.stream
    if (event === 'run') {
      bridge.output = ''
      bridge.reasoning = ''
    }
    bridge.socket.emit(event, this.withInboundSocketPayload(owner, request.payload))
    return { id, ok: true, namespace: bridge.namespace, event, stream: bridge.stream }
  }

  private closeInboundSocket(owner: Socket, request: { id?: string }): RelaySocketResponse {
    const id = normalizeSocketBridgeId(request.id)
    if (!id) return socketRelayError(request.id, 'invalid_socket_id', 'Relay socket id is required')
    const key = this.inboundBridgeKey(owner, id)
    const bridge = this.localSocketBridges.get(key)
    if (!bridge || bridge.ownerSocketId !== owner.id) return { id, ok: true }
    bridge.socket.removeAllListeners()
    bridge.socket.disconnect()
    this.localSocketBridges.delete(key)
    return { id, ok: true, namespace: bridge.namespace }
  }

  private handleInboundLocalSocketEvent(owner: Socket, bridge: LocalSocketBridge, event: string, payload: unknown): void {
    if (!bridge.stream) {
      if (event === 'message.delta' && isRecord(payload) && typeof payload.delta === 'string') {
        bridge.output += payload.delta
        return
      }
      if ((event === 'reasoning.delta' || event === 'thinking.delta') && isRecord(payload)) {
        const delta = typeof payload.delta === 'string' ? payload.delta : typeof payload.text === 'string' ? payload.text : ''
        bridge.reasoning += delta
        return
      }
      if (NON_STREAMING_SUPPRESSED_EVENTS.has(event)) return
      if (event === 'run.completed') {
        this.emitFrontendEvent(owner, event, this.withNonStreamingOutput(payload, bridge))
        return
      }
    }
    this.emitFrontendEvent(owner, event, payload)
  }

  private emitFrontendEvent(owner: Socket, event: string, payload: unknown): void {
    if (!event || SOCKET_IO_RESERVED_EVENTS.has(event)) return
    owner.emit(event, payload)
  }

  private withNonStreamingOutput(payload: unknown, bridge: LocalSocketBridge): unknown {
    if (!isRecord(payload)) {
      return { output: bridge.output, ...(bridge.reasoning ? { reasoning: bridge.reasoning } : {}) }
    }
    return {
      ...payload,
      output: typeof payload.output === 'string' && payload.output ? payload.output : bridge.output,
      ...(bridge.reasoning && typeof payload.reasoning !== 'string' ? { reasoning: bridge.reasoning } : {}),
    }
  }

  private withInboundSocketPayload(socket: Socket, payload: unknown): unknown {
    const profile = this.frontendProfile(socket)
    if (!profile || !isRecord(payload)) return payload
    return {
      ...payload,
      profile: typeof payload.profile === 'string' && payload.profile ? payload.profile : profile,
    }
  }

  private inboundBridgeKey(socket: Socket, id: string): string {
    return `${socket.id}:${id}`
  }

  private canAccessProfile(user: AuthenticatedUser, profile: string): boolean {
    return user.role === 'super_admin' || userCanAccessProfile(user.id, profile)
  }

  private frontendProfile(socket: Socket): string {
    return String(socket.data.profile || '').trim()
  }

  private frontendBridgeId(socket: Socket): string {
    return `frontend:${socket.id}:chat-run`
  }

  private ensureFrontendChatBridge(socket: Socket): string | null {
    const id = this.frontendBridgeId(socket)
    if (this.bridgeOwners.get(id) === socket.id && this.localSocketBridges.has(this.inboundBridgeKey(socket, id))) {
      return id
    }
    const response = this.openInboundSocket(socket, { id, namespace: '/chat-run', stream: true })
    if (response.error) {
      socket.emit('run.failed', { event: 'run.failed', error: response.error.message })
      return null
    }
    this.bridgeOwners.set(id, socket.id)
    return id
  }

  private async emitFrontendChatEvent(socket: Socket, event: string, payload: unknown): Promise<void> {
    const id = this.ensureFrontendChatBridge(socket)
    if (!id) return
    const response = this.emitInboundSocketEvent(socket, { id, event, payload })
    if (response.error) {
      const sessionId = isRecord(payload) ? String(payload.session_id || '') : ''
      socket.emit('run.failed', {
        event: 'run.failed',
        ...(sessionId ? { session_id: sessionId } : {}),
        error: response.error.message,
      })
    }
  }
}

let activeGlobalAgentServer: GlobalAgentServer | null = null

export function getActiveGlobalAgentServer(): GlobalAgentServer | null {
  return activeGlobalAgentServer
}

export function startGlobalAgentServer(io: Server, options: StartGlobalAgentServerOptions = {}): GlobalAgentServer {
  if (activeGlobalAgentServer) return activeGlobalAgentServer
  activeGlobalAgentServer = new GlobalAgentServer(io, options)
  activeGlobalAgentServer.init()
  return activeGlobalAgentServer
}

export function getGlobalAgentServer(): GlobalAgentServer | null {
  return activeGlobalAgentServer
}
