CREATE TABLE `membership` (
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`weight` real DEFAULT 1.5 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`avatar` blob,
	`amount` numeric,
	`email` text UNIQUE,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `membership_pk` PRIMARY KEY(`org_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE `short_link` (
	`id` text PRIMARY KEY,
	`code` text NOT NULL,
	`target_url` text NOT NULL,
	`target_hash` text NOT NULL,
	`org_id` text,
	`created_by` text,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`purpose` text NOT NULL,
	`prospect_id` text,
	`click_count` integer NOT NULL,
	`first_accessed_at` text,
	`last_accessed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `membership_user_role` ON `membership` (`user_id`,`role`);--> statement-breakpoint
CREATE UNIQUE INDEX `short_link_code` ON `short_link` (`code`);--> statement-breakpoint
CREATE INDEX `short_link_org` ON `short_link` (`org_id`);