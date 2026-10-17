CREATE TABLE `auto_replies` (
	`mailbox_id` text NOT NULL,
	`address` text NOT NULL,
	`source` text NOT NULL,
	`sent_at` integer NOT NULL,
	PRIMARY KEY(`mailbox_id`, `address`, `source`),
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mailbox_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`match` text DEFAULT 'all' NOT NULL,
	`conditions` text NOT NULL,
	`actions` text NOT NULL,
	`stop` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mailbox_rules_order` ON `mailbox_rules` (`mailbox_id`,`position`);--> statement-breakpoint
CREATE TABLE `mailbox_senders` (
	`mailbox_id` text NOT NULL,
	`value` text NOT NULL,
	`list` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`mailbox_id`, `value`),
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
