import { Pool } from "pg";
import * as schema from "./schema/index.js";
export declare const pool: Pool;
export declare const db: import("drizzle-orm/node-postgres").NodePgDatabase<typeof schema> & {
    $client: Pool;
};
export * from "./schema/index.js";
export { PostgresEvidenceStore } from "./secretariat/postgres-store.js";
export { PostgresExecutionStore } from "./secretariat/postgres-execution-store.js";
export { createSharedStores } from "./secretariat/factory.js";
export type { SharedStores } from "./secretariat/factory.js";
//# sourceMappingURL=index.d.ts.map