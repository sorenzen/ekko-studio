<script setup lang="ts">
import { usePageLoadingTask } from '@/composables/usePageLoading'
import { computed, h, onMounted, onUnmounted, ref, watch } from 'vue'
import { NSpin, NAlert, NButton, NDataTable, NEmpty, NModal, NPopconfirm, NSwitch, NTabPane, NTabs, NTag, useMessage } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import QRCode from 'qrcode'
import {
  createLanAppAuthorization,
  createCloudAppAuthorization,
  deleteAppConnection,
  fetchAppConnections,
  updateAppConnectionPush,
  type AppConnection,
  type AppConnectionAccessFailure,
  type CloudAppAuthorizationResponse,
  type LanAppAuthorizationResponse,
} from '@/api/studio/app-connections'
import {
  fetchAppRelayStatus,
  updateAppRelayRoute,
  type AppRelayRoute,
} from '@/api/studio/app-relay'
import SocialMessagesView from '@/views/social-messages/SocialMessagesView.vue'

type AppPanelView = 'list' | 'messages'

function normalizePanelView(value: unknown): AppPanelView {
  if (value === 'list' || value === 'messages') return value
  return 'list'
}

const DISMISSED_ACCESS_FAILURE_KEY = 'hermes:app-access-failure-dismissed-at'
const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const message = useMessage()
const loading = ref(false)
const panelView = ref<AppPanelView>(normalizePanelView(route.query.view))
const connections = ref<AppConnection[]>([])
const accessFailure = ref<AppConnectionAccessFailure | null>(null)
const dismissedAccessFailureAt = ref(readDismissedAccessFailureAt())
const showScanModal = ref(false)
const connectionTab = ref<'lan' | 'cloud'>('lan')
const cloudRelayRoute = ref<AppRelayRoute>('official')
const cloudRelayRouteLoading = ref(false)
const authorizationLoading = ref<Record<'lan' | 'cloud', boolean>>({ lan: false, cloud: false })
const deletingConnectionId = ref<number | null>(null)
const updatingPushIds = ref(new Set<number>())
let pushPreferenceRevision = 0
const lanAuthorization = ref<LanAppAuthorizationResponse | null>(null)
const cloudAuthorization = ref<CloudAppAuthorizationResponse | null>(null)
const qrCodeDataUrls = ref<Record<'lan' | 'cloud', string>>({ lan: '', cloud: '' })
const currentTimestamp = ref(Math.floor(Date.now() / 1000))
let countdownTimer: ReturnType<typeof setInterval> | null = null
let connectionPollTimer: ReturnType<typeof setInterval> | null = null
let scanConnectionVersions = new Map<string, number>()
let connectionsRequestInFlight = false

const CONNECTION_POLL_INTERVAL_MS = 3_000
const APP_RELAY_ROUTE_OPTIONS = [
  { value: 'official' as const, label: 'connections.app.officialRoute' },
  { value: 'cloudflare' as const, label: 'connections.app.cloudflareRoute' },
]

const activeAuthorization = computed(() => connectionTab.value === 'lan'
  ? lanAuthorization.value
  : cloudAuthorization.value)
