/**
 * Route bootstrap for user migration v2.
 *
 * index.ts already mounts the mature userMigrationRouter at /api/user-migration.
 * Registering the v2 child here keeps legacy endpoints stable while adding the
 * new safe migration protocol at /api/user-migration/v2.
 */
import userMigrationRouter from "./user-migration";
import userMigrationV2Router from "./user-migration-v2";

userMigrationRouter.route("/v2", userMigrationV2Router);
