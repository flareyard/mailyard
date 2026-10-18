-- DMARC aggregate reports (HAL-3375): reports, a per-day per-IP rollup, and the sending sources. Additive.
CREATE TABLE `dmarc_daily` (
	`domain_id` text NOT NULL,
	`day` text NOT NULL,
	`source_ip` text NOT NULL,
	`messages` integer NOT NULL,
	`dkim_aligned` integer NOT NULL,
	`spf_aligned` integer NOT NULL,
	`dmarc_pass` integer NOT NULL,
	`quarantined` integer NOT NULL,
	`rejected` integer NOT NULL,
	`dkim_domains` text NOT NULL,
	`spf_domains` text NOT NULL,
	`overrides` text NOT NULL,
	PRIMARY KEY(`domain_id`, `day`, `source_ip`),
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `dmarc_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`domain_id` text NOT NULL,
	`org_name` text NOT NULL,
	`email` text,
	`report_id` text NOT NULL,
	`begin` integer NOT NULL,
	`end` integer NOT NULL,
	`policy` text NOT NULL,
	`records` integer NOT NULL,
	`messages` integer NOT NULL,
	`inbound_id` text,
	`received_at` integer NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dmarc_reports_unique` ON `dmarc_reports` (`domain_id`,`org_name`,`report_id`);--> statement-breakpoint
CREATE INDEX `dmarc_reports_domain` ON `dmarc_reports` (`domain_id`,`end`);--> statement-breakpoint
CREATE TABLE `dmarc_sources` (
	`domain_id` text NOT NULL,
	`ip` text NOT NULL,
	`ptr` text,
	`provider` text,
	`known` integer DEFAULT false NOT NULL,
	`label` text,
	`marked_by` text,
	`marked_at` integer,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL,
	PRIMARY KEY(`domain_id`, `ip`),
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
