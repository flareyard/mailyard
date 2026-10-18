CREATE TABLE `contact_fields` (
	`key` text PRIMARY KEY NOT NULL,
	`label` text,
	`type` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `confirmed_at` integer;--> statement-breakpoint
CREATE INDEX `inbound_messages_from` ON `inbound_messages` (`from_address`,`received_at`);--> statement-breakpoint
-- The field registry, from every field contacts already have (HAL-3422).
INSERT INTO `contact_fields` (`key`, `type`, `created_at`)
SELECT j.`key`,
  CASE j.`type`
    WHEN 'integer' THEN 'number'
    WHEN 'real' THEN 'number'
    WHEN 'true' THEN 'boolean'
    WHEN 'false' THEN 'boolean'
    WHEN 'text' THEN CASE WHEN j.`value` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN 'date' ELSE 'string' END
    ELSE 'string'
  END,
  min(c.`created_at`)
FROM `contacts` c, json_each(c.`fields`) j
WHERE c.`fields` IS NOT NULL AND json_valid(c.`fields`)
GROUP BY j.`key`
ON CONFLICT (`key`) DO NOTHING;
--> statement-breakpoint
CREATE TRIGGER `contact_fields_insert` AFTER INSERT ON `contacts`
WHEN NEW.`fields` IS NOT NULL AND json_valid(NEW.`fields`)
BEGIN
  INSERT INTO `contact_fields` (`key`, `type`, `created_at`)
  SELECT j.`key`,
    CASE j.`type`
      WHEN 'integer' THEN 'number'
      WHEN 'real' THEN 'number'
      WHEN 'true' THEN 'boolean'
      WHEN 'false' THEN 'boolean'
      WHEN 'text' THEN CASE WHEN j.`value` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN 'date' ELSE 'string' END
      ELSE 'string'
    END,
    CAST(unixepoch('subsec') * 1000 AS INTEGER)
  FROM json_each(NEW.`fields`) j
  WHERE j.`type` <> 'null'
  ON CONFLICT (`key`) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER `contact_fields_update` AFTER UPDATE OF `fields` ON `contacts`
WHEN NEW.`fields` IS NOT NULL AND json_valid(NEW.`fields`)
BEGIN
  INSERT INTO `contact_fields` (`key`, `type`, `created_at`)
  SELECT j.`key`,
    CASE j.`type`
      WHEN 'integer' THEN 'number'
      WHEN 'real' THEN 'number'
      WHEN 'true' THEN 'boolean'
      WHEN 'false' THEN 'boolean'
      WHEN 'text' THEN CASE WHEN j.`value` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN 'date' ELSE 'string' END
      ELSE 'string'
    END,
    CAST(unixepoch('subsec') * 1000 AS INTEGER)
  FROM json_each(NEW.`fields`) j
  WHERE j.`type` <> 'null'
  ON CONFLICT (`key`) DO NOTHING;
END;
--> statement-breakpoint
-- Consent on record: when each subscription last became subscribed (HAL-3422).
UPDATE `subscriptions` SET `confirmed_at` = coalesce(
  (SELECT max(c.`at`) FROM `subscription_changes` c
   WHERE c.`contact_id` = `subscriptions`.`contact_id` AND c.`topic_id` = `subscriptions`.`topic_id` AND c.`to` = 'subscribed'),
  `changed_at`
) WHERE `state` = 'subscribed';
--> statement-breakpoint
CREATE TRIGGER `subscriptions_confirmed_insert` AFTER INSERT ON `subscriptions`
WHEN NEW.`state` = 'subscribed'
BEGIN
  UPDATE `subscriptions` SET `confirmed_at` = NEW.`changed_at`
  WHERE `contact_id` = NEW.`contact_id` AND `topic_id` = NEW.`topic_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `subscriptions_confirmed_update` AFTER UPDATE OF `state` ON `subscriptions`
WHEN NEW.`state` = 'subscribed' AND OLD.`state` <> 'subscribed'
BEGIN
  UPDATE `subscriptions` SET `confirmed_at` = NEW.`changed_at`
  WHERE `contact_id` = NEW.`contact_id` AND `topic_id` = NEW.`topic_id`;
END;
