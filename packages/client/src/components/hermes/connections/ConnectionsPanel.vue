<script setup lang="ts">
import PageHeader from '@/components/layout/PageHeader.vue'
import { NEmpty } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import RemoteDevicesPanel from '@/components/hermes/connections/RemoteDevicesPanel.vue'
import { desktopBridge } from '@/utils/desktop-bridge'

const { t } = useI18n()
const hasRemoteDevices = desktopBridge()?.isDesktop === true && !!desktopBridge()?.remoteDevices
</script>

<template>
  <div class="connections-panel">
    <PageHeader>
      <header class="page-header">
        <h2 class="header-title">{{ t('remoteDevices.title') }}</h2>
      </header>
    </PageHeader>
    <RemoteDevicesPanel v-if="hasRemoteDevices" />
    <NEmpty v-else :description="t('remoteDevices.desktopOnly')" />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.connections-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

.page-header {
  display: flex;
  align-items: center;
  min-height: 56px;
}
</style>
