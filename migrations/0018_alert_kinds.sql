ALTER TABLE `alerts` ADD `count` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `alerts` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `domains` ADD `activated_at` integer;--> statement-breakpoint
UPDATE `alerts` SET `kind` = 'campaign_paused' WHERE `kind` = 'campaign.paused';--> statement-breakpoint
UPDATE `alerts` SET `updated_at` = `created_at` WHERE `updated_at` IS NULL;--> statement-breakpoint
UPDATE `domains` SET `activated_at` = `last_checked_at` WHERE `checks` IS NOT NULL AND json_array_length(`checks`) > 0 AND NOT EXISTS (SELECT 1 FROM json_each(`domains`.`checks`) WHERE json_extract(value, '$.status') != 'pass');
