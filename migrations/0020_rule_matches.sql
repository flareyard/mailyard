ALTER TABLE `mailbox_rules` ADD `match_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `mailbox_rules` ADD `last_matched_at` integer;