const activeQrCodeDataUrl = computed(() => qrCodeDataUrls.value[connectionTab.value])
const remainingSeconds = computed(() => Math.max(
  0,
  (activeAuthorization.value?.expires_at || 0) - currentTimestamp.value,
))
const authorizationExpired = computed(() => Boolean(activeAuthorization.value) && remainingSeconds.value === 0)
const remainingTime = computed(() => {
  const minutes = Math.floor(remainingSeconds.value / 60).toString().padStart(2, '0')
  const seconds = (remainingSeconds.value % 60).toString().padStart(2, '0')
  return `${minutes}:${seconds}`
})
const accessFailureReason = computed(() => {
  const failure = accessFailure.value
  if (!failure) return ''
  if (failure.code === 'cloud_subscription_required') {
    return t('connections.app.accessFailures.cloudSubscriptionRequired')
  }
  if (failure.code === 'paid_account_required') {
    return t('connections.app.accessFailures.paidAccountRequired')
  }
  if (failure.code === 'app_access_expired') {
    return t('connections.app.accessFailures.appAccessExpired')
  }
  if (failure.plan === 'internal' || failure.plan === 'public_beta') {
    return t('connections.app.accessFailures.tokenExpired')
  }
  if (failure.plan === 'paid' && failure.code === 'app_entitlement_expired') {
    if (failure.tokenTtlSeconds === 0) {
      return t('connections.app.accessFailures.paidAccountRequired')
    }
    return t('connections.app.accessFailures.tokenExpired')
  }
  const reasonKeys: Record<string, string> = {
    app_entitlement_required: 'required',
    app_entitlement_invalid: 'invalid',
    app_entitlement_expired: 'expired',
    app_entitlement_account_mismatch: 'accountMismatch',
    app_entitlement_device_mismatch: 'deviceMismatch',
  }
  return t(`connections.app.accessFailures.${reasonKeys[failure.code] || 'unknown'}`)
})
const accessFailureMode = computed(() => {
  const plan = accessFailure.value?.plan || 'unknown'
  const knownPlan = plan === 'internal' || plan === 'public_beta' || plan === 'paid' ? plan : 'unknown'
  return t(`connections.app.accessModes.${knownPlan}`)
})
const accessFailureTime = computed(() => {
  const occurredAt = Number(accessFailure.value?.occurredAt || 0)
  if (!occurredAt) return ''
  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(occurredAt))
})
const columns = computed<DataTableColumns<AppConnection>>(() => [
  {
    title: t('connections.app.deviceName'),
    key: 'device_name',
    minWidth: 160,
    ellipsis: { tooltip: true },
  },
  {
    title: t('connections.app.deviceCode'),
    key: 'device_code',
    minWidth: 200,
    ellipsis: { tooltip: true },
  },
  {
    title: t('connections.app.deviceBrand'),
    key: 'device_brand',
    minWidth: 120,
    ellipsis: { tooltip: true },
    render(row) {
      return row.device_brand || '-'
    },
  },
  {
    title: t('connections.app.deviceModel'),
    key: 'device_model',
    minWidth: 160,
    ellipsis: { tooltip: true },
    render(row) {
      return row.device_model || '-'
    },
  },
  {
    title: t('connections.app.connectionType'),
    key: 'connection_type',
    width: 140,
    render(row) {
      return t(`connections.app.connectionTypes.${row.connection_type}`)
    },
  },
  {
    title: t('connections.app.authorizedUser'),
    key: 'username',
    minWidth: 140,
    ellipsis: { tooltip: true },
    render(row) {
      return row.username || '-'
    },
  },
  {
    title: t('connections.app.connectionStatus'),
    key: 'online',
    width: 120,
    render(row) {
      if (row.online == null) return '-'
      return h(NTag, {
        size: 'small',
        type: row.online ? 'success' : 'default',
        bordered: false,
      }, { default: () => t(row.online ? 'connections.app.online' : 'connections.app.offline') })
    },
  },
  {
    title: t('connections.app.authorizationStatus'),
    key: 'active',
    width: 110,
    render(row) {
      return h(NTag, {
        size: 'small',
        type: row.active ? 'success' : 'default',
        bordered: false,
      }, { default: () => t(row.active ? 'connections.app.active' : 'connections.app.expired') })
    },
  },
  {
    title: t('connections.app.pushNotifications'),
    key: 'push_enabled',
    width: 120,
    fixed: 'right',
    render(row) {
      return h(NSwitch, {
        value: row.push_enabled !== false,
        loading: updatingPushIds.value.has(row.id),
        disabled: row.can_manage_push === false || updatingPushIds.value.has(row.id),
        'aria-disabled': row.can_manage_push === false || updatingPushIds.value.has(row.id),
        'aria-label': t('connections.app.pushForDevice', { name: row.device_name || row.device_code }),
        onUpdateValue: (value: boolean) => updatePushPreference(row, value),
      })
    },
  },
  {
    title: t('connections.app.actions'),
    key: 'actions',
    width: 100,
    fixed: 'right',
    render(row) {
      return h(NPopconfirm, {
        positiveText: t('connections.app.delete'),
        negativeText: t('common.cancel'),
        onPositiveClick: () => deleteConnection(row),
      }, {
        default: () => t('connections.app.deleteConfirm', { name: row.device_name || row.device_code }),
        trigger: () => h(NButton, {
          size: 'small',
          type: 'error',
          quaternary: true,
          loading: deletingConnectionId.value === row.id,
        }, { default: () => t('connections.app.delete') }),
      })
    },
  },
])

function connectionIdentity(connection: AppConnection): string {
  return `${connection.device_code}:${connection.connection_type}:${connection.cloud_user_id}`
}

