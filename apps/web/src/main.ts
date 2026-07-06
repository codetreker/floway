import '@unocss/reset/tailwind.css';
import 'virtual:uno.css';
import 'nprogress/nprogress.css';
import './styles/index.css';

import { createPinia } from 'pinia';
import { DataLoaderPlugin } from 'unplugin-vue-router/data-loaders';
import { createApp } from 'vue';

import { callApi, useApi } from './api/client.ts';
import App from './App.vue';
import { router } from './router.ts';
import { type AuthUser, useAuthStore } from './stores/auth.ts';

const app = createApp(App);
app.use(createPinia());

// Hydrate user identity from /auth/me before mounting so router guards and
// per-page loaders see fresh server-side permission state on every boot —
// localStorage would otherwise outlive an admin's promote/demote until logout.
// authFetch already drops the token on 401; transient errors leave the token
// intact so the next reload can retry.
const auth = useAuthStore();
if (auth.authToken !== null) {
  const { data } = await callApi<{ user: AuthUser }>(() => useApi().auth.me.$get());
  if (data) auth.setUser(data.user);
}

app.use(DataLoaderPlugin, { router });
app.use(router);
app.mount('#app');
