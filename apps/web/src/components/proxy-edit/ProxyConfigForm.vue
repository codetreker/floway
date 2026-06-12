<script setup lang="ts">
import { computed } from 'vue';

import {
  FORM_KIND_LABELS,
  defaultsFor,
  isValidPort,
  isValidUuid,
  type FormKind,
} from './proxy-form-defaults.ts';
import SecretInput from '../shared/SecretInput.vue';
import type {
  HttpProxyConfig,
  ProxyConfig,
  RealityProxyConfig,
  Shadowsocks2022ProxyConfig,
  ShadowsocksProxyConfig,
  Socks5ProxyConfig,
  Ss2022Method,
  SsMethod,
  TrojanProxyConfig,
  VlessTcpTlsProxyConfig,
  VlessWsTlsProxyConfig,
} from '@floway-dev/proxy/proxy-config';
import { Input, Select, Switch } from '@floway-dev/ui';

const config = defineModel<ProxyConfig>({ required: true });

defineProps<{
  /** Parent-level URL parse error: dim the form while typing in the URL produces invalid output. */
  urlError: string | null;
}>();

const KIND_OPTIONS: { value: FormKind; label: string }[] = (
  Object.keys(FORM_KIND_LABELS) as FormKind[]
).map(value => ({ value, label: FORM_KIND_LABELS[value] }));

const SS_METHOD_OPTIONS: { value: SsMethod; label: string }[] = [
  { value: 'aes-128-gcm', label: 'aes-128-gcm' },
  { value: 'aes-256-gcm', label: 'aes-256-gcm' },
  { value: 'chacha20-ietf-poly1305', label: 'chacha20-ietf-poly1305' },
];

const SS2022_METHOD_OPTIONS: { value: Ss2022Method; label: string }[] = [
  { value: '2022-blake3-aes-128-gcm', label: '2022-blake3-aes-128-gcm' },
  { value: '2022-blake3-aes-256-gcm', label: '2022-blake3-aes-256-gcm' },
  { value: '2022-blake3-chacha20-poly1305', label: '2022-blake3-chacha20-poly1305' },
];

const formKind = computed<FormKind>(() => {
  const c = config.value;
  return c.kind === 'http' ? (c.tls ? 'https' : 'http') : c.kind;
});

const portString = computed<string>({
  get: () => String(config.value.port),
  set: raw => {
    const trimmed = raw.trim();
    const n = trimmed === '' ? 0 : Number(trimmed);
    config.value = { ...config.value, port: Number.isFinite(n) ? n : 0 } as ProxyConfig;
  },
});

const onKindChange = (next: FormKind | undefined) => {
  if (next === undefined) return;
  const current = config.value;
  config.value = defaultsFor(next, { host: current.host, port: current.port, name: current.name });
};

const setHost = (host: string) => {
  config.value = { ...config.value, host } as ProxyConfig;
};

// One typed setter per variant keeps the per-kind sub-blocks free of
// repeated `as` casts and stops a stray field from leaking across kinds
// when the editor mass-updates a slice.
const updateHttp = (patch: Partial<HttpProxyConfig>) => {
  if (config.value.kind !== 'http') return;
  config.value = { ...config.value, ...patch };
};
const updateSocks5 = (patch: Partial<Socks5ProxyConfig>) => {
  if (config.value.kind !== 'socks5') return;
  config.value = { ...config.value, ...patch };
};
const updateSs = (patch: Partial<ShadowsocksProxyConfig>) => {
  if (config.value.kind !== 'ss') return;
  config.value = { ...config.value, ...patch };
};
const updateSs2022 = (patch: Partial<Shadowsocks2022ProxyConfig>) => {
  if (config.value.kind !== 'ss2022') return;
  config.value = { ...config.value, ...patch };
};
const updateTrojan = (patch: Partial<TrojanProxyConfig>) => {
  if (config.value.kind !== 'trojan') return;
  config.value = { ...config.value, ...patch };
};
const updateVlessTcp = (patch: Partial<VlessTcpTlsProxyConfig>) => {
  if (config.value.kind !== 'vless-tcp') return;
  config.value = { ...config.value, ...patch };
};
const updateVlessWs = (patch: Partial<VlessWsTlsProxyConfig>) => {
  if (config.value.kind !== 'vless-ws') return;
  config.value = { ...config.value, ...patch };
};
const updateReality = (patch: Partial<RealityProxyConfig>) => {
  if (config.value.kind !== 'reality') return;
  config.value = { ...config.value, ...patch };
};

const portInvalid = computed(() => !isValidPort(config.value.port));
const hostInvalid = computed(() => config.value.host.trim() === '');

