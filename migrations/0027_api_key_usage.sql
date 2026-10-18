CREATE TABLE `api_key_usage` (
	`key_id` text NOT NULL,
	`hour` integer NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`key_id`, `hour`)
);
--> statement-breakpoint
CREATE INDEX `api_key_usage_hour` ON `api_key_usage` (`hour`);