async function loadConnections(options: { silent?: boolean; detectScanConnection?: boolean } = {}) {
  if (connectionsRequestInFlight) return
  connectionsRequestInFlight = true
  if (!options.silent) loading.value = true
  const preferenceRevision = pushPreferenceRevision
  try {
    const response = await fetchAppConnections()
    connections.value = response.connections.map(row => {
      // A polling response begun before a toggle must not undo its saved value.
      const current = connections.value.find(item => item.id === row.id)
      return current && (preferenceRevision !== pushPreferenceRevision || updatingPushIds.value.has(row.id))
        ? { ...row, push_enabled: current.push_enabled } : row
    })
    const nextFailure = response.access_failure || null
    const previousFailureAt = Number(accessFailure.value?.occurredAt || 0)
    const visibleFailure = nextFailure && nextFailure.occurredAt > dismissedAccessFailureAt.value
      ? nextFailure
      : null
    accessFailure.value = visibleFailure
    if (visibleFailure && visibleFailure.occurredAt > previousFailureAt && showScanModal.value) {
      showScanModal.value = false
      lanAuthorization.value = null
      cloudAuthorization.value = null
      qrCodeDataUrls.value = { lan: '', cloud: '' }
    }
    if (options.detectScanConnection && showScanModal.value) {
      const connected = response.connections.some(connection => (
        connection.active
        && connection.updated_at > (scanConnectionVersions.get(connectionIdentity(connection)) || 0)
      ))
      if (connected) {
        showScanModal.value = false
        lanAuthorization.value = null
        cloudAuthorization.value = null
        qrCodeDataUrls.value = { lan: '', cloud: '' }
        message.success(t('connections.app.connectionDetected'))
      }
    }
  } catch (error: any) {
    if (!options.silent) message.error(error?.message || t('connections.app.loadFailed'))
  } finally {
    connectionsRequestInFlight = false
    if (!options.silent) loading.value = false
  }
}

function readDismissedAccessFailureAt(): number {
  try {
    const value = Number(localStorage.getItem(DISMISSED_ACCESS_FAILURE_KEY) || 0)
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

function dismissAccessFailure(): void {
  const occurredAt = Number(accessFailure.value?.occurredAt || 0)
  if (occurredAt > dismissedAccessFailureAt.value) {
    dismissedAccessFailureAt.value = occurredAt
    try {
      localStorage.setItem(DISMISSED_ACCESS_FAILURE_KEY, String(occurredAt))
    } catch {
      // The in-memory dismissal still prevents the polling loop from reopening it.
    }
  }
  accessFailure.value = null
}

function authorizationErrorMessage(error: any): string {
  const code = String(error?.message || '')
  if (code === 'preconnection_refresh_rate_limited') return t('connections.app.refreshTooSoon')
  if (code === 'preconnection_refresh_limit_reached') return t('connections.app.refreshLimitReached')
  if (code === 'preconnection_expired') return t('connections.app.preconnectionExpired')
  if (code === 'app_relay_unavailable') return t('connections.app.cloudUnavailable')
  return error?.message || t('connections.app.authorizationFailed')
}

async function generateAuthorization(type: 'lan' | 'cloud', refresh = false) {
  if (authorizationLoading.value[type]) return
  authorizationLoading.value = { ...authorizationLoading.value, [type]: true }
  try {
    const response = type === 'lan'
      ? await createLanAppAuthorization()
      : await createCloudAppAuthorization(refresh, cloudRelayRoute.value)
    const dataUrl = await QRCode.toDataURL(response.qr_payload, {
      width: 320,
      margin: 4,
      errorCorrectionLevel: 'L',
      color: { dark: '#111111', light: '#ffffff' },
    })
    currentTimestamp.value = Math.floor(Date.now() / 1000)
    if (type === 'lan') lanAuthorization.value = response as LanAppAuthorizationResponse
    else {
      cloudAuthorization.value = response as CloudAppAuthorizationResponse
      cloudRelayRoute.value = (response as CloudAppAuthorizationResponse).relay_route
    }
    qrCodeDataUrls.value = { ...qrCodeDataUrls.value, [type]: dataUrl }
  } catch (error: any) {
    message.error(authorizationErrorMessage(error))
  } finally {
    authorizationLoading.value = { ...authorizationLoading.value, [type]: false }
  }
}

async function loadCloudRelayRoute(): Promise<void> {
  try {
    const status = await fetchAppRelayStatus()
    cloudRelayRoute.value = status.route || 'official'
  } catch {
    cloudRelayRoute.value = 'official'
  }
}

async function selectCloudRelayRoute(route: AppRelayRoute): Promise<void> {
  if (cloudRelayRouteLoading.value || route === cloudRelayRoute.value) return
  cloudRelayRoute.value = route
  cloudAuthorization.value = null
  qrCodeDataUrls.value = { ...qrCodeDataUrls.value, cloud: '' }
  cloudRelayRouteLoading.value = true
  try {
    const status = await updateAppRelayRoute(route)
    cloudRelayRoute.value = status.route
    message.success(t('connections.app.routeSwitched'))
    if (showScanModal.value && connectionTab.value === 'cloud') {
      await generateAuthorization('cloud')
    }
  } catch (error: any) {
    message.error(error?.message || t('connections.app.routeSwitchFailed'))
    await loadCloudRelayRoute()
  } finally {
    cloudRelayRouteLoading.value = false
  }
}

function ensureCurrentAuthorization(type: 'lan' | 'cloud', verifyRelaySession = false): void {
  const authorization = type === 'lan' ? lanAuthorization.value : cloudAuthorization.value
  const now = Math.floor(Date.now() / 1000)
  currentTimestamp.value = now
  if (type === 'cloud' && verifyRelaySession) {
    cloudAuthorization.value = null
    qrCodeDataUrls.value = { ...qrCodeDataUrls.value, cloud: '' }
    void generateAuthorization('cloud')
    return
  }
  if (!authorization || authorization.expires_at <= now) {
    void generateAuthorization(type)
  }
}

async function updatePushPreference(connection: AppConnection, enabled: boolean) {
  if (updatingPushIds.value.has(connection.id)) return
  updatingPushIds.value.add(connection.id)
  pushPreferenceRevision++
  try {
    const response = await updateAppConnectionPush(connection.id, enabled)
    connections.value = connections.value.map(row => row.id === connection.id ? { ...row, push_enabled: response.push_enabled } : row)
  } catch (error: any) {
    message.error(error?.message || t('connections.app.pushUpdateFailed'))
  } finally {
    pushPreferenceRevision++
    updatingPushIds.value.delete(connection.id)
  }
}

async function deleteConnection(connection: AppConnection) {
  if (deletingConnectionId.value != null) return
  deletingConnectionId.value = connection.id
  try {
    await deleteAppConnection(connection.id)
    connections.value = connections.value.filter(item => item.id !== connection.id)
    message.success(t('connections.app.deleted'))
  } catch (error: any) {
    message.error(error?.message || t('connections.app.deleteFailed'))
  } finally {
    deletingConnectionId.value = null
  }
}

function openScanModal() {
  connectionTab.value = 'lan'
  scanConnectionVersions = new Map(
    connections.value.map(connection => [connectionIdentity(connection), connection.updated_at]),
  )
  showScanModal.value = true
  ensureCurrentAuthorization('lan')
}

function updatePanelView(view: AppPanelView): void {
  panelView.value = view
  void router.replace({
    query: {
      ...route.query,
      view: view === 'list' ? undefined : view,
    },
  })
}

watch(
  () => route.query.view,
  value => {
    panelView.value = normalizePanelView(value)
  },
)

watch(connectionTab, (type) => {
  ensureCurrentAuthorization(type, type === 'cloud')
})

const initializing = ref(true)
usePageLoadingTask(() => initializing.value)

onMounted(() => {
  void Promise.allSettled([loadConnections(), loadCloudRelayRoute()])
    .finally(() => { initializing.value = false })
  countdownTimer = setInterval(() => {
    currentTimestamp.value = Math.floor(Date.now() / 1000)
  }, 1000)
  connectionPollTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return
    void loadConnections({ silent: true, detectScanConnection: true })
  }, CONNECTION_POLL_INTERVAL_MS)
})

