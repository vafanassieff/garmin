CREATE TABLE `activities` (
	`id` integer PRIMARY KEY,
	`name` text,
	`sport` text NOT NULL,
	`fit_sport` text,
	`fit_sub_sport` text,
	`start_time` text NOT NULL,
	`start_local` text NOT NULL,
	`day` text NOT NULL,
	`elapsed_s` real,
	`moving_s` real,
	`distance_m` real,
	`ascent_m` real,
	`descent_m` real,
	`avg_hr` integer,
	`max_hr` integer,
	`avg_speed` real,
	`max_speed` real,
	`avg_cadence` real,
	`max_cadence` real,
	`avg_power` integer,
	`max_power` integer,
	`norm_power` integer,
	`calories` integer,
	`training_load` real,
	`aerobic_te` real,
	`anaerobic_te` real,
	`te_label` text,
	`vo2max` real,
	`rpe` real,
	`feel` integer,
	`hr_z1_s` real,
	`hr_z2_s` real,
	`hr_z3_s` real,
	`hr_z4_s` real,
	`hr_z5_s` real,
	`hr_zone_bounds` text,
	`workout_name` text,
	`gear` text,
	`device` text,
	`start_lat` real,
	`start_lon` real,
	`polyline` text,
	`fit_file` text,
	`summary_file` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `body` (
	`time` text PRIMARY KEY,
	`day` text NOT NULL,
	`weight_kg` real,
	`bmi` real,
	`body_fat_pct` real,
	`body_water_pct` real,
	`muscle_mass_kg` real,
	`bone_mass_kg` real,
	`visceral_fat` real,
	`source` text
);
--> statement-breakpoint
CREATE TABLE `daily` (
	`day` text PRIMARY KEY,
	`sleep_start` text,
	`sleep_end` text,
	`sleep_s` integer,
	`deep_s` integer,
	`light_s` integer,
	`rem_s` integer,
	`awake_s` integer,
	`nap_s` integer,
	`sleep_score` integer,
	`hrv` real,
	`hrv_weekly` real,
	`hrv_status` text,
	`hrv_baseline_low` real,
	`hrv_baseline_high` real,
	`resting_hr` integer,
	`min_hr` integer,
	`max_hr` integer,
	`body_battery_high` integer,
	`body_battery_low` integer,
	`body_battery_wake` integer,
	`body_battery_charged` integer,
	`body_battery_drained` integer,
	`steps` integer,
	`distance_m` real,
	`active_kcal` integer,
	`total_kcal` integer,
	`stress_avg` integer,
	`stress_max` integer,
	`intensity_moderate_min` integer,
	`intensity_vigorous_min` integer,
	`respiration_avg` real,
	`spo2_avg` real,
	`readiness` integer,
	`readiness_level` text,
	`readiness_feedback` text,
	`recovery_time_h` integer,
	`acute_load` real,
	`chronic_load` real,
	`training_status` text,
	`vo2max` real,
	`vo2max_cycling` real,
	`race_5k_s` integer,
	`race_10k_s` integer,
	`race_half_s` integer,
	`race_marathon_s` integer,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `laps` (
	`activity_id` integer NOT NULL,
	`idx` integer NOT NULL,
	`start_time` text NOT NULL,
	`elapsed_s` real,
	`moving_s` real,
	`distance_m` real,
	`avg_hr` integer,
	`max_hr` integer,
	`avg_speed` real,
	`max_speed` real,
	`avg_cadence` real,
	`avg_power` integer,
	`ascent_m` real,
	`descent_m` real,
	`intensity` text,
	`trigger` text,
	`workout_step` integer,
	CONSTRAINT `laps_pk` PRIMARY KEY(`activity_id`, `idx`),
	CONSTRAINT `fk_laps_activity_id_activities_id_fk` FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `planned_workouts` (
	`id` integer PRIMARY KEY,
	`day` text NOT NULL,
	`workout_id` integer,
	`name` text NOT NULL,
	`sport` text,
	`description` text,
	`estimated_duration_s` integer,
	`estimated_distance_m` real,
	`steps` text
);
--> statement-breakpoint
CREATE TABLE `raw_files` (
	`path` text PRIMARY KEY,
	`size` integer NOT NULL,
	`mtime_ms` integer NOT NULL,
	`ingested_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `samples` (
	`activity_id` integer NOT NULL,
	`t` integer NOT NULL,
	`lat` real,
	`lon` real,
	`alt` real,
	`hr` integer,
	`speed` real,
	`cadence` real,
	`power` integer,
	`distance` real,
	CONSTRAINT `samples_pk` PRIMARY KEY(`activity_id`, `t`),
	CONSTRAINT `fk_samples_activity_id_activities_id_fk` FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON DELETE CASCADE
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX `activities_day` ON `activities` (`day`);--> statement-breakpoint
CREATE INDEX `activities_sport` ON `activities` (`sport`);--> statement-breakpoint
CREATE INDEX `body_day` ON `body` (`day`);--> statement-breakpoint
CREATE INDEX `planned_workouts_day` ON `planned_workouts` (`day`);--> statement-breakpoint
CREATE VIEW `activity_summary` AS 
  SELECT id, day, start_local, sport, name,
    round(distance_m / 1000, 2) AS distance_km,
    round(moving_s / 60, 1) AS moving_min,
    round(elapsed_s / 60, 1) AS elapsed_min,
    CASE WHEN avg_speed > 0 AND (sport LIKE '%running%' OR sport IN ('walking', 'hiking'))
      THEN printf('%d:%02d', CAST(round(1000 / avg_speed) AS INTEGER) / 60,
        CAST(round(1000 / avg_speed) AS INTEGER) % 60) END AS pace_min_km,
    round(avg_speed * 3.6, 1) AS speed_kmh,
    avg_hr, max_hr, round(ascent_m) AS ascent_m, round(avg_cadence) AS cadence,
    avg_power, round(training_load) AS training_load, aerobic_te, anaerobic_te, te_label,
    round(hr_z1_s / 60, 1) AS z1_min, round(hr_z2_s / 60, 1) AS z2_min,
    round(hr_z3_s / 60, 1) AS z3_min, round(hr_z4_s / 60, 1) AS z4_min,
    round(hr_z5_s / 60, 1) AS z5_min,
    rpe, workout_name, gear
  FROM activities
;--> statement-breakpoint
CREATE VIEW `weekly` AS 
  SELECT date(day, '-6 days', 'weekday 1') AS week, sport,
    count(*) AS activities,
    round(sum(distance_m) / 1000, 1) AS distance_km,
    round(sum(moving_s) / 3600, 2) AS moving_h,
    round(sum(ascent_m)) AS ascent_m,
    round(sum(training_load)) AS training_load,
    round(max(distance_m) / 1000, 1) AS longest_km,
    round(sum(coalesce(hr_z4_s, 0) + coalesce(hr_z5_s, 0)) / 60) AS z4_z5_min
  FROM activities
  GROUP BY 1, 2
;