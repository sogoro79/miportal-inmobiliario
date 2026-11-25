// Physical retention is independent of the authenticated five-minute expiresAt.
// 5 minutes freshness + 30 minutes retention = 35 minutes from capture,
// leaving 5 minutes beyond the logical 30-minute NEW review window.
export const PROVIDER_SNAPSHOT_COLLECTION = "providerSnapshots";
export const PROVIDER_SNAPSHOT_TTL_INDEX = "expiresAt_1";
export const PROVIDER_SNAPSHOT_TTL_SECONDS = 1800;
