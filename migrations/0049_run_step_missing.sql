-- A send skipped for missing merge data records the fields it needed (HAL-3417). Additive.
ALTER TABLE `automation_run_steps` ADD `missing` text;
