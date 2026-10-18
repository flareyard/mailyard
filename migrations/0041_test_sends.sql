CREATE TABLE `test_sends` (
	`id` text PRIMARY KEY NOT NULL,
	`from_address` text NOT NULL,
	`to_address` text NOT NULL,
	`probe` integer NOT NULL,
	`message_id` text,
	`sent_at` integer NOT NULL,
	`received_at` integer,
	`auth` text,
	`created_by` text
);
