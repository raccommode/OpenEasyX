import { api } from "./api";

type RemoteOperationStatus = { running: boolean; progress: number; error?: string };
export type LiveOperationStatus = { running: boolean; percent: number };
export const idleOperation: LiveOperationStatus = { running: false, percent: 0 };

export function watchOperationStatus(endpoint: string, onStatus: (next: LiveOperationStatus) => void) {
  let running = false;
  let startedAt: number | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let completionTimer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;

  function update(next: LiveOperationStatus) {
    running = next.running;
    onStatus(next);
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    const delay = document.hidden ? 30_000 : running ? 400 : 5_000;
    pollTimer = setTimeout(poll, delay);
  }

  async function poll() {
    clearTimeout(pollTimer);
    request?.abort();
    const current = new AbortController();
    request = current;
    try {
      const remote = await api<RemoteOperationStatus>(endpoint, { signal: current.signal });
      if (current.signal.aborted) return;
      if (remote.running) {
        clearTimeout(completionTimer);
        completionTimer = undefined;
        startedAt = undefined;
        update({ running: true, percent: remote.progress });
      } else if (running && completionTimer === undefined) {
        // A local POST may still be starting when the first status request returns.
        if (startedAt !== undefined && Date.now() - startedAt < 650) return;
        if (remote.error) {
          update(idleOperation);
        } else {
          update({ running: true, percent: 100 });
          completionTimer = setTimeout(() => {
            completionTimer = undefined;
            update(idleOperation);
          }, 550);
        }
      }
    } catch { /* The action reports API errors to the page. */ }
    finally {
      if (!current.signal.aborted) {
        request = undefined;
        schedulePoll();
      }
    }
  }

  function visibilityChanged() {
    if (document.hidden) schedulePoll();
    else void poll();
  }

  document.addEventListener("visibilitychange", visibilityChanged);
  void poll();
  return {
    begin() {
      clearTimeout(completionTimer);
      completionTimer = undefined;
      startedAt = Date.now();
      update({ running: true, percent: 0 });
      void poll();
    },
    dispose() {
      request?.abort();
      clearTimeout(pollTimer);
      clearTimeout(completionTimer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    },
  };
}
