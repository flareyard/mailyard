CREATE TABLE `form_daily` (
	`form_id` text NOT NULL,
	`day` text NOT NULL,
	`submissions` integer DEFAULT 0 NOT NULL,
	`subscribed` integer DEFAULT 0 NOT NULL,
	`confirm` integer DEFAULT 0 NOT NULL,
	`refused` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`form_id`, `day`)
);
--> statement-breakpoint
ALTER TABLE `forms` ADD `field_defs` text;--> statement-breakpoint
ALTER TABLE `forms` ADD `topic_choice` text DEFAULT 'all' NOT NULL;