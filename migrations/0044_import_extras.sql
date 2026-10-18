ALTER TABLE `contact_imports` ADD `started_at` integer;--> statement-breakpoint
ALTER TABLE `contact_imports` ADD `errors_total` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `contact_imports` ADD `consent_statement` text;--> statement-breakpoint
ALTER TABLE `contact_imports` ADD `attested_by` text;--> statement-breakpoint
ALTER TABLE `contact_imports` ADD `attested_at` integer;--> statement-breakpoint
ALTER TABLE `exports` ADD `total` integer;--> statement-breakpoint
ALTER TABLE `subscription_changes` ADD `evidence` text;