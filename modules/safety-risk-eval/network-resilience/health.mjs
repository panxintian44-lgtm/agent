// Read-only infrastructure probes. No session, business task or inference is created.
const CORE_HEALTH_URL = "https://personal-ai-fund-manager-core-agent.realchenchenluo.workers.dev/health";
const MAX_RESPONSE_BYTES = 32 * 1024;
const unavailableCore = () => ({ status: "UNAVAILABLE", model_configured: null, inference_probe: "NOT_RUN" });
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

function milliseconds(value) {
  const result = value instanceof Date || typeof value === "string" ? new Date(value).getTime() : value;
  if (!Number.isFinite(result)) throw new TypeError("The health clock must return a valid timestamp.");
  return result;
}

async function bounded(probe, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("HEALTH_PROBE_TIMEOUT"));
    }, timeoutMs);
  });
  try {
    // The deadline also bounds non-abortable mocks, DB reads and body readers.
    return await Promise.race([Promise.resolve().then(() => probe(controller.signal)), deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function cancelReader(reader) {
  // Cancellation must not extend the health request's deadline.
  try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* No remote exception is returned. */ }
}

async function readCoreHealth(response, signal) {
  if (!response || response.status !== 200 || response.redirected === true ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers?.get("content-type") || "") ||
      typeof response.body?.getReader !== "function") throw new Error("INVALID_CORE_HEALTH");
  const advertisedLength = response.headers.get("content-length");
  if (advertisedLength !== null && (!/^\d+$/.test(advertisedLength) || Number(advertisedLength) > MAX_RESPONSE_BYTES)) {
    throw new Error("INVALID_CORE_HEALTH_LENGTH");
  }
  const reader = response.body.getReader(), chunks = [];
  const onAbort = () => cancelReader(reader);
  signal.addEventListener("abort", onAbort, { once: true });
  let total = 0;
  try {
    if (signal.aborted) throw new Error("CORE_HEALTH_ABORTED");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("INVALID_CORE_HEALTH_BODY");
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error("CORE_HEALTH_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    cancelReader(reader);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!object(value) || value.status !== "ok" || value.service !== "core-agent" ||
      value.contract_version !== "investment-agent.v1") throw new Error("CORE_HEALTH_MISMATCH");
  return {
    status: "UP",
    model_configured: object(value.model) && typeof value.model.configured === "boolean" ? value.model.configured : null,
    inference_probe: "NOT_RUN"
  };
}

export function createHealthMonitor({ fetchImpl = fetch, timeoutMs = 4000, cacheTtlMs = 20000, now = Date.now } = {}) {
  if (typeof fetchImpl !== "function" || typeof now !== "function" ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      !Number.isFinite(cacheTtlMs) || cacheTtlMs < 0) throw new TypeError("Invalid health monitor options.");
  const bindings = new WeakMap();
  const noBinding = {};
  const clock = () => milliseconds(now());

  async function storageProbe(db) {
    if (db === null || db === undefined) return { status: "NOT_CONFIGURED" };
    try {
      return await bounded(async () => {
        if (typeof db.prepare !== "function") throw new Error("INVALID_STORAGE_BINDING");
        const statement = db.prepare("SELECT 1 AS ok");
        if (typeof statement?.first !== "function") throw new Error("INVALID_STORAGE_QUERY");
        const row = await statement.first();
        return { status: row?.ok === 1 ? "UP" : "UNAVAILABLE" };
      }, timeoutMs);
    } catch { return { status: "UNAVAILABLE" }; }
  }

  async function coreProbe() {
    try {
      return await bounded(async signal => readCoreHealth(await fetchImpl(CORE_HEALTH_URL, {
        method: "GET", redirect: "manual", signal,
        credentials: "omit", headers: { Accept: "application/json" }
      }), signal), timeoutMs);
    } catch { return unavailableCore(); }
  }

  async function collect(db) {
    const checkedAt = new Date(clock()).toISOString();
    const [storage, core] = await Promise.all([storageProbe(db), coreProbe()]);
    return {
      schema_version: "risk-service-health.v1",
      checked_at: checkedAt,
      // UP describes these probes, never model inference or business acceptance.
      overall: storage.status === "UP" && core.status === "UP" ? "UP" : "DEGRADED",
      services: { workbench: { status: "UP" }, storage, core },
      execution_allowed: false,
      business_acceptance: "NOT_VERIFIED"
    };
  }

  return async function inspect(env = {}) {
    const db = env?.DB;
    const key = db === null || db === undefined ? noBinding : object(db) || typeof db === "function" ? db : null;
    // Invalid primitive bindings do not retain arbitrary environment data.
    let entry = key ? bindings.get(key) : null;
    if (!entry) {
      entry = { result: null, expiresAt: 0, pending: null };
      if (key) bindings.set(key, entry);
    }
    const tick = clock();
    if (entry.result && tick < entry.expiresAt) return structuredClone(entry.result);
    if (!entry.pending) {
      entry.pending = collect(db).then(result => {
        entry.result = result;
        entry.expiresAt = clock() + cacheTtlMs;
        return result;
      }).finally(() => { entry.pending = null; });
    }
    return structuredClone(await entry.pending);
  };
}
