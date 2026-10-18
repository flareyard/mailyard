CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`key_id` text NOT NULL,
	`via` text NOT NULL,
	`admin_fingerprint` text,
	`user_agent` text,
	`ip` text,
	`location` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`absolute_expires_at` integer NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_key` ON `sessions` (`key_id`,`expires_at`);