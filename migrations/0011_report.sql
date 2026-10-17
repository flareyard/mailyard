CREATE TABLE `campaign_links` (
	`campaign_id` text NOT NULL,
	`url` text NOT NULL,
	`clicks` integer DEFAULT 0 NOT NULL,
	`machine_clicks` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`campaign_id`, `url`)
);
--> statement-breakpoint
ALTER TABLE `inbound_messages` ADD `in_reply_to` text;