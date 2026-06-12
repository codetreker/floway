import { initBackgroundSchedulerResolver } from './src/runtime/background.ts';
import { initEnv } from '@floway-dev/platform';

// Production always initializes env at boot, so getEnv() never throws in a
// live request. Mirror that here with a neutral default; tests needing real
// values (RUNTIME_LOCATION, ADMIN_KEY, …) re-init with their own getter.
initEnv(() => '');

initBackgroundSchedulerResolver(_c => promise => {
  promise.catch(err => console.error('[background]', err));
});
