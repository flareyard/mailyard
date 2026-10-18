CREATE TABLE `message_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` text NOT NULL,
	`type` text NOT NULL,
	`at` integer NOT NULL,
	`attempt` integer,
	`provider` text,
	`bounce_type` text,
	`smtp_response` text,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `message_events_message` ON `message_events` (`message_id`,`at`);--> statement-breakpoint
ALTER TABLE `messages_out` ADD `next_attempt_at` integer;--> statement-breakpoint
CREATE INDEX `messages_out_stream` ON `messages_out` (`stream`,`created_at`);--> statement-breakpoint
CREATE INDEX `messages_out_template` ON `messages_out` (`template_id`,`created_at`);--> statement-breakpoint
-- The message trail (HAL-3413), kept by the database so every writer of messages_out is covered.
CREATE TRIGGER `message_events_accepted` AFTER INSERT ON `messages_out`
BEGIN
  INSERT INTO `message_events` (`message_id`, `type`, `at`, `attempt`)
  VALUES (NEW.`id`, 'accepted', NEW.`created_at`, 0);
  INSERT INTO `message_events` (`message_id`, `type`, `at`, `attempt`, `detail`)
  SELECT NEW.`id`,
    CASE WHEN NEW.`error` LIKE 'SendSuppressed%' THEN 'suppressed' ELSE NEW.`status` END,
    NEW.`created_at`, NEW.`attempts`, NEW.`error`
  WHERE NEW.`status` <> 'queued';
END;
--> statement-breakpoint
CREATE TRIGGER `message_events_status` AFTER UPDATE OF `status`, `attempts` ON `messages_out`
WHEN NEW.`status` <> OLD.`status` OR NEW.`attempts` <> OLD.`attempts`
BEGIN
  INSERT INTO `message_events` (`message_id`, `type`, `at`, `attempt`, `provider`, `bounce_type`, `smtp_response`, `detail`)
  VALUES (
    NEW.`id`,
    CASE
      WHEN NEW.`status` = 'rejected' AND NEW.`error` LIKE 'SendSuppressed%' THEN 'suppressed'
      WHEN NEW.`status` = 'queued' THEN 'accepted'
      ELSE NEW.`status`
    END,
    COALESCE(NEW.`updated_at`, CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    NEW.`attempts`,
    NEW.`provider`,
    NEW.`bounce_type`,
    NEW.`smtp_response`,
    NEW.`error`
  );
END;
--> statement-breakpoint
CREATE TRIGGER `message_events_opened` AFTER UPDATE OF `first_opened_at` ON `messages_out`
WHEN OLD.`first_opened_at` IS NULL AND NEW.`first_opened_at` IS NOT NULL
BEGIN
  INSERT INTO `message_events` (`message_id`, `type`, `at`) VALUES (NEW.`id`, 'opened', NEW.`first_opened_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `message_events_clicked` AFTER UPDATE OF `first_clicked_at` ON `messages_out`
WHEN OLD.`first_clicked_at` IS NULL AND NEW.`first_clicked_at` IS NOT NULL
BEGIN
  INSERT INTO `message_events` (`message_id`, `type`, `at`) VALUES (NEW.`id`, 'clicked', NEW.`first_clicked_at`);
END;