onUnmounted(() => {
  if (countdownTimer) clearInterval(countdownTimer)
  if (connectionPollTimer) clearInterval(connectionPollTimer)
})
</script>

<template>
  <section class="app-connections-panel">
    <header class="panel-header">
      <div class="panel-heading">
        <h2>{{ t('connections.tabs.app') }}</h2>
        <p>{{ t('connections.app.subtitle') }}</p>
      </div>
      <div class="panel-actions">
        <div class="view-switch" role="tablist" data-theme-surface="input">
          <button
            type="button"
            class="view-switch-button"
            :class="{ 'view-switch-button--active': panelView === 'list' }"
            :aria-selected="panelView === 'list'"
            @click="updatePanelView('list')"
          >
            {{ t('connections.app.viewList') }}
          </button>
        </div>
        <NButton size="small" type="primary" @click="openScanModal">
          {{ t('connections.app.scanToAdd') }}
        </NButton>
      </div>
    </header>

    <NAlert
      v-if="accessFailure"
      class="app-access-failure"
      type="error"
      :title="t('connections.app.accessFailureTitle')"
      :bordered="false"
      closable
      @close="dismissAccessFailure"
    >
      <div class="app-access-failure__reason">{{ accessFailureReason }}</div>
      <div class="app-access-failure__meta">
        <span>{{ t('connections.app.accessFailureMode', { mode: accessFailureMode }) }}</span>
        <span v-if="accessFailure.deviceName">
          {{ t('connections.app.accessFailureDeviceName', { deviceName: accessFailure.deviceName }) }}
        </span>
        <span>{{ t('connections.app.accessFailureTime', { time: accessFailureTime }) }}</span>
      </div>
    </NAlert>

    <template v-if="panelView === 'list'">
      <div class="cloud-route-setting" data-theme-surface="card">
        <div class="cloud-route-copy">
          <strong>{{ t('connections.app.routeTitle') }}</strong>
          <span>{{ t('connections.app.routeDescription') }}</span>
        </div>
        <div class="cloud-route-options" role="radiogroup" :aria-label="t('connections.app.routeTitle')">
          <button
            v-for="option in APP_RELAY_ROUTE_OPTIONS"
            :key="option.value"
            type="button"
            class="cloud-route-option"
            :class="{ 'cloud-route-option--active': cloudRelayRoute === option.value }"
            :disabled="cloudRelayRouteLoading"
            :aria-checked="cloudRelayRoute === option.value"
            role="radio"
            @click="selectCloudRelayRoute(option.value)"
          >
            <span>{{ t(option.label) }}</span>
          </button>
        </div>
      </div>

      <div class="app-connections-table">
        <NDataTable
          size="small"
          :columns="columns"
          :data="connections"
          :loading="loading"
          bordered
          :single-line="false"
          :row-key="(row: AppConnection) => row.id"
          :scroll-x="1490"
          flex-height
        >
          <template #empty>
            <NEmpty size="small" :description="t('connections.app.empty')" />
          </template>
        </NDataTable>
      </div>
    </template>

    <SocialMessagesView v-else embedded class="app-message-push" />
  </section>

  <NModal
    v-model:show="showScanModal"
    preset="card"
    style="width: 560px; max-width: calc(100vw - 32px)"
    :title="t('connections.app.scanModalTitle')"
    :bordered="false"
  >
    <NTabs v-model:value="connectionTab" type="line" animated>
      <NTabPane name="lan" :tab="t('connections.app.lanConnection')">
        <div class="connection-pane">
          <NSpin v-if="authorizationLoading.lan && !lanAuthorization" size="small" />

          <template v-else-if="lanAuthorization">
            <div class="connection-qr" :class="{ 'connection-qr--expired': authorizationExpired }">
              <img :src="activeQrCodeDataUrl" :alt="t('connections.app.scanModalTitle')">
              <div v-if="authorizationExpired" class="connection-qr-expired">
                {{ t('connections.app.authorizationExpired') }}
              </div>
            </div>

            <div class="connection-meta">
              <div class="connection-countdown" :class="{ expired: authorizationExpired }">
                {{ authorizationExpired
                  ? t('connections.app.authorizationExpired')
                  : t('connections.app.remainingTime', { time: remainingTime }) }}
              </div>
              <NButton
                class="refresh-qr-button"
                size="small"
                quaternary
                :loading="authorizationLoading.lan"
                @click="generateAuthorization('lan')"
              >
                <template #icon>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
                    <path d="M20 6v5h-5" />
                    <path d="M4 18v-5h5" />
                    <path d="M6.1 9a7 7 0 0 1 11.6-2.6L20 9" />
                    <path d="M17.9 15a7 7 0 0 1-11.6 2.6L4 15" />
                  </svg>
                </template>
                {{ t('connections.app.refreshQr') }}
              </NButton>
            </div>
          </template>
        </div>
      </NTabPane>

      <NTabPane name="cloud" :tab="t('connections.app.cloudConnection')">
        <div class="connection-pane">
          <div class="cloud-route-setting cloud-route-setting--qr" data-theme-surface="card">
            <div class="cloud-route-copy">
              <strong>{{ t('connections.app.routeTitle') }}</strong>
              <span>{{ t('connections.app.qrRouteDescription') }}</span>
            </div>
            <div class="cloud-route-options" role="radiogroup" :aria-label="t('connections.app.routeTitle')">
              <button
                v-for="option in APP_RELAY_ROUTE_OPTIONS"
                :key="option.value"
                type="button"
                class="cloud-route-option"
                :class="{ 'cloud-route-option--active': cloudRelayRoute === option.value }"
                :disabled="cloudRelayRouteLoading || authorizationLoading.cloud"
                :aria-checked="cloudRelayRoute === option.value"
                role="radio"
                @click="selectCloudRelayRoute(option.value)"
              >
                <span>{{ t(option.label) }}</span>
              </button>
            </div>
          </div>
          <NSpin v-if="authorizationLoading.cloud && !cloudAuthorization" size="small" />

          <template v-else-if="cloudAuthorization">
            <div class="connection-qr" :class="{ 'connection-qr--expired': authorizationExpired }">
              <img :src="activeQrCodeDataUrl" :alt="t('connections.app.scanModalTitle')">
              <div v-if="authorizationExpired" class="connection-qr-expired">
                {{ t('connections.app.authorizationExpired') }}
              </div>
            </div>

            <div class="connection-meta">
              <div class="connection-countdown" :class="{ expired: authorizationExpired }">
                {{ authorizationExpired
                  ? t('connections.app.authorizationExpired')
                  : t('connections.app.remainingTime', { time: remainingTime }) }}
              </div>
              <NButton
                class="refresh-qr-button"
                size="small"
                quaternary
                :loading="authorizationLoading.cloud"
                @click="generateAuthorization('cloud', true)"
              >
                <template #icon>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
                    <path d="M20 6v5h-5" />
                    <path d="M4 18v-5h5" />
                    <path d="M6.1 9a7 7 0 0 1 11.6-2.6L20 9" />
                    <path d="M17.9 15a7 7 0 0 1-11.6 2.6L4 15" />
                  </svg>
                </template>
                {{ t('connections.app.refreshQr') }}
              </NButton>
            </div>
          </template>
        </div>
      </NTabPane>
    </NTabs>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.app-connections-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.cloud-route-setting {
  flex: 0 0 auto;
  margin: 12px 20px 0;
  padding: calc(12px * var(--spacing-scale, 1)) calc(14px * var(--spacing-scale, 1));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: calc(16px * var(--spacing-scale, 1));
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 10px);
  background: var(--theme-card-bg, var(--theme-card-wallpaper-bg, rgba(var(--bg-card-rgb), 0.7)));
}

