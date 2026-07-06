import { onScopeDispose, ref, watch, type Ref } from 'vue';

// Writes use `history.replaceState` so updating the selection does not push a
// history entry or trigger the browser's scroll-into-view-on-hash-change
// behavior.
export const useHashRef = (): Ref<string | null> => {
  const read = (): string | null => {
    const raw = window.location.hash;
    if (raw.length <= 1) return null;
    return decodeURIComponent(raw.slice(1));
  };

  const value = ref<string | null>(read());

  const onHashChange = () => {
    const next = read();
    if (next !== value.value) value.value = next;
  };
  window.addEventListener('hashchange', onHashChange);

  watch(value, next => {
    const encoded = next === null ? '' : `#${encodeURIComponent(next)}`;
    const url = `${window.location.pathname}${window.location.search}${encoded}`;
    if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== url) {
      window.history.replaceState(window.history.state, '', url);
    }
  });

  onScopeDispose(() => {
    window.removeEventListener('hashchange', onHashChange);
  });

  return value;
};
