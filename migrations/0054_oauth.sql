CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`uri` text,
	`logo_uri` text,
	`redirect_uris` text NOT NULL,
	`fetched_at` integer,
	`created_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE INDEX `oauth_clients_unused` ON `oauth_clients` (`kind`,`last_used_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `oauth_codes` (
	`hash` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`principal` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`resource` text NOT NULL,
	`scopes` text NOT NULL,
	`mailbox_ids` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`grant_id` text
);
--> statement-breakpoint
CREATE INDEX `oauth_codes_expiry` ON `oauth_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `oauth_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`principal` text NOT NULL,
	`api_key_id` text NOT NULL,
	`resource` text NOT NULL,
	`scopes` text NOT NULL,
	`mailbox_ids` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`revoked_reason` text
);
--> statement-breakpoint
CREATE INDEX `oauth_grants_key` ON `oauth_grants` (`api_key_id`);--> statement-breakpoint
CREATE INDEX `oauth_grants_principal` ON `oauth_grants` (`principal`);--> statement-breakpoint
CREATE INDEX `oauth_grants_live` ON `oauth_grants` (`revoked_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`hash` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE INDEX `oauth_tokens_grant` ON `oauth_tokens` (`grant_id`);--> statement-breakpoint
CREATE INDEX `oauth_tokens_expiry` ON `oauth_tokens` (`expires_at`);--> statement-breakpoint
ALTER TABLE `sign_in_links` ADD `return_to` text;