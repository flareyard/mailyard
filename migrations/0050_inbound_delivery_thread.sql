-- Where each inbound copy was filed, so the contact timeline can open the reply's conversation (HAL-3426). Additive.
ALTER TABLE `inbound_deliveries` ADD `message_id` text;--> statement-breakpoint
ALTER TABLE `inbound_deliveries` ADD `thread_id` text;
