CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`removed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_key` ON `agents` (`key_id`);--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`key_id` text NOT NULL,
	`kind` text NOT NULL,
	`mailbox_id` text,
	`draft_id` text,
	`request` text NOT NULL,
	`recipients` text NOT NULL,
	`subject` text NOT NULL,
	`from` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` text,
	`reason` text,
	`result` text
);
--> statement-breakpoint
CREATE INDEX `approvals_status` ON `approvals` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `approvals_key` ON `approvals` (`key_id`,`status`);--> statement-breakpoint
CREATE TABLE `key_limits` (
	`key_id` text PRIMARY KEY NOT NULL,
	`sends_per_day` integer,
	`recipients` text DEFAULT 'any' NOT NULL,
	`allow_domains` text NOT NULL,
	`require_approval` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `key_send_daily` (
	`key_id` text NOT NULL,
	`day` text NOT NULL,
	`sends` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`key_id`, `day`)
);
