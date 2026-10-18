CREATE TABLE `template_daily` (
	`template_id` text NOT NULL,
	`day` text NOT NULL,
	`api_key_id` text DEFAULT '' NOT NULL,
	`sends` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`template_id`, `day`, `api_key_id`)
);
--> statement-breakpoint
ALTER TABLE `template_versions` ADD `updated_at` integer;--> statement-breakpoint
CREATE INDEX `campaigns_template` ON `campaigns` (`template_id`);--> statement-breakpoint
UPDATE `template_versions` SET `updated_at` = `created_at` WHERE `updated_at` IS NULL;
--> statement-breakpoint
INSERT INTO `template_daily` (`template_id`, `day`, `api_key_id`, `sends`)
SELECT `template_id`, date(`created_at` / 1000, 'unixepoch'), COALESCE(`api_key_id`, ''), count(*)
FROM `messages_out`
WHERE `template_id` IS NOT NULL AND `stream` <> 'test'
GROUP BY 1, 2, 3;
--> statement-breakpoint
-- Every send of a template counts, whoever writes messages_out (HAL-3415).
CREATE TRIGGER `template_daily_count` AFTER INSERT ON `messages_out`
WHEN NEW.`template_id` IS NOT NULL AND NEW.`stream` <> 'test'
BEGIN
  INSERT INTO `template_daily` (`template_id`, `day`, `api_key_id`, `sends`)
  VALUES (NEW.`template_id`, date(NEW.`created_at` / 1000, 'unixepoch'), COALESCE(NEW.`api_key_id`, ''), 1)
  ON CONFLICT (`template_id`, `day`, `api_key_id`) DO UPDATE SET `sends` = `sends` + 1;
END;