const orUndef = (v: string): string | undefined => v === '' ? undefined : v;

const uuidInvalid = computed(() => {
  const c = config.value;
  if (c.kind !== 'vless-tcp' && c.kind !== 'vless-ws' && c.kind !== 'reality') return false;
  return !isValidUuid(c.uuid);
});

const trojan = computed<TrojanProxyConfig | null>(() =>
  config.value.kind === 'trojan' ? config.value : null);
const http = computed<HttpProxyConfig | null>(() =>
  config.value.kind === 'http' ? config.value : null);
const socks5 = computed<Socks5ProxyConfig | null>(() =>
  config.value.kind === 'socks5' ? config.value : null);
const ss = computed<ShadowsocksProxyConfig | null>(() =>
  config.value.kind === 'ss' ? config.value : null);
const ss2022 = computed<Shadowsocks2022ProxyConfig | null>(() =>
  config.value.kind === 'ss2022' ? config.value : null);
const vlessTcp = computed<VlessTcpTlsProxyConfig | null>(() =>
  config.value.kind === 'vless-tcp' ? config.value : null);
const vlessWs = computed<VlessWsTlsProxyConfig | null>(() =>
  config.value.kind === 'vless-ws' ? config.value : null);
const reality = computed<RealityProxyConfig | null>(() =>
  config.value.kind === 'reality' ? config.value : null);
</script>

