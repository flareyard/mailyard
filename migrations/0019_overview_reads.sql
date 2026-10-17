CREATE TABLE `audience_daily` (
	`day` text PRIMARY KEY NOT NULL,
	`total` integer NOT NULL,
	`subscribed` integer NOT NULL,
	`unconfirmed` integer NOT NULL,
	`unsubscribed` integer NOT NULL,
	`bounced` integer NOT NULL,
	`complained` integer NOT NULL,
	`suppressed` integer NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `inbound_daily` (
	`day` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`received` integer DEFAULT 0 NOT NULL,
	`spam` integer DEFAULT 0 NOT NULL,
	`rejected` integer DEFAULT 0 NOT NULL,
	`held` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `mailbox_id`)
);
--> statement-breakpoint
CREATE TABLE `inbound_daily_senders` (
	`day` text NOT NULL,
	`address` text NOT NULL,
	`received` integer NOT NULL,
	PRIMARY KEY(`day`, `address`)
);
--> statement-breakpoint
CREATE TABLE `inbound_deliveries` (
	`inbound_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`folder` text,
	`at` integer NOT NULL,
	PRIMARY KEY(`inbound_id`, `mailbox_id`)
);
--> statement-breakpoint
CREATE INDEX `inbound_deliveries_at` ON `inbound_deliveries` (`at`);--> statement-breakpoint
CREATE INDEX `alerts_created` ON `alerts` (`created_at`);--> statement-breakpoint
INSERT OR IGNORE INTO `inbound_deliveries` (`inbound_id`, `mailbox_id`, `folder`, `at`) SELECT m.`id`, j.value, NULL, coalesce(m.`filed_at`, m.`received_at`) FROM `inbound_messages` m, json_each(m.`delivered_to`) j;
