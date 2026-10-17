CREATE TABLE `exports` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`filter` text NOT NULL,
	`fields` text NOT NULL,
	`key` text NOT NULL,
	`filename` text NOT NULL,
	`rows` integer DEFAULT 0 NOT NULL,
	`upload_id` text,
	`parts` text DEFAULT '[]' NOT NULL,
	`after` text,
	`error` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `exports_created` ON `exports` (`created_at`);