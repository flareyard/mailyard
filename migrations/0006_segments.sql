ALTER TABLE `messages_out` ADD `first_opened_at` integer;--> statement-breakpoint
ALTER TABLE `messages_out` ADD `first_clicked_at` integer;--> statement-breakpoint
ALTER TABLE `segments` ADD `compiled_params` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `segments` ADD `updated_at` integer;