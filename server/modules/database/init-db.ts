import { getConnection } from "@/modules/database/connection.js";
import { runMigrations } from "@/modules/database/migrations.js";
import { INIT_SCHEMA_SQL } from "@/modules/database/schema.js";
import { debug } from "@/shared/debug.js";

// Initialize database with schema
export const initializeDatabase = async () => {
    try {
        debug('init-db: calling getConnection()');
        const db = getConnection();
        debug('init-db: applying schema');
        db.exec(INIT_SCHEMA_SQL);
        console.log('Database schema applied');
        debug('init-db: running migrations');
        runMigrations(db);
        debug('init-db: complete');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log('Database initialization failed', { error: message });
        throw err;
    }
};
