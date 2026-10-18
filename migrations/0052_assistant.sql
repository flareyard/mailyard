-- The mailbox and audience helpers (HAL-3305): calls and tokens per day, and cached thread summaries. Additive.
CREATE TABLE `assistant_summaries` (
	`mailbox_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`version` text NOT NULL,
	`summary` text NOT NULL,
	`bullets` text NOT NULL,
	`model` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`mailbox_id`, `thread_id`)
);
--> statement-breakpoint
CREATE TABLE `assistant_usage` (
	`day` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`feature` text NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`milli_neurons` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `mailbox_id`, `feature`)
);
