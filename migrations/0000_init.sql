CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`prefix` text NOT NULL,
	`hash` text NOT NULL,
	`scopes` text NOT NULL,
	`created_by` text,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash` ON `api_keys` (`hash`);--> statement-breakpoint
CREATE TABLE `audit` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target` text,
	`before` text,
	`after` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_at` ON `audit` (`at`);--> statement-breakpoint
CREATE INDEX `audit_target` ON `audit` (`target`);--> statement-breakpoint
CREATE TABLE `automation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`automation_id` text NOT NULL,
	`version` integer NOT NULL,
	`contact_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`state` text NOT NULL,
	`current_step` text,
	`error` text,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `automation_runs_automation` ON `automation_runs` (`automation_id`,`state`);--> statement-breakpoint
CREATE INDEX `automation_runs_contact` ON `automation_runs` (`contact_id`);--> statement-breakpoint
CREATE TABLE `automations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`trigger` text NOT NULL,
	`graph` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`segment_id` text,
	`topic_id` text,
	`template_id` text,
	`from_address` text NOT NULL,
	`subject` text NOT NULL,
	`subject_b` text,
	`send_at` integer,
	`workflow_id` text,
	`audience_size` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`segment_id`) REFERENCES `segments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `campaigns_status` ON `campaigns` (`status`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`fields` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'unconfirmed' NOT NULL,
	`last_activity_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_email` ON `contacts` (`email`);--> statement-breakpoint
CREATE INDEX `contacts_status` ON `contacts` (`status`);--> statement-breakpoint
CREATE TABLE `daily_stats` (
	`day` text NOT NULL,
	`stream` text NOT NULL,
	`provider` text DEFAULT '' NOT NULL,
	`sent` integer DEFAULT 0 NOT NULL,
	`delivered` integer DEFAULT 0 NOT NULL,
	`deferred` integer DEFAULT 0 NOT NULL,
	`bounced_hard` integer DEFAULT 0 NOT NULL,
	`bounced_soft` integer DEFAULT 0 NOT NULL,
	`complained` integer DEFAULT 0 NOT NULL,
	`rejected` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `stream`, `provider`)
);
--> statement-breakpoint
CREATE TABLE `domains` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`zone_id` text,
	`sending_enabled` integer DEFAULT false NOT NULL,
	`routing_enabled` integer DEFAULT false NOT NULL,
	`catch_all` text DEFAULT 'bounce' NOT NULL,
	`last_checked_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domains_name` ON `domains` (`name`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text NOT NULL,
	`name` text NOT NULL,
	`data` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_contact` ON `events` (`contact_id`,`at`);--> statement-breakpoint
CREATE INDEX `events_name` ON `events` (`name`,`at`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`api_key_id` text NOT NULL,
	`key` text NOT NULL,
	`route` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` integer,
	`response` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`api_key_id`, `key`)
);
--> statement-breakpoint
CREATE INDEX `idempotency_keys_expires` ON `idempotency_keys` (`expires_at`);--> statement-breakpoint
CREATE TABLE `mailboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`domain_id` text NOT NULL,
	`address` text NOT NULL,
	`display_name` text,
	`kind` text NOT NULL,
	`targets` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailboxes_address` ON `mailboxes` (`address`);--> statement-breakpoint
CREATE INDEX `mailboxes_domain` ON `mailboxes` (`domain_id`);--> statement-breakpoint
CREATE TABLE `messages_out` (
	`id` text PRIMARY KEY NOT NULL,
	`stream` text NOT NULL,
	`cf_message_id` text,
	`idempotency_key` text,
	`api_key_id` text,
	`contact_id` text,
	`campaign_id` text,
	`automation_run_id` text,
	`template_id` text,
	`recipient` text NOT NULL,
	`sender` text NOT NULL,
	`subject` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`bounce_type` text,
	`provider` text,
	`smtp_response` text,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`rendered_key` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_out_idempotency` ON `messages_out` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_out_cf_message` ON `messages_out` (`cf_message_id`);--> statement-breakpoint
CREATE INDEX `messages_out_recipient` ON `messages_out` (`recipient`,`created_at`);--> statement-breakpoint
CREATE INDEX `messages_out_campaign` ON `messages_out` (`campaign_id`,`status`);--> statement-breakpoint
CREATE INDEX `messages_out_created` ON `messages_out` (`created_at`);--> statement-breakpoint
CREATE TABLE `processed_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `segments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`filter` text NOT NULL,
	`compiled_sql` text NOT NULL,
	`last_count` integer,
	`last_computed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`contact_id` text NOT NULL,
	`topic_id` text NOT NULL,
	`state` text NOT NULL,
	`source` text NOT NULL,
	`changed_at` integer NOT NULL,
	PRIMARY KEY(`contact_id`, `topic_id`),
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `subscriptions_topic` ON `subscriptions` (`topic_id`,`state`);--> statement-breakpoint
CREATE TABLE `suppressions` (
	`email` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`source` text NOT NULL,
	`synced_to_cloudflare` integer DEFAULT false NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`version` integer NOT NULL,
	`subject` text NOT NULL,
	`source` text NOT NULL,
	`variables` text,
	`published_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `templates_name_version` ON `templates` (`name`,`version`);--> statement-breakpoint
CREATE TABLE `topics` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`double_opt_in` integer DEFAULT true NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