.cloud-route-setting--qr {
  width: 100%;
  margin: 0 0 16px;
  box-sizing: border-box;
}

.cloud-route-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: calc(2px * var(--spacing-scale, 1));

  strong {
    color: $text-primary;
    font-size: calc(var(--font-size-base, 14px) * 13 / 14);
    font-weight: 650;
  }

  span {
    color: $text-muted;
    font-size: calc(var(--font-size-base, 14px) * 11 / 14);
    line-height: var(--line-height, calc(var(--font-size-base, 14px) * 16 / 14));
  }
}

.cloud-route-options {
  display: flex;
  flex-shrink: 0;
  gap: calc(8px * var(--spacing-scale, 1));
}

.cloud-route-option {
  min-width: 138px;
  padding: calc(7px * var(--spacing-scale, 1)) calc(10px * var(--spacing-scale, 1));
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: calc(1px * var(--spacing-scale, 1));
  color: $text-secondary;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
  background: transparent;
  cursor: pointer;
  transition: border-color $transition-fast, background-color $transition-fast, color $transition-fast;

  span {
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);
    font-weight: 600;
  }

  &:disabled {
    cursor: wait;
    opacity: 0.6;
  }
}

.cloud-route-option--active {
  color: $accent-primary;
  border-color: rgba(var(--accent-primary-rgb), 0.48);
  background: rgba(var(--accent-primary-rgb), 0.08);
}

