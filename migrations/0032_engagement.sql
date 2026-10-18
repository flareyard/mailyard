CREATE TABLE `campaign_engagement` (
	`campaign_id` text PRIMARY KEY NOT NULL,
	`delivered` integer DEFAULT 0 NOT NULL,
	`unique_opens` integer DEFAULT 0 NOT NULL,
	`machine_opens` integer DEFAULT 0 NOT NULL,
	`unique_clicks` integer DEFAULT 0 NOT NULL,
	`unsubscribed` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `engagement_hourly` (
	`day` text NOT NULL,
	`hour` integer NOT NULL,
	`opens` integer DEFAULT 0 NOT NULL,
	`clicks` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `hour`)
);
--> statement-breakpoint
CREATE INDEX `subscription_changes_to` ON `subscription_changes` (`to`,`at`);--> statement-breakpoint
INSERT INTO `campaign_engagement` (`campaign_id`, `delivered`, `unique_opens`, `machine_opens`, `unique_clicks`, `unsubscribed`)
SELECT `campaign_id`,
  coalesce(sum(`status` IN ('delivered', 'complained')), 0),
  coalesce(sum(`first_opened_at` IS NOT NULL), 0),
  coalesce(sum(`machine_opens` > 0), 0),
  coalesce(sum(`first_clicked_at` IS NOT NULL), 0),
  0
FROM `messages_out`
WHERE `campaign_id` IS NOT NULL AND `stream` = 'campaign'
GROUP BY `campaign_id`;
--> statement-breakpoint
UPDATE `campaign_engagement` SET `unsubscribed` = (
  SELECT count(DISTINCT e.`contact_id`) FROM `events` e
  WHERE e.`name` = 'email.unsubscribed' AND json_extract(e.`data`, '$.campaignId') = `campaign_engagement`.`campaign_id`
);
--> statement-breakpoint
INSERT INTO `engagement_hourly` (`day`, `hour`, `opens`, `clicks`)
SELECT `day`, `hour`, sum(`o`), sum(`c`) FROM (
  SELECT date(`first_opened_at` / 1000, 'unixepoch') AS `day`, CAST(strftime('%H', `first_opened_at` / 1000, 'unixepoch') AS INTEGER) AS `hour`, 1 AS `o`, 0 AS `c`
  FROM `messages_out` WHERE `first_opened_at` IS NOT NULL AND `stream` IN ('campaign', 'automation')
  UNION ALL
  SELECT date(`first_clicked_at` / 1000, 'unixepoch'), CAST(strftime('%H', `first_clicked_at` / 1000, 'unixepoch') AS INTEGER), 0, 1
  FROM `messages_out` WHERE `first_clicked_at` IS NOT NULL AND `stream` IN ('campaign', 'automation')
)
GROUP BY `day`, `hour`;
--> statement-breakpoint
-- Engagement as it happens (HAL-3421).
CREATE TRIGGER `campaign_engagement_delivered` AFTER UPDATE OF `status` ON `messages_out`
WHEN NEW.`campaign_id` IS NOT NULL AND NEW.`stream` = 'campaign'
  AND NEW.`status` IN ('delivered', 'complained') AND OLD.`status` NOT IN ('delivered', 'complained')
BEGIN
  INSERT INTO `campaign_engagement` (`campaign_id`, `delivered`) VALUES (NEW.`campaign_id`, 1)
  ON CONFLICT (`campaign_id`) DO UPDATE SET `delivered` = `delivered` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `campaign_engagement_opened` AFTER UPDATE OF `first_opened_at` ON `messages_out`
WHEN OLD.`first_opened_at` IS NULL AND NEW.`first_opened_at` IS NOT NULL
BEGIN
  INSERT INTO `campaign_engagement` (`campaign_id`, `unique_opens`)
  SELECT NEW.`campaign_id`, 1 WHERE NEW.`campaign_id` IS NOT NULL AND NEW.`stream` = 'campaign'
  ON CONFLICT (`campaign_id`) DO UPDATE SET `unique_opens` = `unique_opens` + 1;
  INSERT INTO `engagement_hourly` (`day`, `hour`, `opens`)
  SELECT date(NEW.`first_opened_at` / 1000, 'unixepoch'), CAST(strftime('%H', NEW.`first_opened_at` / 1000, 'unixepoch') AS INTEGER), 1
  WHERE NEW.`stream` IN ('campaign', 'automation')
  ON CONFLICT (`day`, `hour`) DO UPDATE SET `opens` = `opens` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `campaign_engagement_clicked` AFTER UPDATE OF `first_clicked_at` ON `messages_out`
WHEN OLD.`first_clicked_at` IS NULL AND NEW.`first_clicked_at` IS NOT NULL
BEGIN
  INSERT INTO `campaign_engagement` (`campaign_id`, `unique_clicks`)
  SELECT NEW.`campaign_id`, 1 WHERE NEW.`campaign_id` IS NOT NULL AND NEW.`stream` = 'campaign'
  ON CONFLICT (`campaign_id`) DO UPDATE SET `unique_clicks` = `unique_clicks` + 1;
  INSERT INTO `engagement_hourly` (`day`, `hour`, `clicks`)
  SELECT date(NEW.`first_clicked_at` / 1000, 'unixepoch'), CAST(strftime('%H', NEW.`first_clicked_at` / 1000, 'unixepoch') AS INTEGER), 1
  WHERE NEW.`stream` IN ('campaign', 'automation')
  ON CONFLICT (`day`, `hour`) DO UPDATE SET `clicks` = `clicks` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `campaign_engagement_machine` AFTER UPDATE OF `machine_opens` ON `messages_out`
WHEN OLD.`machine_opens` = 0 AND NEW.`machine_opens` > 0 AND NEW.`campaign_id` IS NOT NULL AND NEW.`stream` = 'campaign'
BEGIN
  INSERT INTO `campaign_engagement` (`campaign_id`, `machine_opens`) VALUES (NEW.`campaign_id`, 1)
  ON CONFLICT (`campaign_id`) DO UPDATE SET `machine_opens` = `machine_opens` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `campaign_engagement_unsubscribed` AFTER INSERT ON `events`
WHEN NEW.`name` = 'email.unsubscribed' AND json_extract(NEW.`data`, '$.campaignId') IS NOT NULL
BEGIN
  INSERT INTO `campaign_engagement` (`campaign_id`, `unsubscribed`)
  VALUES (json_extract(NEW.`data`, '$.campaignId'), 1)
  ON CONFLICT (`campaign_id`) DO UPDATE SET `unsubscribed` = `unsubscribed` + 1;
END;
