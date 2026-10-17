CREATE TABLE `mailbox_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`status` text NOT NULL,
	`format` text NOT NULL,
	`r2_key` text,
	`message_count` integer DEFAULT 0 NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `mailbox_exports_mailbox` ON `mailbox_exports` (`mailbox_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `mailbox_members` (
	`mailbox_id` text NOT NULL,
	`api_key_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`mailbox_id`, `api_key_id`),
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mailbox_members_key` ON `mailbox_members` (`api_key_id`);--> statement-breakpoint
ALTER TABLE `domains` ADD `checks` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `updated_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `mailboxes` ADD `signature` text;--> statement-breakpoint
ALTER TABLE `mailboxes` ADD `auto_reply` text;--> statement-breakpoint
ALTER TABLE `mailboxes` ADD `forwarding` text;--> statement-breakpoint
ALTER TABLE `mailboxes` ADD `updated_at` integer DEFAULT 0 NOT NULL;