.panel-header {
  flex: 0 0 auto;
  min-height: 68px;
  padding: calc(12px * var(--spacing-scale, 1)) calc(20px * var(--spacing-scale, 1));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: calc(16px * var(--spacing-scale, 1));
  border-bottom: var(--border-width, 1px) solid $border-color;
}

.panel-heading {
  min-width: 0;

  h2 {
    margin: 0;
    color: $text-primary;
    font-size: calc(var(--font-size-base, 14px) * 16 / 14);
    font-weight: 650;
    line-height: var(--line-height, calc(var(--font-size-base, 14px) * 22 / 14));
  }

  p {
    margin: 2px 0 0;
    color: $text-muted;
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);
    line-height: var(--line-height, calc(var(--font-size-base, 14px) * 18 / 14));
  }
}

.panel-actions {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: calc(10px * var(--spacing-scale, 1));
}

.view-switch {
  display: flex;
  padding: calc(3px * var(--spacing-scale, 1));
  flex: 0 0 auto;
  gap: calc(2px * var(--spacing-scale, 1));
  background: $bg-secondary;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 10px);
}

.view-switch-button {
  min-width: 56px;
  height: 26px;
  padding: 0 calc(11px * var(--spacing-scale, 1));
  color: $text-muted;
  background: transparent;
  border: 0;
  border-radius: var(--radius-component, 7px);
  cursor: pointer;
  font: inherit;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  line-height: var(--line-height, calc(var(--font-size-base, 14px) * 26 / 14));
  transition: color $transition-fast, background-color $transition-fast, box-shadow $transition-fast;

  &:hover {
    color: $text-primary;
  }

  &:focus-visible {
    outline: 2px solid $accent-primary;
    outline-offset: 1px;
  }

  &--active {
    color: $text-primary;
    background: var(--theme-card-bg, $bg-card);
    box-shadow: 0 1px 4px rgba(var(--text-primary-rgb), 0.1);
    font-weight: 600;
  }
}

