ALTER TABLE `automation_runs` ADD `waiting_event` text;--> statement-breakpoint
ALTER TABLE `automation_runs` ADD `seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `automations` ADD `origin` text;