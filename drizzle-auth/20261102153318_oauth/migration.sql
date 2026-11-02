CREATE TABLE `access_tokens` (
	`hash` text PRIMARY KEY,
	`grant_id` text NOT NULL,
	`expires_at` text NOT NULL,
	CONSTRAINT `fk_access_tokens_grant_id_grants_id_fk` FOREIGN KEY (`grant_id`) REFERENCES `grants`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `clients` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `grants` (
	`id` text PRIMARY KEY,
	`client_id` text NOT NULL,
	`scope` text NOT NULL,
	`resource` text NOT NULL,
	`created_at` text NOT NULL,
	`used_at` text NOT NULL,
	`refresh_hash` text NOT NULL UNIQUE,
	`refresh_expires_at` text NOT NULL,
	`refreshed_at` text NOT NULL,
	`previous_refresh_hash` text,
	CONSTRAINT `fk_grants_client_id_clients_id_fk` FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `access_tokens_grant` ON `access_tokens` (`grant_id`);--> statement-breakpoint
CREATE INDEX `grants_client` ON `grants` (`client_id`);--> statement-breakpoint
CREATE INDEX `grants_previous_refresh` ON `grants` (`previous_refresh_hash`);