.app-connections-table {
  flex: 1 1 auto;
  height: 0;
  min-height: 0;
  padding: calc(16px * var(--spacing-scale, 1)) calc(20px * var(--spacing-scale, 1)) calc(20px * var(--spacing-scale, 1));
  overflow: hidden;

  :deep(.n-data-table) {
    height: 100%;
    --n-td-text-color: var(--text-primary);
    --n-th-text-color: var(--text-secondary);
  }

  :deep(.n-data-table-base-table),
  :deep(.n-data-table-base-table-body) {
    height: 100%;
  }
}

.app-downloads {
  flex: 1 1 auto;
  min-height: 0;
  padding: calc(20px * var(--spacing-scale, 1));
  overflow: auto;
  background: linear-gradient(180deg, rgba(var(--accent-primary-rgb), 0.025), transparent 52%);
}

.app-message-push {
  flex: 1 1 auto;
  min-height: 0;
}

.app-download-layout {
  width: 100%;
  max-width: 1180px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: calc(14px * var(--spacing-scale, 1));
}


.app-download-intro {
  position: relative;
  z-index: 1;
  max-width: 600px;

  > p {
    max-width: 560px;
    margin: 18px 0 0;
    color: $text-secondary;
    font-size: calc(var(--font-size-base, 14px) * 14 / 14);
    line-height: var(--line-height, calc(var(--font-size-base, 14px) * 22 / 14));
  }
}

.app-download-purchase {
  margin-top: 14px;
}

.app-download-brand {
  display: flex;
  align-items: center;
  gap: calc(14px * var(--spacing-scale, 1));

  span {
    display: block;
    margin-bottom: 2px;
    color: $text-muted;
    font-size: calc(var(--font-size-base, 14px) * 10 / 14);
    font-weight: 650;
    letter-spacing: 0.09em;
    line-height: var(--line-height, calc(var(--font-size-base, 14px) * 16 / 14));
    text-transform: uppercase;
  }

  h3 {
    margin: 0;
    color: $text-primary;
    font-size: clamp(21px, 2.5vw, 28px);
    font-weight: 650;
    letter-spacing: -0.03em;
    line-height: var(--line-height, 1.2);
  }
}

.app-download-logo {
  display: block;
  width: 54px;
  height: 54px;
  flex: 0 0 auto;
  object-fit: contain;
  border-radius: var(--radius-component, 6px);
}

.app-download-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 18px;
  gap: calc(7px * var(--spacing-scale, 1));

  span {
    padding: calc(5px * var(--spacing-scale, 1)) calc(9px * var(--spacing-scale, 1));
    color: $text-secondary;
    background: $bg-secondary;
    border: var(--border-width, 1px) solid $border-light;
    border-radius: 999px;
    font-size: calc(var(--font-size-base, 14px) * 10 / 14);
    line-height: var(--line-height, calc(var(--font-size-base, 14px) * 14 / 14));
  }
}

.download-source-switch {
  width: 100%;
  margin-top: 10px;
  box-sizing: border-box;

  .view-switch-button {
    min-width: 0;
    padding: 0 calc(4px * var(--spacing-scale, 1));
    flex: 1 1 0;
    font-size: calc(var(--font-size-base, 14px) * 10 / 14);
  }
}

.app-platform-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: calc(12px * var(--spacing-scale, 1));
}

.app-platform-card {
  position: relative;
  min-height: 188px;
  padding: calc(18px * var(--spacing-scale, 1));
  display: flex;
  box-sizing: border-box;
  flex-direction: column;
  background: var(--theme-card-bg, var(--theme-card-wallpaper-bg, $bg-card));
  border: var(--border-width, 1px) solid $border-color;
  border-radius: var(--radius-component, 14px);
  transition: border-color $transition-fast, box-shadow $transition-fast, transform $transition-fast;

  &--available:hover {
    border-color: rgba(var(--accent-primary-rgb), 0.25);
    box-shadow: 0 10px 28px rgba(var(--text-primary-rgb), 0.065);
    transform: translateY(-1px);
  }

  &--pending {
    background: var(--theme-card-bg, var(--theme-card-wallpaper-bg, rgba(var(--bg-card-rgb), 0.64)));
  }
}

.app-platform-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: calc(12px * var(--spacing-scale, 1));
}

