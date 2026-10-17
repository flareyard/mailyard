ALTER TABLE `campaigns` ADD `template_version` integer;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `body_html` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `body_text` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `reply_to` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `preheader` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `ab` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `paused_reason` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `started_at` integer;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `finished_at` integer;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `updated_at` integer;