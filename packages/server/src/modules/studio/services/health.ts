import { readStudioPackageInfo } from './package-info'
import type { StudioHealthDependencies } from '../contracts/health'

declare const __APP_VERSION__: string

export class StudioHealthService {
  private readonly packageInfo = readStudioPackageInfo()
  private readonly localVersion = typeof __APP_VERSION__ !== 'undefined'
    ? __APP_VERSION__
    : this.packageInfo?.version || ''

  constructor(private readonly dependencies: StudioHealthDependencies) {}

  async checkLatestVersion(): Promise<void> {
    // Studio does not query the npm registry for newer releases.
  }

  startVersionCheck(): void {
    // Kept so older callers can invoke startup without contacting npm.
  }

  async snapshot() {
    const rawVersion = await this.dependencies.getPrimaryAgentVersion()
    const primaryAgentVersion = rawVersion.split('\n')[0].replace('Hermes Agent ', '') || ''
    const agentBridge = await this.dependencies.getPrimaryAgentBridgeHealth()
    return {
      status: 'ok',
      platform: this.dependencies.platform,
      version: primaryAgentVersion,
      gateway: 'running',
      webui_version: this.localVersion,
      webui_latest: '',
      webui_update_available: false,
      node_version: process.versions.node,
      agent_bridge: agentBridge,
      is_docker: this.dependencies.isDockerContainer(),
    }
  }
}
