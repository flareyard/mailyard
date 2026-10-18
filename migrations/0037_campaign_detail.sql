ALTER TABLE `campaign_engagement` ADD `sent` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `campaign_engagement` ADD `bounced` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `paused_by` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `timezone` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `last_test` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `updated_by` text;--> statement-breakpoint
-- Sends and bounces per campaign, from what's already in the log (HAL-3428).
INSERT INTO `campaign_engagement` (`campaign_id`, `sent`, `bounced`)
SELECT `campaign_id`,
  coalesce(sum(`status` IN ('sent', 'delivered', 'deferred', 'bounced', 'complained')), 0),
  coalesce(sum(`status` = 'bounced'), 0)
FROM `messages_out`
WHERE `campaign_id` IS NOT NULL AND `stream` = 'campaign'
GROUP BY `campaign_id`
ON CONFLICT (`campaign_id`) DO UPDATE SET `sent` = excluded.`sent`, `bounced` = excluded.`bounced`;
--> statement-breakpoint
UPDATE `campaigns` SET `paused_by` = CASE
  WHEN `paused_reason` LIKE 'Bounce rate%' THEN 'bounce_rate'
  WHEN `paused_reason` LIKE 'Complaint rate%' THEN 'complaint_rate'
  ELSE 'admin'
END WHERE `status` = 'paused';
--> statement-breakpoint
CREATE TRIGGER `campaign_engagement_sent` AFTER UPDATE OF `status` ON `messages_out`
WHEN NEW.`campaign_id` IS NOT NULL AND NEW.`stream` = 'campaign'
  AND NEW.`status` = 'sent' AND OLD.`status` IN ('queued', 'deferred')
BEGIN
  INSERT INTO `campaign_engagement` (`campaign_id`, `sent`) VALUES (NEW.`campaign_id`, 1)
  ON CONFLICT (`campaign_id`) DO UPDATE SET `sent` = `sent` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `campaign_engagement_bounced` AFTER UPDATE OF `status` ON `messages_out`
WHEN NEW.`campaign_id` IS NOT NULL AND NEW.`stream` = 'campaign'
  AND NEW.`status` = 'bounced' AND OLD.`status` <> 'bounced'
BEGIN
  INSERT INTO `campaign_engagement` (`campaign_id`, `bounced`) VALUES (NEW.`campaign_id`, 1)
  ON CONFLICT (`campaign_id`) DO UPDATE SET `bounced` = `bounced` + 1;
END;
