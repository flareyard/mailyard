ALTER TABLE `webhook_deliveries` ADD `request_id` text;--> statement-breakpoint
ALTER TABLE `webhook_endpoints` ADD `filter` text;--> statement-breakpoint
ALTER TABLE `webhook_endpoints` ADD `paused` integer DEFAULT false NOT NULL;