.app-platform-icon {
  width: 42px;
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: $text-primary;
  background: $bg-secondary;
  border-radius: var(--radius-component, 12px);
}

.download-tag-qr {
  position: absolute;
  top: 18px;
  right: 18px;
  z-index: 1;
  width: 112px;
  height: 112px;
  padding: calc(5px * var(--spacing-scale, 1));
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  background: #ffffff;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 7px);

  img {
    display: block;
    width: 100%;
    height: 100%;
  }
}

.download-test-status {
  align-self: center;
  margin-inline-end: auto;
  white-space: nowrap;
}

.app-platform-copy {
  margin: 14px 0 16px;

  h4 {
    margin: 0;
    color: $text-primary;
    font-size: calc(var(--font-size-base, 14px) * 16 / 14);
    font-weight: 650;
    line-height: var(--line-height, calc(var(--font-size-base, 14px) * 22 / 14));
  }

  p {
    margin: 4px 0 0;
    color: $text-muted;
    font-size: calc(var(--font-size-base, 14px) * 11 / 14);
    line-height: var(--line-height, calc(var(--font-size-base, 14px) * 17 / 14));
  }
}

.app-platform-action {
  width: 100%;
  margin-top: auto;
}

.app-platform-actions {
  margin-top: auto;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: calc(8px * var(--spacing-scale, 1));

  .app-platform-action {
    margin-top: 0;

    &:only-child {
      grid-column: 1 / -1;
    }
  }
}

.app-platform-download-controls {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: calc(8px * var(--spacing-scale, 1));

  .download-source-switch {
    margin-top: 0;
  }

  .app-platform-action {
    margin-top: 0;
  }
}

.app-access-failure {
  flex: 0 0 auto;
  margin: 12px 20px 0;

  &__reason {
    color: $text-primary;
    font-size: calc(var(--font-size-base, 14px) * 13 / 14);
    font-weight: 600;
  }

  &__meta {
    margin-top: 4px;
    display: flex;
    flex-wrap: wrap;
    gap: calc(4px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1));
    color: $text-muted;
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  }

  &__actions {
    margin-top: 10px;
    display: flex;
  }
}

.connection-pane {
  min-height: 374px;
  padding: calc(8px * var(--spacing-scale, 1)) 0 calc(4px * var(--spacing-scale, 1));
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: calc(14px * var(--spacing-scale, 1));
}

.connection-qr {
  position: relative;
  width: 320px;
  height: 320px;
  padding: calc(8px * var(--spacing-scale, 1));
  border-radius: $radius-md;
  background: #ffffff;

  img {
    display: block;
    width: 100%;
    height: 100%;
  }

  &--expired img {
    filter: grayscale(1);
    opacity: 0.2;
  }
}

.connection-qr-expired {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: $text-primary;
  font-size: calc(var(--font-size-base, 14px) * 14 / 14);
  font-weight: 600;
  background: rgba(255, 255, 255, 0.72);
}

.connection-countdown {
  color: $text-secondary;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);

  &.expired {
    color: $error;
  }
}

.connection-meta {
  width: 320px;
  min-height: 28px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: calc(12px * var(--spacing-scale, 1));
}

.refresh-qr-button {
  flex: 0 0 auto;
}

@media (max-width: 1100px) {
  .app-platform-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: $breakpoint-mobile) {
  .cloud-route-setting {
    margin: 12px 12px 0;
    align-items: stretch;
    flex-direction: column;
    gap: calc(10px * var(--spacing-scale, 1));
  }

  .cloud-route-setting--qr {
    margin: 0 0 12px;
  }

  .cloud-route-option {
    min-width: 0;
    flex: 1 1 0;
  }

  .panel-header {
    align-items: flex-start;
    flex-direction: column;
    padding: calc(12px * var(--spacing-scale, 1));
  }

  .panel-actions {
    width: 100%;
    justify-content: space-between;
  }

  .app-connections-table {
    padding: calc(12px * var(--spacing-scale, 1));
  }

  .app-downloads {
    padding: calc(12px * var(--spacing-scale, 1));
  }

  .app-download-hero {
    grid-template-columns: 1fr;
    padding: calc(20px * var(--spacing-scale, 1));
    gap: calc(22px * var(--spacing-scale, 1));
  }

  .app-platform-grid {
    grid-template-columns: 1fr;
  }

  .app-platform-card {
    min-height: 174px;
  }

  .app-access-failure {
    margin: 12px 12px 0;
  }

  .connection-qr {
    width: 240px;
    height: 240px;
  }

  .connection-pane {
    min-height: 294px;
  }

  .connection-meta {
    width: 240px;
  }

}
</style>
