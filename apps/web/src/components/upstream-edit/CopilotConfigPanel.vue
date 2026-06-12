<script setup lang="ts">

import CopilotDeviceFlow from './CopilotDeviceFlow.vue';
import CopilotInfo from './CopilotInfo.vue';
import type { CopilotQuotaSnapshot, CopilotUpstreamConfig, UpstreamRecord } from '../../api/types.ts';

defineProps<{
  record: UpstreamRecord | null;
  initialQuota?: CopilotQuotaSnapshot | null;
  initialQuotaError?: string | null;
}>();

defineEmits<{ completed: [upstream: UpstreamRecord | undefined] }>();
</script>

<template>
  <CopilotInfo
    v-if="record"
    :upstream-id="record.id"
    :config="record.config as CopilotUpstreamConfig"
    :initial-quota="initialQuota"
    :initial-quota-error="initialQuotaError"
  />
  <CopilotDeviceFlow v-else @completed="u => $emit('completed', u)" />
</template>
