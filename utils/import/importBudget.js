export const MAX_BATCH_PROPERTIES = 5;
export const MAX_BATCH_PHOTOS = 100;
export const MAX_BATCH_MS = 120000;

export function createImportBudget({ now = Date.now, timeoutMs = MAX_BATCH_MS } = {}) {
  const deadline = now() + Math.min(timeoutMs, MAX_BATCH_MS);
  const controller = new AbortController();
  const error = () => Object.assign(new Error("Tiempo máximo de importación alcanzado (120 segundos)."), { code: "IMPORT_TIMEOUT", status: 504 });
  const timer = setTimeout(() => controller.abort(error()), Math.min(timeoutMs, MAX_BATCH_MS));
  timer.unref?.();
  const budget = {
    signal: controller.signal,
    remainingMs: () => Math.max(0, deadline - now()),
    assertActive() {
      if (controller.signal.aborted || now() >= deadline) {
        if (!controller.signal.aborted) controller.abort(error());
        throw controller.signal.reason;
      }
    },
    async run(action, { onLateResult } = {}) {
      budget.assertActive();
      return new Promise((resolve, reject) => {
        let finished = false;
        const abort = () => { finished = true; reject(controller.signal.reason); };
        controller.signal.addEventListener("abort", abort, { once: true });
        Promise.resolve().then(() => { budget.assertActive(); return action(); }).then(value => {
          controller.signal.removeEventListener("abort", abort);
          if (finished) { Promise.resolve(onLateResult?.(value)).catch(() => {}); return; }
          finished = true; resolve(value);
        }, err => { controller.signal.removeEventListener("abort", abort); if (!finished) { finished = true; reject(err); } });
      });
    },
    dispose: () => clearTimeout(timer)
  };
  return budget;
}