<template>
  <div
    class="space-y-4"
    :class="urlError && 'opacity-60'"
  >
    <p v-if="urlError" class="rounded-md border border-accent-amber/30 bg-accent-amber/10 px-2 py-1 text-xs text-accent-amber">
      Form mirrors the last successful parse — fix the URL above to keep them in sync.
    </p>

    <div class="space-y-1.5">
      <label class="block text-xs font-medium text-gray-500">Protocol</label>
      <Select :model-value="formKind" :options="KIND_OPTIONS" @update:model-value="onKindChange" />
    </div>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_8rem]">
      <div class="space-y-1.5">
        <label class="block text-xs font-medium text-gray-500">Host</label>
        <Input
          :model-value="config.host"
          :invalid="hostInvalid"
          placeholder="server.example.com"
          class="font-mono"
          @update:model-value="setHost"
        />
      </div>
      <div class="space-y-1.5">
        <label class="block text-xs font-medium text-gray-500">Port</label>
        <Input
          v-model="portString"
          :invalid="portInvalid"
          inputmode="numeric"
          class="font-mono"
        />
      </div>
    </div>

    <template v-if="http">
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div class="space-y-1.5">
          <label class="block text-xs font-medium text-gray-500">Username <span class="text-gray-600">(optional)</span></label>
          <Input
            :model-value="http.username ?? ''"
            @update:model-value="v => updateHttp({ username: orUndef(v) })"
          />
        </div>
        <div class="space-y-1.5">
          <label class="block text-xs font-medium text-gray-500">Password <span class="text-gray-600">(optional)</span></label>
          <SecretInput
            :model-value="http.password ?? ''"
            @update:model-value="v => updateHttp({ password: orUndef(v) })"
          />
        </div>
      </div>
    </template>

    <template v-if="socks5">
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div class="space-y-1.5">
          <label class="block text-xs font-medium text-gray-500">Username <span class="text-gray-600">(optional)</span></label>
          <Input
            :model-value="socks5.username ?? ''"
            @update:model-value="v => updateSocks5({ username: orUndef(v) })"
          />
        </div>
        <div class="space-y-1.5">
          <label class="block text-xs font-medium text-gray-500">Password <span class="text-gray-600">(optional)</span></label>
          <SecretInput
            :model-value="socks5.password ?? ''"
            @update:model-value="v => updateSocks5({ password: orUndef(v) })"
          />
        </div>
      </div>
    </template>

    <template v-if="ss">
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div class="space-y-1.5">
          <label class="block text-xs font-medium text-gray-500">Method</label>
          <Select
            :model-value="ss.method"
            :options="SS_METHOD_OPTIONS"
            @update:model-value="v => updateSs({ method: v })"
          />
        </div>
        <div class="space-y-1.5">
          <label class="block text-xs font-medium text-gray-500">Password</label>
          <SecretInput
            :model-value="ss.password"
            :invalid="ss.password === ''"
            @update:model-value="v => updateSs({ password: v })"
          />
        </div>
      </div>
    </template>

    <template v-if="ss2022">
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div class="space-y-1.5">
          <label class="block text-xs font-medium text-gray-500">Method</label>
          <Select
            :model-value="ss2022.method"
            :options="SS2022_METHOD_OPTIONS"
            @update:model-value="v => updateSs2022({ method: v })"
          />
        </div>
        <div class="space-y-1.5">
          <label class="block text-xs font-medium text-gray-500">PSK <span class="text-gray-600">(base64)</span></label>
          <SecretInput
            :model-value="ss2022.passwordBase64"
            :invalid="ss2022.passwordBase64 === ''"
            class="font-mono"
            @update:model-value="v => updateSs2022({ passwordBase64: v })"
          />
        </div>
      </div>
    </template>

    <template v-if="trojan">
      <div class="space-y-1.5">
        <label class="block text-xs font-medium text-gray-500">Password</label>
        <SecretInput
          :model-value="trojan.password"
          :invalid="trojan.password === ''"
          @update:model-value="v => updateTrojan({ password: v })"
        />
      </div>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div class="space-y-1.5">
          <label class="block text-xs font-medium text-gray-500">SNI <span class="text-gray-600">(optional override)</span></label>
          <Input
            :model-value="trojan.sni ?? ''"
            placeholder="defaults to host"
            class="font-mono"
            @update:model-value="v => updateTrojan({ sni: orUndef(v) })"
          />
        </div>
        <div class="space-y-1.5">
          <label class="block text-xs font-medium text-gray-500">Allow insecure</label>
          <div class="flex h-9 items-center">
            <Switch
              :model-value="trojan.allowInsecure ?? false"
              @update:model-value="v => updateTrojan({ allowInsecure: v ? true : undefined })"
            />
            <span class="ml-2 text-xs text-gray-500">Skip cert verification</span>
          </div>
        </div>
      </div>
    </template>

    <template v-if="vlessTcp">
      <div class="space-y-1.5">
        <label class="block text-xs font-medium text-gray-500">UUID</label>
        <Input
          :model-value="vlessTcp.uuid"
          :invalid="uuidInvalid"
          placeholder="00000000-0000-0000-0000-000000000000"
          class="font-mono"
          @update:model-value="v => updateVlessTcp({ uuid: v })"
        />
      </div>
    </template>

    <template v-if="vlessWs">
      <div class="space-y-1.5">
        <label class="block text-xs font-medium text-gray-500">UUID</label>
        <Input
          :model-value="vlessWs.uuid"
          :invalid="uuidInvalid"
          placeholder="00000000-0000-0000-0000-000000000000"
          class="font-mono"
          @update:model-value="v => updateVlessWs({ uuid: v })"
        />
      </div>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div class="space-y-1.5">
          <label class="block text-xs font-medium text-gray-500">WebSocket path</label>
          <Input
            :model-value="vlessWs.path"
            :invalid="vlessWs.path === ''"
            placeholder="/"
            class="font-mono"
            @update:model-value="v => updateVlessWs({ path: v })"
          />
        </div>
        <div class="space-y-1.5">
          <label class="block text-xs font-medium text-gray-500">WebSocket Host header <span class="text-gray-600">(optional)</span></label>
          <Input
            :model-value="vlessWs.wsHost ?? ''"
            placeholder="defaults to host"
            class="font-mono"
            @update:model-value="v => updateVlessWs({ wsHost: orUndef(v) })"
          />
        </div>
      </div>
    </template>

    <template v-if="reality">
      <div class="space-y-1.5">
        <label class="block text-xs font-medium text-gray-500">UUID</label>
        <Input
          :model-value="reality.uuid"
          :invalid="uuidInvalid"
          placeholder="00000000-0000-0000-0000-000000000000"
          class="font-mono"
          @update:model-value="v => updateReality({ uuid: v })"
        />
      </div>
      <div class="space-y-1.5">
        <label class="block text-xs font-medium text-gray-500">Server name (SNI)</label>
        <Input
          :model-value="reality.serverName"
          :invalid="reality.serverName === ''"
          placeholder="real.example.com"
          class="font-mono"
          @update:model-value="v => updateReality({ serverName: v })"
        />
      </div>
      <div class="space-y-1.5">
        <label class="block text-xs font-medium text-gray-500">Public key</label>
        <Input
          :model-value="reality.publicKey"
          :invalid="reality.publicKey === ''"
          placeholder="x25519 public key (base64url)"
          class="font-mono"
          @update:model-value="v => updateReality({ publicKey: v })"
        />
      </div>
      <div class="space-y-1.5">
        <label class="block text-xs font-medium text-gray-500">Short ID <span class="text-gray-600">(optional)</span></label>
        <Input
          :model-value="reality.shortId ?? ''"
          placeholder="hex, up to 16 chars"
          class="font-mono"
          @update:model-value="v => updateReality({ shortId: orUndef(v) })"
        />
      </div>
    </template>
  </div>
</template>
