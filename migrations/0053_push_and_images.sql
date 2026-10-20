-- Web Push subscriptions and preferences, and the always-show-images list (HAL-3369). Additive.
CREATE TABLE `mailbox_image_senders` (
	`mailbox_id` text NOT NULL,
	`value` text NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`mailbox_id`, `value`),
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `push_preferences` (
	`owner` text PRIMARY KEY NOT NULL,
	`mailboxes` text NOT NULL,
	`alerts` integer DEFAULT true NOT NULL,
	`hide_content` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`device` text,
	`created_at` integer NOT NULL,
	`last_sent_at` integer,
	`failures` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_owner` ON `push_subscriptions` (`owner`);