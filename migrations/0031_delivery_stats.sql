CREATE TABLE `deferral_daily` (
	`day` text NOT NULL,
	`provider` text DEFAULT '' NOT NULL,
	`smtp_status` text DEFAULT '' NOT NULL,
	`reason` text NOT NULL,
	`n` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `provider`, `smtp_status`, `reason`)
);
--> statement-breakpoint
CREATE TABLE `delivery_times` (
	`day` text NOT NULL,
	`bucket` integer NOT NULL,
	`n` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `bucket`)
);
--> statement-breakpoint
-- Delivery time per message, bucketed (HAL-3420). Buckets must match DELIVERY_BUCKETS_MS.
CREATE TRIGGER `delivery_times_count` AFTER INSERT ON `message_events`
WHEN NEW.`type` = 'delivered'
  AND EXISTS (SELECT 1 FROM `message_events` s WHERE s.`message_id` = NEW.`message_id` AND s.`type` = 'sent')
BEGIN
  INSERT INTO `delivery_times` (`day`, `bucket`, `n`)
  SELECT date(NEW.`at` / 1000, 'unixepoch'),
    CASE
      WHEN ms < 1000 THEN 0
      WHEN ms < 2000 THEN 1
      WHEN ms < 5000 THEN 2
      WHEN ms < 10000 THEN 3
      WHEN ms < 30000 THEN 4
      WHEN ms < 60000 THEN 5
      WHEN ms < 120000 THEN 6
      WHEN ms < 300000 THEN 7
      WHEN ms < 600000 THEN 8
      WHEN ms < 1800000 THEN 9
      WHEN ms < 3600000 THEN 10
      WHEN ms < 10800000 THEN 11
      WHEN ms < 21600000 THEN 12
      WHEN ms < 86400000 THEN 13
      ELSE 14
    END,
    1
  FROM (
    SELECT max(0, NEW.`at` - max(s.`at`)) AS ms
    FROM `message_events` s
    WHERE s.`message_id` = NEW.`message_id` AND s.`type` = 'sent' AND s.`at` <= NEW.`at`
  )
  WHERE ms IS NOT NULL
  ON CONFLICT (`day`, `bucket`) DO UPDATE SET `n` = `n` + 1;
END;
--> statement-breakpoint
-- Deferral reasons (HAL-3420): the SMTP status is the response's leading code, when it has one.
CREATE TRIGGER `deferral_daily_count` AFTER INSERT ON `message_events`
WHEN NEW.`type` = 'deferred'
BEGIN
  INSERT INTO `deferral_daily` (`day`, `provider`, `smtp_status`, `reason`, `n`)
  SELECT date(NEW.`at` / 1000, 'unixepoch'), COALESCE(NEW.`provider`, ''),
    CASE
      WHEN r GLOB '[245][0-9][0-9][ -]*' THEN substr(r, 1, 3) || CASE
        WHEN substr(r, 5) GLOB '[245].[0-9]*.[0-9]*' THEN ' ' || substr(substr(r, 5), 1, instr(substr(r, 5) || ' ', ' ') - 1)
        ELSE ''
      END
      ELSE ''
    END,
    substr(r, 1, 160),
    1
  FROM (SELECT trim(COALESCE(NEW.`smtp_response`, NEW.`detail`, 'unknown')) AS r)
  WHERE 1
  ON CONFLICT (`day`, `provider`, `smtp_status`, `reason`) DO UPDATE SET `n` = `n` + 1;
END;
