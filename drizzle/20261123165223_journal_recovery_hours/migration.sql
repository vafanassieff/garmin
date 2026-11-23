CREATE TABLE `journal` (
	`time` text PRIMARY KEY,
	`day` text NOT NULL,
	`text` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `journal_day` ON `journal` (`day`);
--> statement-breakpoint
-- daily.recovery_time_h held Garmin's minutes: in hours, as the ingest now writes it
UPDATE `daily` SET `recovery_time_h` = round(`recovery_time_h` / 60.0) WHERE `recovery_time_h` IS NOT NULL;
