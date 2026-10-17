CREATE TABLE `forms` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`topic_ids` text NOT NULL,
	`fields` text DEFAULT '[]' NOT NULL,
	`redirect_url` text,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subscription_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text NOT NULL,
	`topic_id` text NOT NULL,
	`from` text,
	`to` text NOT NULL,
	`source` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `subscription_changes_contact` ON `subscription_changes` (`contact_id`,`at`);--> statement-breakpoint
ALTER TABLE `contacts` ADD `last_event_at` integer;--> statement-breakpoint
ALTER TABLE `contacts` ADD `last_opened_at` integer;--> statement-breakpoint
ALTER TABLE `contacts` ADD `last_clicked_at` integer;--> statement-breakpoint
CREATE INDEX `contacts_created` ON `contacts` (`created_at`);--> statement-breakpoint
CREATE INDEX `contacts_activity` ON `contacts` (`last_activity_at`);--> statement-breakpoint
ALTER TABLE `topics` ADD `sender` text;