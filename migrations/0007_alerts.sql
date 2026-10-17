CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`detail` text NOT NULL,
	`subject` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`resolved_at` integer,
	`resolved_by` text
);
--> statement-breakpoint
CREATE INDEX `alerts_open` ON `alerts` (`resolved_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `alerts_key` ON `alerts` (`key`,`resolved_at`);