CREATE TABLE `automation_run_steps` (
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`automation_id` text NOT NULL,
	`node_id` text NOT NULL,
	`outcome` text NOT NULL,
	`port` text,
	`detail` text NOT NULL,
	`message_id` text,
	`at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `seq`),
	FOREIGN KEY (`run_id`) REFERENCES `automation_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `automation_run_steps_node` ON `automation_run_steps` (`automation_id`,`node_id`);--> statement-breakpoint
CREATE TABLE `automation_sends` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text NOT NULL,
	`automation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `automation_sends_contact` ON `automation_sends` (`contact_id`,`at`);--> statement-breakpoint
CREATE TABLE `automation_versions` (
	`automation_id` text NOT NULL,
	`version` integer NOT NULL,
	`graph` text NOT NULL,
	`settings` text NOT NULL,
	`note` text,
	`published_by` text NOT NULL,
	`published_at` integer NOT NULL,
	PRIMARY KEY(`automation_id`, `version`),
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `automation_runs` ADD `next_at` integer;--> statement-breakpoint
ALTER TABLE `automation_runs` ADD `trigger_data` text;--> statement-breakpoint
ALTER TABLE `automation_runs` ADD `exited_by` text;--> statement-breakpoint
ALTER TABLE `automation_runs` ADD `finished_at` integer;--> statement-breakpoint
CREATE INDEX `automation_runs_started` ON `automation_runs` (`automation_id`,`started_at`);--> statement-breakpoint
ALTER TABLE `automations` ADD `settings` text;--> statement-breakpoint
ALTER TABLE `automations` ADD `published_version` integer;--> statement-breakpoint
ALTER TABLE `automations` ADD `trigger_key` text;--> statement-breakpoint
ALTER TABLE `automations` ADD `status` text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE `automations` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `automations` ADD `updated_by` text;--> statement-breakpoint
CREATE INDEX `automations_trigger` ON `automations` (`trigger_key`,`status`);