CREATE TABLE `contact_bulk_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`filter` text NOT NULL,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`total` integer NOT NULL,
	`processed` integer DEFAULT 0 NOT NULL,
	`updated` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`errors` text NOT NULL,
	`cursor` text,
	`error` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer
);
