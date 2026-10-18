CREATE TABLE `hourly_stats` (
	`hour` integer NOT NULL,
	`stream` text NOT NULL,
	`campaign_id` text DEFAULT '' NOT NULL,
	`sent` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`hour`, `stream`, `campaign_id`)
);
--> statement-breakpoint
CREATE INDEX `hourly_stats_campaign` ON `hourly_stats` (`campaign_id`,`hour`);--> statement-breakpoint
-- The last two days, from what was sent: close enough for a 24-hour chart on the day this ships.
INSERT INTO `hourly_stats` (`hour`, `stream`, `campaign_id`, `sent`)
SELECT `created_at` / 3600000,
  CASE `stream` WHEN 'reply' THEN 'mailbox' ELSE `stream` END,
  COALESCE(`campaign_id`, ''),
  count(*)
FROM `messages_out`
WHERE `stream` <> 'test'
  AND `status` IN ('sent', 'delivered', 'deferred', 'bounced', 'complained')
  AND `created_at` >= (CAST(unixepoch('now') AS INTEGER) - 2 * 86400) * 1000
GROUP BY 1, 2, 3;
--> statement-breakpoint
-- Counted once, when a message is first handed to Email Service (HAL-3419).
CREATE TRIGGER `hourly_stats_sent` AFTER UPDATE OF `status` ON `messages_out`
WHEN NEW.`status` = 'sent' AND OLD.`status` IN ('queued', 'deferred') AND NEW.`stream` <> 'test'
BEGIN
  INSERT INTO `hourly_stats` (`hour`, `stream`, `campaign_id`, `sent`)
  VALUES (
    COALESCE(NEW.`updated_at`, CAST(unixepoch('subsec') * 1000 AS INTEGER)) / 3600000,
    CASE NEW.`stream` WHEN 'reply' THEN 'mailbox' ELSE NEW.`stream` END,
    COALESCE(NEW.`campaign_id`, ''),
    1
  )
  ON CONFLICT (`hour`, `stream`, `campaign_id`) DO UPDATE SET `sent` = `sent` + 1;
END;
