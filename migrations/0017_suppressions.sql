CREATE TABLE `suppression_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`upload_id` text NOT NULL,
	`reason` text NOT NULL,
	`note` text,
	`email_column` text,
	`reason_column` text,
	`note_column` text,
	`push` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`headers` text,
	`offset` integer DEFAULT 0 NOT NULL,
	`line` integer DEFAULT 1 NOT NULL,
	`rows` integer DEFAULT 0 NOT NULL,
	`added` integer DEFAULT 0 NOT NULL,
	`existing` integer DEFAULT 0 NOT NULL,
	`invalid` integer DEFAULT 0 NOT NULL,
	`duplicates` integer DEFAULT 0 NOT NULL,
	`pushed` integer DEFAULT 0 NOT NULL,
	`errors` text DEFAULT '[]' NOT NULL,
	`error` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`upload_id`) REFERENCES `uploads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `suppression_imports_created` ON `suppression_imports` (`created_at`);--> statement-breakpoint
ALTER TABLE `suppressions` ADD `note` text;--> statement-breakpoint
ALTER TABLE `suppressions` ADD `message_id` text;--> statement-breakpoint
ALTER TABLE `suppressions` ADD `bulk_only` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `suppressions` ADD `contact_status_before` text;--> statement-breakpoint
ALTER TABLE `suppressions` ADD `cloudflare_id` text;--> statement-breakpoint
ALTER TABLE `suppressions` ADD `cloudflare_checked_at` integer;--> statement-breakpoint
ALTER TABLE `suppressions` ADD `updated_at` integer;--> statement-breakpoint
CREATE INDEX `suppressions_at` ON `suppressions` (`at`,`email`);--> statement-breakpoint
CREATE INDEX `suppressions_reason` ON `suppressions` (`reason`,`at`);