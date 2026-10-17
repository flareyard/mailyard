CREATE TABLE `mailbox_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`source` text NOT NULL,
	`mode` text NOT NULL,
	`host` text,
	`port` integer,
	`username` text,
	`secret_ciphertext` text,
	`object_key` text,
	`folders` text,
	`progress` text,
	`status` text NOT NULL,
	`error` text,
	`workflow_id` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mailbox_imports_mailbox` ON `mailbox_imports` (`mailbox_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `mailbox_exports` ADD `zip_key` text;--> statement-breakpoint
ALTER TABLE `mailbox_exports` ADD `zip_size` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `mailbox_exports` ADD `state` text;