ALTER TABLE `campaigns` ADD `track_opens` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `track_clicks` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `messages_out` ADD `tracked` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `messages_out` ADD `opens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `messages_out` ADD `clicks` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `messages_out` ADD `machine_opens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `messages_out` ADD `machine_clicks` integer DEFAULT 0 NOT NULL;