import { initBackgroundSchedulerResolver } from './src/runtime/background.ts';

initBackgroundSchedulerResolver(_c => promise => {
  promise.catch(err => console.error('[background]', err));
});
