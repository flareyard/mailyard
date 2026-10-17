ALTER TABLE `mailbox_imports` ADD `started_at` integer;--> statement-breakpoint
ALTER TABLE `mailbox_imports` ADD `paused_at` integer;--> statement-breakpoint
ALTER TABLE `mailbox_imports` ADD `paused_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `mailbox_imports` ADD `catchup_of` text;--> statement-breakpoint
ALTER TABLE `mailbox_imports` ADD `since` integer;--> statement-breakpoint
ALTER TABLE `mailbox_imports` ADD `retry_of` text;--> statement-breakpoint
ALTER TABLE `mailbox_imports` ADD `uids` text;