CREATE TABLE `message_recipients` (
	`message_id` text NOT NULL,
	`recipient` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`smtp_response` text,
	`at` integer NOT NULL,
	PRIMARY KEY(`message_id`, `recipient`)
);
