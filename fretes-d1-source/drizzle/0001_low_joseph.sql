CREATE TABLE `freight_records` (
	`collection` text NOT NULL,
	`id` text NOT NULL,
	`data` text NOT NULL,
	`owner_id` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`collection`, `id`)
);
