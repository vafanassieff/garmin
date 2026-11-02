CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`started_at` text NOT NULL,
	`finished_at` text,
	`ok` integer,
	`logged_out` integer DEFAULT false NOT NULL,
	`account` text,
	`since` text,
	`files_written` integer,
	`warnings` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `sync_runs_started` ON `sync_runs` (`started_at`);