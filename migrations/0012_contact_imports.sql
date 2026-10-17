CREATE TABLE `contact_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`upload_id` text NOT NULL,
	`mapping` text NOT NULL,
	`topic_ids` text NOT NULL,
	`on_conflict` text NOT NULL,
	`default_status` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`headers` text,
	`offset` integer DEFAULT 0 NOT NULL,
	`line` integer DEFAULT 1 NOT NULL,
	`rows` integer DEFAULT 0 NOT NULL,
	`created` integer DEFAULT 0 NOT NULL,
	`updated` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`invalid` integer DEFAULT 0 NOT NULL,
	`duplicates` integer DEFAULT 0 NOT NULL,
	`suppressed` integer DEFAULT 0 NOT NULL,
	`errors` text DEFAULT '[]' NOT NULL,
	`error` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`upload_id`) REFERENCES `uploads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `contact_imports_created` ON `contact_imports` (`created_at`);--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `uploads_created` ON `uploads` (`created_at`);