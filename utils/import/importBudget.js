export const MAX_BATCH_PROPERTIES = 10;
export const PHOTO_CHUNK_SIZE = 100;
export const MAX_BATCH_MS = 600_000;
export const MAX_PROPERTY_MS = 180_000;
const DEFAULT_OPERATION_MS = 120_000;

export function createBatchBudget(options) {
  return createImportBudget({ timeoutMs: MAX_BATCH_MS, ...options });
}

export function createImportBudget({ now = Date.now, timeoutMs = DEFAULT_OPERATION_MS, parent } = {}) {
  const duration = Math.min(timeoutMs, MAX_BATCH_MS, parent?.remainingMs() ?? Infinity);
  const deadline = now() + duration;
  const controller = new AbortController();
  const error = () => Object.assign(
    new Error(parent ? "Tiempo máximo del inmueble alcanzado." : "Tiempo máximo de la operación alcanzado."),
    { code: "IMPORT_TIMEOUT", status: 504, propertyTimeout: Boolean(parent) }
  );
  function expire() {
    try { parent?.assertActive(); }
    catch (cause) { controller.abort(cause); return; }
    controller.abort(error());
  }
  const timer = setTimeout(expire, duration);
  timer.unref?.();
  const budget = {
    signal: controller.signal,
    forProperty: () => createImportBudget({ now, parent: budget, timeoutMs: MAX_PROPERTY_MS }),
    remainingMs: () => Math.max(0, deadline - now()),
    assertActive() {
      parent?.assertActive();
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
