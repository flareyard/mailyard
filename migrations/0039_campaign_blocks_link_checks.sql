CREATE TABLE `link_checks` (
	`url` text PRIMARY KEY NOT NULL,
	`status` integer,
	`error` text,
	`redirects_to` text,
	`checked_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `campaigns` ADD `body_blocks` text;